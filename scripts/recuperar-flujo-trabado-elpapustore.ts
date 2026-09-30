/**
 * Recuperación de conversaciones del bot que quedaron "mudas" (flujo trabado) en El Papu Store.
 *
 * Reenvía el paso ACTUAL del flujo (misma lógica que el botón "Reenviar paso" de la inbox:
 * `sendCurrentFlowNode`), sin avanzar el puntero ni tocar `chat_flow_data`. El cliente vuelve a
 * ver la pregunta pendiente y el flujo retoma desde donde estaba, sin repetir todo ni perder
 * contexto.
 *
 * Alcance seguro por defecto:
 *   - conversación en modo bot (flow_status='bot', human_taken_over=false)
 *   - el ÚLTIMO mensaje es una respuesta entrante del cliente (text/interactive/image)
 *   - inactiva hace >= MIN_IDLE_MIN y <= HOURS horas (dentro de la ventana de 24 h de WhatsApp)
 *   - sesión de flujo activa (no completada)
 *   - nodo actual NO es de confirmación/creación de orden ni ticket final (se excluyen para no
 *     arriesgar órdenes duplicadas; esos se revisan aparte)
 *
 * Uso:
 *   npx tsx scripts/recuperar-flujo-trabado-elpapustore.ts            # DRY-RUN (no envía nada)
 *   npx tsx scripts/recuperar-flujo-trabado-elpapustore.ts --apply    # envía de verdad
 *   npx tsx scripts/recuperar-flujo-trabado-elpapustore.ts --apply --max=20 --hours=3
 *
 * Requiere .env.local con SUPABASE_DB_URL y credenciales service-role (igual que los scripts db:*).
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import pg from "pg";
import { getChatServiceClientForEmpresa } from "../src/lib/supabase/chat-service-role-empresa";
import { sendCurrentFlowNode } from "../src/lib/chat/flow-engine-service";
import { isSorteoFinalTicketNode } from "../src/lib/chat/sorteo-final-ticket-node";

const SCHEMA = process.env.RECOVERY_SCHEMA?.trim() || "elpapustore_erp";
const EMPRESA_ID = process.env.RECOVERY_EMPRESA_ID?.trim() || "5ad0bdda-f94f-446c-9032-1fedf34e8479";

const RISKY_NODES = new Set([
  "confirmacion_de_compra",
  "comprobacion_datos",
  "aprobacion_de_compra",
  "compra_realizada",
  "resumen_de_compra",
]);

function argVal(name: string, def: number): number {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  if (!a) return def;
  const n = Number(a.split("=")[1]);
  return Number.isFinite(n) ? n : def;
}

const APPLY = process.argv.includes("--apply");
const HOURS = argVal("hours", 12);
const MIN_IDLE_MIN = argVal("min-idle", 8);
const MAX = argVal("max", 1000);
const DELAY_MS = argVal("delay-ms", 800);

type Candidate = {
  conversation_id: string;
  phone_number: string;
  name: string | null;
  flow_code: string;
  nodo: string;
  active_flow_session_id: string | null;
  min_ago: number;
};

const SELECT_SQL = `
with last_msg as (
  select distinct on (m.conversation_id) m.conversation_id, m.from_me, m.message_type, m.created_at, m.sender_type
  from ${SCHEMA}.chat_messages m order by m.conversation_id, m.created_at desc
)
select c.id conversation_id, ct.phone_number, ct.name, c.flow_code, c.flow_current_node nodo,
  c.active_flow_session_id, round(extract(epoch from (now()-lm.created_at))/60)::int min_ago
from ${SCHEMA}.chat_conversations c
join last_msg lm on lm.conversation_id = c.id
join ${SCHEMA}.chat_contacts ct on ct.id = c.contact_id
left join ${SCHEMA}.chat_flow_sessions s on s.id = c.active_flow_session_id
where c.empresa_id = $1
  and c.flow_status = 'bot' and c.human_taken_over = false
  and lm.from_me = false and lm.sender_type = 'contact'
  and lm.message_type in ('text','interactive','image')
  and lm.created_at <  now() - ($2 || ' minutes')::interval
  and lm.created_at >= now() - ($3 || ' hours')::interval
  and coalesce(s.status, 'active') = 'active'
  and c.flow_code is not null and c.flow_current_node is not null
order by min_ago asc`;

async function main() {
  const dbUrl = process.env.SUPABASE_DB_URL?.trim();
  if (!dbUrl) throw new Error("Falta SUPABASE_DB_URL en .env.local");

  const client = new pg.Client({
    connectionString: dbUrl,
    ssl: dbUrl.includes("supabase") ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();

  let candidates: Candidate[] = [];
  try {
    const r = await client.query(SELECT_SQL, [EMPRESA_ID, String(MIN_IDLE_MIN), String(HOURS)]);
    candidates = (r.rows as Candidate[]).filter(
      (c) => !RISKY_NODES.has(c.nodo) && !isSorteoFinalTicketNode(c.nodo)
    );
  } finally {
    await client.end();
  }

  console.log(
    `[recuperar] modo=${APPLY ? "APPLY" : "DRY-RUN"} schema=${SCHEMA} empresa=${EMPRESA_ID}`
  );
  console.log(
    `[recuperar] ventana=${HOURS}h idle>=${MIN_IDLE_MIN}min candidatas=${candidates.length} max=${MAX}`
  );
  const byNode: Record<string, number> = {};
  for (const c of candidates) byNode[c.nodo] = (byNode[c.nodo] || 0) + 1;
  console.log("[recuperar] por nodo:", JSON.stringify(byNode));

  if (!APPLY) {
    for (const c of candidates.slice(0, MAX)) {
      console.log(
        `  DRY  ${c.conversation_id}  ${c.phone_number}  ${c.nodo}  (${c.min_ago}min)  ${c.name ?? ""}`
      );
    }
    console.log(`\n[recuperar] DRY-RUN: no se envió nada. Agregá --apply para reenviar el paso actual.`);
    return;
  }

  const supabase = await getChatServiceClientForEmpresa(EMPRESA_ID);
  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const c of candidates.slice(0, MAX)) {
    // Re-validación en vivo justo antes de enviar (el cliente pudo avanzar solo mientras corría).
    const { data: fresh } = await supabase
      .from("chat_conversations")
      .select("flow_status, human_taken_over, flow_current_node, active_flow_session_id")
      .eq("id", c.conversation_id)
      .eq("empresa_id", EMPRESA_ID)
      .maybeSingle();
    const f = fresh as
      | {
          flow_status?: string;
          human_taken_over?: boolean;
          flow_current_node?: string | null;
          active_flow_session_id?: string | null;
        }
      | null;
    if (
      !f ||
      f.flow_status !== "bot" ||
      f.human_taken_over ||
      !f.flow_current_node ||
      RISKY_NODES.has(f.flow_current_node) ||
      isSorteoFinalTicketNode(f.flow_current_node)
    ) {
      skipped++;
      console.log(`  SKIP ${c.conversation_id} (cambió de estado: nodo=${f?.flow_current_node ?? "-"})`);
      continue;
    }

    try {
      const res = await sendCurrentFlowNode(supabase, { conversationId: c.conversation_id });
      if (res.ok) {
        sent++;
        console.log(`  OK   ${c.conversation_id}  ${c.phone_number}  ${res.nodeCode ?? c.nodo}`);
        await supabase.from("chat_flow_events").insert({
          empresa_id: EMPRESA_ID,
          conversation_id: c.conversation_id,
          flow_code: c.flow_code,
          node_code: res.nodeCode ?? c.nodo,
          flow_session_id: f.active_flow_session_id ?? c.active_flow_session_id ?? null,
          event_type: "manual_current_node_resent",
          payload: { source: "script_recuperar_flujo_trabado", at: new Date().toISOString() },
        });
      } else {
        failed++;
        console.log(`  FAIL ${c.conversation_id}  ${c.phone_number}  ${res.error ?? "send_failed"}`);
      }
    } catch (e) {
      failed++;
      console.log(`  ERR  ${c.conversation_id}  ${e instanceof Error ? e.message : String(e)}`);
    }

    await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  console.log(`\n[recuperar] listo. enviados=${sent} omitidos=${skipped} fallidos=${failed}`);
}

main().catch((e) => {
  console.error("[recuperar] ERROR", e instanceof Error ? e.message : e);
  process.exit(1);
});
