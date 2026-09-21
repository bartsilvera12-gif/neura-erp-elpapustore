/**
 * Auditoría de datos impresos en la boleta de una orden de sorteo.
 *
 * Compara, para un `numero_orden`, TODAS las fuentes que alimentan el PNG:
 *   1. `sorteo_entradas` (whatsapp_numero, nombre_participante, documento) — la que gana
 *   2. `chat_flow_data` de la conversación (lo que la persona tipeó/confirmó en el bot)
 *   3. `sorteo_ticket_deliveries.payload_snapshot` (lo que se imprimió realmente)
 *   4. `clientes` (lo que quedó en el CRM para esa persona)
 *
 * Uso:
 *   npx tsx scripts/auditar-orden-telefono.ts [numero_orden] [schema] [empresa_uuid]
 * Env alternativas: AUDIT_NUMERO_ORDEN, AUDIT_SCHEMA, AUDIT_EMPRESA_ID
 */
import { config } from "dotenv";
import pg from "pg";
import { join } from "path";

config({ path: join(process.cwd(), ".env.local"), quiet: true });

const NUMERO_ORDEN = Number(process.argv[2] ?? process.env.AUDIT_NUMERO_ORDEN ?? NaN);
const SCHEMA = process.argv[3] ?? process.env.AUDIT_SCHEMA ?? "erp_el_papu_store_5ad0bdda";
const EMPRESA =
  process.argv[4] ?? process.env.AUDIT_EMPRESA_ID ?? "5ad0bdda-f94f-446c-9032-1fedf34e8479";

/** Mismas variantes que `paraguayPhoneMatchVariants` (local / nacional / internacional). */
function phoneVariants(raw: string): string[] {
  const digits = (raw ?? "").replace(/\D/g, "");
  let nat = digits;
  if (nat.startsWith("595")) nat = nat.slice(3);
  nat = nat.replace(/^0+/, "");
  if (!nat) return [];
  return [...new Set([digits, nat, `0${nat}`, `595${nat}`].filter(Boolean))];
}

const PHONE_FIELD_HINT = /(telefono|teléfono|celular|whatsapp|phone|contacto)/i;
const IDENTITY_FIELD_HINT =
  /(nombre|apellido|cedula|cédula|documento|^ci$|dni|ruc|ciudad|localidad|ubicacion|recall_)/i;

