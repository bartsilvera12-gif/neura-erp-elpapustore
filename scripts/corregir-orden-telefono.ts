/**
 * Corrige los datos impresos de UNA orden de sorteo ya creada.
 *
 * Caso 6434: la persona declaró 0973592372 en el bot y la boleta salió con el número de
 * WhatsApp desde el que escribió. El código nuevo ya guarda el declarado en
 * `sorteo_entradas.telefono_contacto`, pero las órdenes anteriores quedaron sin ese dato:
 * este script lo completa (y opcionalmente corrige el nombre) para que al regenerar el PNG
 * salga lo que la persona confirmó.
 *
 * Por defecto NO escribe nada: muestra qué haría. Recién con `--apply` toca la base.
 * Nunca envía WhatsApp: el PNG se regenera desde el panel y lo manda una persona.
 *
 * Uso:
 *   npx tsx scripts/corregir-orden-telefono.ts 6434 elpapustore_erp <empresa_uuid>
 *   npx tsx scripts/corregir-orden-telefono.ts 6434 elpapustore_erp <empresa_uuid> --apply
 *
 * Opciones:
 *   --telefono=0973592372   fuerza el número (si el flujo no lo capturó o quedó mal)
 *   --nombre="Juan Pérez"   corrige además nombre_participante
 *   --apply                 ejecuta los UPDATE (sin esto es simulación)
 */
import { config } from "dotenv";
import pg from "pg";
import { join } from "path";

config({ path: join(process.cwd(), ".env.local"), quiet: true });

const posicionales = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const flags = process.argv.slice(2).filter((a) => a.startsWith("--"));

