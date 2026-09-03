/**
 * Instala el paso de recompra rápida al INICIO de un flujo de sorteo.
 *
 * Crea (o actualiza) un nodo `identity_recall` con los dos botones —"Sí, confirmar" y
 * "No, ingresar nuevo"— y lo encadena al que hoy es el primer paso del flujo.
 *
 * Idempotente: se puede correr varias veces. No borra nodos ni reordena los existentes; el nodo
 * nuevo entra con `sort_order` menor al mínimo actual, que es el criterio con el que
 * `resolve-whatsapp-active-flow` elige el primer paso.
 *
 * Uso:
 *   SCHEMA=elpapustore_erp FLOW_CODE=Papu_store npx tsx scripts/apply-sorteo-identity-recall-node.ts
 *   # agregar APPLY=1 para escribir; sin eso es dry-run
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import pg from "pg";

import {
  IDENTITY_RECALL_DEFAULT_MESSAGE,
  IDENTITY_RECALL_NODE_TYPE,
} from "../src/lib/sorteos/sorteo-identity-recall";

const { Client } = pg;

const NODE_CODE = "datos_registrados";

const OPTIONS = [
  {
    label: "✅ Sí, confirmar",
    option_value: "usar_registrados",
    meta_button_id: "datos_reg_si",
    option_payload: { usar_datos_registrados: true },
    sort_order: 1,
  },
  {
    label: "❌ No, ingresar nuevo",
    option_value: "cargar_nuevos",
    meta_button_id: "datos_reg_no",
    option_payload: { cargar_datos_nuevos: true },
    sort_order: 2,
  },
] as const;

function requiredEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Falta ${name} en el entorno`);
  return v;
}

function quoteIdent(schema: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(schema)) throw new Error(`schema inválido: ${schema}`);
  return `"${schema}"`;
}

function getDbUrl(): string {
  const url = process.env.SUPABASE_DB_URL?.trim() || process.env.DIRECT_URL?.trim();
  if (!url) throw new Error("Falta SUPABASE_DB_URL o DIRECT_URL");
  return url;
}

async function main() {
  const schema = requiredEnv("SCHEMA");
  const flowCode = requiredEnv("FLOW_CODE");
  const apply = process.env.APPLY === "1";
  const qs = quoteIdent(schema);

  const client = new Client({ connectionString: getDbUrl(), ssl: { rejectUnauthorized: false } });
  await client.connect();

  try {
    await client.query("BEGIN");

    /** Nodos activos del flujo, en el mismo orden que usa el motor para elegir el primero. */
    const nodes = await client.query<{
      id: string;
      empresa_id: string;
      node_code: string;
      node_type: string;
      sort_order: number;
    }>(
      `SELECT id, empresa_id, node_code, node_type, sort_order
         FROM ${qs}.chat_flow_nodes
        WHERE flow_code = $1 AND is_active = true
        ORDER BY sort_order ASC, created_at ASC`,
      [flowCode]
    );

    if (nodes.rows.length === 0) {
      throw new Error(`El flujo "${flowCode}" no tiene nodos activos en ${schema}`);
    }

    const empresaId = nodes.rows[0]!.empresa_id;
    const existing = nodes.rows.find((n) => n.node_code === NODE_CODE);
    /** Primer paso real del flujo, ignorando el nodo de recall si ya está instalado. */
    const firstReal = nodes.rows.find((n) => n.node_code !== NODE_CODE);
    if (!firstReal) throw new Error("El flujo solo tiene el nodo de recompra; falta el resto");

    const minSort = Math.min(...nodes.rows.map((n) => n.sort_order));
    const recallSort = existing ? existing.sort_order : minSort - 1;

    console.log("[recall] flujo:", flowCode, "| schema:", schema, "| empresa:", empresaId);
    console.log("[recall] primer paso actual:", firstReal.node_code, `(sort ${firstReal.sort_order})`);
    console.log(
      existing
        ? `[recall] el nodo "${NODE_CODE}" ya existe (sort ${existing.sort_order}) → se actualiza`
        : `[recall] se crea el nodo "${NODE_CODE}" con sort ${recallSort}`
    );
    console.log("[recall] ambos botones continúan a:", firstReal.node_code);

    if (!apply) {
      console.log("\n[recall] DRY-RUN. Nada se escribió. Repetí con APPLY=1 para aplicar.");
      await client.query("ROLLBACK");
      return;
    }

    const upNode = await client.query<{ id: string }>(
      `INSERT INTO ${qs}.chat_flow_nodes
         (empresa_id, flow_code, node_code, node_type, message_text,
          save_as_field, next_node_code, sort_order, is_active)
       VALUES ($1, $2, $3, $4, $5, NULL, $6, $7, true)
       ON CONFLICT (empresa_id, flow_code, node_code) DO UPDATE
         SET node_type = EXCLUDED.node_type,
             message_text = COALESCE(NULLIF(${qs}.chat_flow_nodes.message_text, ''), EXCLUDED.message_text),
             next_node_code = EXCLUDED.next_node_code,
             is_active = true
       RETURNING id`,
      [
        empresaId,
        flowCode,
        NODE_CODE,
        IDENTITY_RECALL_NODE_TYPE,
        IDENTITY_RECALL_DEFAULT_MESSAGE,
        firstReal.node_code,
        recallSort,
      ]
    );

    const nodeId = upNode.rows[0]?.id;
    if (!nodeId) throw new Error("No se pudo obtener el id del nodo de recompra");

    for (const opt of OPTIONS) {
      await client.query(
        `INSERT INTO ${qs}.chat_flow_options
           (node_id, label, option_value, meta_button_id, next_node_code, sort_order, option_payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (node_id, meta_button_id) DO UPDATE
           SET label = EXCLUDED.label,
               option_value = EXCLUDED.option_value,
               next_node_code = EXCLUDED.next_node_code,
               sort_order = EXCLUDED.sort_order,
               option_payload = EXCLUDED.option_payload`,
        [
          nodeId,
          opt.label,
          opt.option_value,
          opt.meta_button_id,
          firstReal.node_code,
          opt.sort_order,
          JSON.stringify(opt.option_payload),
        ]
      );
    }

    await client.query("COMMIT");
    console.log("\n[recall] listo. Nodo y botones instalados.");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