async function main() {
  const url =
    process.env.SUPABASE_DB_URL?.trim() ||
    process.env.DIRECT_URL?.trim() ||
    process.env.DATABASE_URL?.trim();
  if (!url) {
    console.error("Falta SUPABASE_DB_URL / DIRECT_URL / DATABASE_URL");
    process.exit(2);
  }
  if (!Number.isFinite(NUMERO_ORDEN) || NUMERO_ORDEN <= 0) {
    console.error("Falta numero_orden (arg 1 o AUDIT_NUMERO_ORDEN)");
    process.exit(2);
  }

  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    const entR = await pool.query(
      `SELECT e.id, e.numero_orden, e.sorteo_id, e.cantidad_boletos, e.nombre_participante,
              e.documento, e.whatsapp_numero, e.chat_conversation_id, e.flow_code,
              e.venta_origen, e.created_at, s.nombre AS sorteo_nombre
         FROM "${SCHEMA}".sorteo_entradas e
         LEFT JOIN "${SCHEMA}".sorteos s ON s.id = e.sorteo_id
        WHERE e.empresa_id = $1::uuid AND e.numero_orden = $2::int
        ORDER BY e.created_at DESC`,
      [EMPRESA, NUMERO_ORDEN]
    );
    if (!entR.rows.length) {
      console.log(JSON.stringify({ error: "orden_no_encontrada", numero_orden: NUMERO_ORDEN }, null, 2));
      return;
    }

    for (const ent of entR.rows as Record<string, unknown>[]) {
      const entradaId = String(ent.id);
      const convId = ent.chat_conversation_id ? String(ent.chat_conversation_id) : "";

      const contactoR = convId
        ? await pool.query(
            `SELECT c.phone_number, c.name AS contact_name, conv.flow_code
               FROM "${SCHEMA}".chat_conversations conv
               JOIN "${SCHEMA}".chat_contacts c ON c.id = conv.contact_id
              WHERE conv.id = $1::uuid`,
            [convId]
          )
        : { rows: [] };

      /** Newest-per-field, igual que `loadChatFlowDataNewestPerField` del render del ticket. */
      const fdR = convId
        ? await pool.query(
            `SELECT DISTINCT ON (field_name)
                    field_name, left(field_value, 200) AS field_value, flow_session_id, updated_at
               FROM "${SCHEMA}".chat_flow_data
              WHERE conversation_id = $1::uuid
              ORDER BY field_name, updated_at DESC`,
            [convId]
          )
        : { rows: [] };
      const flowRows = fdR.rows as Record<string, unknown>[];

      const delR = await pool.query(
        `SELECT id, status, template_revision, is_current, payload_snapshot, created_at
           FROM "${SCHEMA}".sorteo_ticket_deliveries
          WHERE empresa_id = $1::uuid AND entrada_id = $2::uuid
          ORDER BY template_revision DESC`,
        [EMPRESA, entradaId]
      );

      const variants = phoneVariants(String(ent.whatsapp_numero ?? ""));
      const flowPhones = flowRows
        .filter((r) => PHONE_FIELD_HINT.test(String(r.field_name)))
        .map((r) => ({ campo: String(r.field_name), valor: String(r.field_value ?? "") }));
      for (const p of flowPhones) variants.push(...phoneVariants(p.valor));

      const cliR = await pool.query(
        `SELECT id, nombre, nombre_contacto, documento, ciudad, telefono, origen, created_at
           FROM "${SCHEMA}".clientes
          WHERE empresa_id = $1::uuid AND deleted_at IS NULL
            AND (telefono = ANY($2::text[]) OR ($3 <> '' AND documento = $3))
          ORDER BY created_at DESC`,
        [EMPRESA, [...new Set(variants)], String(ent.documento ?? "").trim()]
      );

      /** Un teléfono tipeado en el flujo que no coincide con el de la boleta es el síntoma del caso. */
      const telBoleta = String(ent.whatsapp_numero ?? "");
      const discrepancias = flowPhones
        .filter((p) => p.valor.trim())
        .filter((p) => {
          const a = phoneVariants(p.valor);
          const b = phoneVariants(telBoleta);
          return !a.some((x) => b.includes(x));
        });

      console.log(
        JSON.stringify(
          {
            orden: {
              numero_orden: ent.numero_orden,
              entrada_id: entradaId,
              sorteo: ent.sorteo_nombre,
              venta_origen: ent.venta_origen,
              creado: ent.created_at,
            },
            impreso_en_boleta: {
              nombre_participante: ent.nombre_participante,
              documento: ent.documento,
              telefono: telBoleta,
              fuente_telefono: "sorteo_entradas.whatsapp_numero",
            },
            whatsapp_de_la_conversacion: (contactoR.rows[0] as Record<string, unknown> | undefined) ?? null,
            capturado_en_el_bot: flowRows
              .filter(
                (r) =>
                  PHONE_FIELD_HINT.test(String(r.field_name)) ||
                  IDENTITY_FIELD_HINT.test(String(r.field_name))
              )
              .map((r) => ({
                campo: r.field_name,
                valor: r.field_value,
                sesion: r.flow_session_id,
                actualizado: r.updated_at,
              })),
            sesiones_distintas_en_la_conversacion: [
              ...new Set(flowRows.map((r) => String(r.flow_session_id ?? ""))),
            ].filter(Boolean).length,
            entregas_del_ticket: (delR.rows as Record<string, unknown>[]).map((d) => ({
              id: d.id,
              status: d.status,
              revision: d.template_revision,
              is_current: d.is_current,
              payload: d.payload_snapshot,
            })),
            clientes_crm: cliR.rows,
            discrepancias_telefono: discrepancias,
            veredicto: discrepancias.length
              ? "El teléfono impreso NO es el que la persona cargó en el flujo"
              : "El teléfono impreso coincide con lo capturado (o el flujo no captura teléfono)",
          },
          null,
          2
        )
      );
    }
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