function flagValue(name: string): string {
  const hit = flags.find((f) => f.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3).replace(/^["']|["']$/g, "").trim() : "";
}

const NUMERO_ORDEN = Number(posicionales[0] ?? process.env.FIX_NUMERO_ORDEN ?? NaN);
const SCHEMA = posicionales[1] ?? process.env.FIX_SCHEMA ?? "elpapustore_erp";
const EMPRESA = posicionales[2] ?? process.env.FIX_EMPRESA_ID ?? "";
const TEL_FORZADO = flagValue("telefono");
const NOMBRE_NUEVO = flagValue("nombre");
const APPLY = flags.includes("--apply");

/** Mismos alias que `TELEFONO_CONTACTO_FLOW_KEYS` en src/lib/sorteos/sorteo-telefono-contacto.ts */
const ALIAS_TELEFONO = [
  "telefono_contacto", "telefono", "teléfono", "telefono_celular", "numero_telefono",
  "nro_telefono", "celular", "numero_celular", "número_celular", "nro_celular",
  "num_celular", "movil", "móvil", "numero_contacto", "número_contacto",
  "whatsapp", "numero_whatsapp", "phone", "mobile",
];

/** Igual que `normalizeTelefonoContactoDisplay`: se respeta lo tipeado, sin reformatear. */
function telefonoValido(raw: string): string {
  const t = (raw ?? "").trim().replace(/\s+/g, " ");
  if (!t) return "";
  if (t.replace(/\D/g, "").length < 6) return "";
  if (/[a-zA-ZáéíóúÁÉÍÓÚñÑ]/.test(t)) return "";
  return t;
}

function mismoNumero(a: string, b: string): boolean {
  const nat = (x: string) => {
    let d = (x ?? "").replace(/\D/g, "");
    if (d.startsWith("595")) d = d.slice(3);
    return d.replace(/^0+/, "");
  };
  return Boolean(nat(a)) && nat(a) === nat(b);
}

async function main() {
  const url =
    process.env.SUPABASE_DB_URL?.trim() ||
    process.env.DIRECT_URL?.trim() ||
    process.env.DATABASE_URL?.trim();
  if (!url) throw new Error("Falta SUPABASE_DB_URL / DIRECT_URL / DATABASE_URL");
  if (!Number.isFinite(NUMERO_ORDEN) || NUMERO_ORDEN <= 0) throw new Error("Falta numero_orden");
  if (!EMPRESA) throw new Error("Falta empresa_id (3er argumento)");
  if (!/^[a-z_][a-z0-9_]*$/i.test(SCHEMA)) throw new Error("schema inválido");

  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    const cols = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'sorteo_entradas'`,
      [SCHEMA]
    );
    const colNames = new Set(cols.rows.map((c) => c.column_name));
    if (!colNames.has("telefono_contacto")) {
      throw new Error(
        `El schema ${SCHEMA} no tiene sorteo_entradas.telefono_contacto: falta correr la migración 20260921120000.`
      );
    }

    const entR = await pool.query(
      `SELECT e.id, e.numero_orden, e.cliente_id, e.nombre_participante, e.documento,
              e.whatsapp_numero, e.telefono_contacto, e.chat_conversation_id, e.created_at
         FROM "${SCHEMA}".sorteo_entradas e
        WHERE e.empresa_id = $1::uuid AND e.numero_orden = $2::int`,
      [EMPRESA, NUMERO_ORDEN]
    );
    if (entR.rows.length === 0) throw new Error(`No existe la orden ${NUMERO_ORDEN}`);
    if (entR.rows.length > 1) {
      throw new Error(
        `Hay ${entR.rows.length} entradas con numero_orden ${NUMERO_ORDEN}: revisar a mano antes de tocar nada.`
      );
    }
    const ent = entR.rows[0] as Record<string, string>;
    const entradaId = String(ent.id);
    const convId = ent.chat_conversation_id ? String(ent.chat_conversation_id) : "";

    /** Lo que la persona cargó en el bot (newest-per-field, igual que el render del ticket). */
    const fdR = convId
      ? await pool.query(
          `SELECT DISTINCT ON (field_name) field_name, field_value
             FROM "${SCHEMA}".chat_flow_data
            WHERE conversation_id = $1::uuid
            ORDER BY field_name, updated_at DESC`,
          [convId]
        )
      : { rows: [] as { field_name: string; field_value: string }[] };
    const flow = new Map(
      (fdR.rows as { field_name: string; field_value: string }[]).map((r) => [
        String(r.field_name).trim().toLowerCase(),
        String(r.field_value ?? "").trim(),
      ])
    );

    let telDelFlujo = "";
    let aliasUsado = "";
    for (const k of ALIAS_TELEFONO) {
      const v = telefonoValido(flow.get(k) ?? "");
      if (v) {
        telDelFlujo = v;
        aliasUsado = k;
        break;
      }
    }

    const telFinal = telefonoValido(TEL_FORZADO) || telDelFlujo;
    if (!telFinal) {
      console.log(
        JSON.stringify(
          {
            orden: NUMERO_ORDEN,
            entrada_id: entradaId,
            problema: "no_hay_telefono_declarado",
            detalle:
              "El flujo de esta conversación no tiene ningún campo con un teléfono válido. Pasá el número a mano con --telefono=0973592372",
            campos_del_flujo: Object.fromEntries(flow),
          },
          null,
          2
        )
      );
      return;
    }

    const yaCorrecto =
      mismoNumero(String(ent.telefono_contacto ?? ""), telFinal) &&
      (!NOMBRE_NUEVO || NOMBRE_NUEVO === String(ent.nombre_participante ?? "").trim());

    console.log(
      JSON.stringify(
        {
          orden: NUMERO_ORDEN,
          entrada_id: entradaId,
          antes: {
            nombre_participante: ent.nombre_participante,
            telefono_impreso: String(ent.telefono_contacto ?? "") || String(ent.whatsapp_numero ?? ""),
            telefono_contacto: ent.telefono_contacto ?? null,
            whatsapp_numero: ent.whatsapp_numero,
          },
          declarado_en_el_bot: telDelFlujo
            ? { valor: telDelFlujo, campo: aliasUsado }
            : "el flujo no capturó teléfono",
          despues: {
            nombre_participante: NOMBRE_NUEVO || ent.nombre_participante,
            telefono_contacto: telFinal,
            origen: telefonoValido(TEL_FORZADO) ? "--telefono (manual)" : "chat_flow_data",
          },
          modo: APPLY ? "APLICANDO" : "SIMULACION (agregá --apply para escribir)",
        },
        null,
        2
      )
    );

    if (yaCorrecto) {
      console.log("\nLa orden ya tiene esos datos: no hay nada que corregir.");
      return;
    }
    if (!APPLY) {
      console.log("\nNada se escribió. Volvé a correr con --apply si los datos de 'despues' son correctos.");
      return;
    }

    await pool.query("BEGIN");
    try {
      const sets = ["telefono_contacto = $1"];
      const vals: unknown[] = [telFinal];
      if (NOMBRE_NUEVO) {
        sets.push(`nombre_participante = $${vals.length + 1}`);
        vals.push(NOMBRE_NUEVO);
      }
      vals.push(entradaId, EMPRESA);
      await pool.query(
        `UPDATE "${SCHEMA}".sorteo_entradas SET ${sets.join(", ")}
          WHERE id = $${vals.length - 1}::uuid AND empresa_id = $${vals.length}::uuid`,
        vals
      );

      /** El CRM queda alineado: `telefono` sigue siendo el WhatsApp (clave de la recompra). */
      if (ent.cliente_id) {
        const cliCols = await pool.query<{ column_name: string }>(
          `SELECT column_name FROM information_schema.columns
            WHERE table_schema = $1 AND table_name = 'clientes'`,
          [SCHEMA]
        );
        if (cliCols.rows.some((c) => c.column_name === "telefono_secundario")) {
          await pool.query(
            `UPDATE "${SCHEMA}".clientes
                SET telefono_secundario = $1
              WHERE id = $2::uuid AND empresa_id = $3::uuid`,
            [telFinal, ent.cliente_id, EMPRESA]
          );
        }
        if (NOMBRE_NUEVO) {
          await pool.query(
            `UPDATE "${SCHEMA}".clientes
                SET nombre = $1, nombre_contacto = $1
              WHERE id = $2::uuid AND empresa_id = $3::uuid`,
            [NOMBRE_NUEVO, ent.cliente_id, EMPRESA]
          );
        }
      }
      await pool.query("COMMIT");
    } catch (e) {
      await pool.query("ROLLBACK");
      throw e;
    }

    const delR = await pool.query(
      `SELECT id, status, template_revision, is_current
         FROM "${SCHEMA}".sorteo_ticket_deliveries
        WHERE empresa_id = $1::uuid AND entrada_id = $2::uuid
        ORDER BY template_revision DESC`,
      [EMPRESA, entradaId]
    );

    console.log("\nOrden corregida.");
    console.log(
      JSON.stringify(
        {
          entrada_id: entradaId,
          tickets_de_esta_orden: delR.rows,
          siguiente_paso:
            "Panel → Sorteos → Tickets → buscar la orden → 'Regenerar' (crea una revisión nueva del PNG, no reenvía) → 'Ver' para descargar la imagen y mandarla por WhatsApp.",
        },
        null,
        2
      )
    );
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
