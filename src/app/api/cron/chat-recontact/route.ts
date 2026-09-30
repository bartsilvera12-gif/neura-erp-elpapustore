import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getChatServiceClientForEmpresa } from "@/app/api/chat/_chat-service-client";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { getChatPostgresPool, quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";
import { sendCurrentFlowNode } from "@/lib/chat/flow-engine-service";
import { isSorteoFinalTicketNode } from "@/lib/chat/sorteo-final-ticket-node";
import { isSingleClientMode } from "@/lib/instance/single-client";

/**
 * Watchdog de recontacto (ejecutor de `chat_flow_recontact_rules`).
 *
 * Contexto: las reglas de recontacto tenían CRUD + simulación (dry-run) + panel, pero NADA las
 * disparaba — ninguna conversación que quedaba muda se recuperaba sola. Este cron cierra ese hueco:
 * por cada regla ACTIVA busca las conversaciones elegibles (inactividad dentro de una banda, nodo
 * incluido, sin humano, sin cerrar, sesión activa, cooldown y máximo de intentos respetados) y les
 * REENVÍA el paso actual del flujo (`sendCurrentFlowNode`, igual que el botón "Reenviar paso").
 * No avanza punteros ni toca `chat_flow_data`.
 *
 * A diferencia del dry-run (que escanea las 200 conversaciones más recientes, pensado para preview
 * de UI), acá se selecciona directamente la BANDA de inactividad [idle_after, max_idle] con SQL —
 * si no, en horario pico una conversación que se queda muda sale del top-200 antes de cumplir el
 * tiempo de inactividad y el watchdog nunca la vería (justo el caso que hay que atrapar).
 *
 * Seguridad y disparo:
 *  - Requiere `Authorization: Bearer <CRON_SECRET>` (igual que `chat-tags-daily`). Sin secret → 401.
 *  - `?apply=true` envía; sin él es un dry-run (cuenta candidatos sin enviar).
 *  - Se agenda como Coolify Scheduled Task (curl a localhost), p. ej. cada 10 min en horario útil.
 *
 * Cada envío queda auditado en `chat_flow_recontact_runs` (decision='sent'|'failed'), lo que a su
 * vez alimenta el cooldown y el máximo de intentos.
 */

export const dynamic = "force-dynamic";

const HARD_CAP_SEND = 200;
const DEFAULT_MAX_SEND = 50;
const DEFAULT_MAX_IDLE_MIN = 23 * 60; // dentro de la ventana de 24 h de WhatsApp para texto de sesión
const SEND_DELAY_MS = 700;
const CANDIDATE_FETCH_MULTIPLIER = 3; // trae de más para cubrir los que cambian de estado en vivo

/** Nodos de confirmación / creación de orden: nunca se reenvían automáticamente (riesgo de duplicar). */
const RISKY_NODES = [
  "confirmacion_de_compra",
  "comprobacion_datos",
  "aprobacion_de_compra",
  "compra_realizada",
  "resumen_de_compra",
];
const RISKY_NODES_SET = new Set(RISKY_NODES);

type RuleRow = {
  id: string;
  empresa_id: string;
  flow_code: string;
  nombre: string | null;
  activo: boolean;
  prioridad: number;
  included_node_codes: unknown;
  excluded_node_codes: unknown;
  idle_after_seconds: number;
  max_attempts: number;
  cooldown_seconds: number;
  schedule_config: unknown;
  guard_config: unknown;
  message_config: unknown;
};

type Candidate = {
  conversation_id: string;
  flow_current_node: string | null;
  active_flow_session_id: string | null;
  idle_min: number;
};

function isAuthorized(request: NextRequest): boolean {
  const expected = process.env.CRON_SECRET?.trim();
  if (!expected) return false;
  const auth = request.headers.get("authorization") ?? "";
  return auth === `Bearer ${expected}`;
}

function parseBool(v: string | null, fallback: boolean): boolean {
  if (v == null) return fallback;
  const s = v.trim().toLowerCase();
  if (s === "true" || s === "1" || s === "yes") return true;
  if (s === "false" || s === "0" || s === "no") return false;
  return fallback;
}

function parseIntCap(v: string | null, fallback: number, max: number): number {
  if (!v) return fallback;
  const n = parseInt(v, 10);
  if (Number.isNaN(n) || n < 0) return fallback;
  return Math.min(n, max);
}

function toStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of raw) {
    const s = typeof x === "string" ? x.trim() : String(x ?? "").trim();
    if (s && !seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

function purchaseGuardEnabled(guard_config: unknown): boolean {
  if (!guard_config || typeof guard_config !== "object" || Array.isArray(guard_config)) return false;
  return (guard_config as { purchase_condition?: unknown }).purchase_condition === "no_confirmed_sorteo_order";
}

function resolveEnabledEmpresas(): string[] {
  const fromEnv = process.env.WHATSAPP_DEFAULT_EMPRESA_ID?.trim();
  if (fromEnv) return [fromEnv];
  // Fallback: El Papu Store (mismo empresa_id que usa chat-tags-daily).
  return ["5ad0bdda-f94f-446c-9032-1fedf34e8479"];
}

/**
 * ¿La regla permite enviar en este momento? Respeta `schedule_config`
 * (window_start/window_end HH:MM, timezone IANA, active_weekdays 0=domingo..6=sábado).
 * Config vacía → siempre permitido.
 */
function isWithinSchedule(schedule_config: unknown, now: Date): boolean {
  if (!schedule_config || typeof schedule_config !== "object" || Array.isArray(schedule_config)) {
    return true;
  }
  const o = schedule_config as {
    window_start?: string | null;
    window_end?: string | null;
    timezone?: string | null;
    active_weekdays?: number[] | null;
  };
  const tz = typeof o.timezone === "string" && o.timezone.trim() ? o.timezone.trim() : "America/Asuncion";

  let hh = now.getUTCHours();
  let mm = now.getUTCMinutes();
  let weekday = now.getUTCDay();
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hour12: false,
    });
    const parts = fmt.formatToParts(now);
    const h = parts.find((p) => p.type === "hour")?.value;
    const m = parts.find((p) => p.type === "minute")?.value;
    const wd = parts.find((p) => p.type === "weekday")?.value;
    if (h != null) hh = parseInt(h, 10) % 24;
    if (m != null) mm = parseInt(m, 10);
    const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    if (wd && map[wd] !== undefined) weekday = map[wd];
  } catch {
    /* tz inválida → se usan valores UTC ya calculados */
  }

  if (Array.isArray(o.active_weekdays) && o.active_weekdays.length > 0) {
    if (!o.active_weekdays.includes(weekday)) return false;
  }

  const parseHM = (s: string | null | undefined): number | null => {
    if (typeof s !== "string") return null;
    const mt = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
    if (!mt) return null;
    return (parseInt(mt[1], 10) % 24) * 60 + parseInt(mt[2], 10);
  };
  const start = parseHM(o.window_start);
  const end = parseHM(o.window_end);
  if (start == null || end == null) return true; // sin ventana horaria → sólo aplica weekday
  const cur = hh * 60 + mm;
  if (start <= end) return cur >= start && cur <= end;
  return cur >= start || cur <= end; // ventana que cruza medianoche
}

type RuleResult = {
  rule_id: string;
  nombre: string | null;
  flow_code: string;
  within_schedule: boolean;
  candidates: number;
  sent: number;
  failed: number;
  skipped_state_changed: number;
  error?: string;
};

async function selectCandidates(
  pool: NonNullable<ReturnType<typeof getChatPostgresPool>>,
  schema: string,
  rule: RuleRow,
  opts: { maxIdleMin: number; limit: number }
): Promise<Candidate[]> {
  const included = toStringArray(rule.included_node_codes);
  // El watchdog nunca reenvía nodos de confirmación/orden, aunque la regla los incluya.
  const excluded = [...new Set([...toStringArray(rule.excluded_node_codes), ...RISKY_NODES])];

  const convs = quoteSchemaTable(schema, "chat_conversations");
  const msgs = quoteSchemaTable(schema, "chat_messages");
  const runs = quoteSchemaTable(schema, "chat_flow_recontact_runs");
  const entradas = quoteSchemaTable(schema, "sorteo_entradas");

  const params: unknown[] = [
    rule.empresa_id, // $1
    rule.id, // $2
    rule.flow_code, // $3
    excluded, // $4 text[]
    String(rule.idle_after_seconds), // $5
    String(opts.maxIdleMin), // $6
    rule.max_attempts, // $7
    String(rule.cooldown_seconds), // $8
    opts.limit, // $9
  ];
  const includedClause =
    included.length > 0 ? `AND c.flow_current_node = ANY($10::text[])` : "";
  if (included.length > 0) params.push(included); // $10
  const purchaseClause = purchaseGuardEnabled(rule.guard_config)
    ? `AND NOT EXISTS (SELECT 1 FROM ${entradas} se WHERE se.chat_conversation_id = c.id AND se.estado_pago = 'confirmado')`
    : "";

  const sql = `
    WITH last_in AS (
      SELECT DISTINCT ON (m.conversation_id) m.conversation_id, m.created_at
      FROM ${msgs} m
      WHERE m.sender_type = 'contact'
      ORDER BY m.conversation_id, m.created_at DESC
    ),
    rl AS (
      SELECT conversation_id,
             count(*) FILTER (WHERE decision = 'sent') AS sent_count,
             max(created_at) FILTER (WHERE decision = 'sent') AS last_sent
      FROM ${runs}
      WHERE empresa_id = $1 AND rule_id = $2
      GROUP BY conversation_id
    )
    SELECT c.id::text AS conversation_id,
           c.flow_current_node,
           c.active_flow_session_id::text AS active_flow_session_id,
           floor(extract(epoch FROM (now() - li.created_at)) / 60)::int AS idle_min
    FROM ${convs} c
    JOIN last_in li ON li.conversation_id = c.id
    LEFT JOIN rl ON rl.conversation_id = c.id
    WHERE c.empresa_id = $1
      AND c.flow_code = $3
      AND c.flow_status = 'bot'
      AND c.human_taken_over = false
      AND c.status <> 'closed'
      AND c.active_flow_session_id IS NOT NULL
      AND c.flow_current_node IS NOT NULL
      AND NOT (c.flow_current_node = ANY($4::text[]))
      ${includedClause}
      AND li.created_at <= now() - ($5 || ' seconds')::interval
      AND li.created_at >= now() - ($6 || ' minutes')::interval
      AND coalesce(rl.sent_count, 0) < $7
      AND (rl.last_sent IS NULL OR rl.last_sent <= now() - ($8 || ' seconds')::interval)
      ${purchaseClause}
    ORDER BY li.created_at DESC
    LIMIT $9`;

  const r = await pool.query(sql, params);
  return (r.rows as Candidate[]) ?? [];
}

async function processRule(
  supabase: Awaited<ReturnType<typeof getChatServiceClientForEmpresa>>,
  pool: NonNullable<ReturnType<typeof getChatPostgresPool>>,
  schema: string,
  rule: RuleRow,
  opts: { apply: boolean; maxSend: number; maxIdleMin: number; correlationId: string; now: Date }
): Promise<RuleResult> {
  const base: RuleResult = {
    rule_id: rule.id,
    nombre: rule.nombre,
    flow_code: rule.flow_code,
    within_schedule: true,
    candidates: 0,
    sent: 0,
    failed: 0,
    skipped_state_changed: 0,
  };

  if (!isWithinSchedule(rule.schedule_config, opts.now)) {
    base.within_schedule = false;
    return base;
  }

  const candidates = await selectCandidates(pool, schema, rule, {
    maxIdleMin: opts.maxIdleMin,
    limit: Math.max(1, opts.maxSend * CANDIDATE_FETCH_MULTIPLIER),
  });
  base.candidates = candidates.length;

  if (!opts.apply) return base;

  let budget = opts.maxSend;
  for (const cand of candidates) {
    if (budget <= 0) break;

    // Re-validación en vivo: el cliente pudo avanzar solo o pasar a humano desde el SELECT.
    const { data: fresh } = await supabase
      .from("chat_conversations")
      .select("flow_status, human_taken_over, flow_current_node, active_flow_session_id")
      .eq("id", cand.conversation_id)
      .eq("empresa_id", rule.empresa_id)
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
      RISKY_NODES_SET.has(f.flow_current_node) ||
      isSorteoFinalTicketNode(f.flow_current_node)
    ) {
      base.skipped_state_changed++;
      continue;
    }

    budget--;
    let ok = false;
    let errMsg: string | null = null;
    let sentNode: string | null = f.flow_current_node ?? cand.flow_current_node ?? null;
    try {
      const res = await sendCurrentFlowNode(supabase, { conversationId: cand.conversation_id });
      ok = res.ok;
      if (res.ok) sentNode = res.nodeCode ?? sentNode;
      else errMsg = res.error ?? "send_failed";
    } catch (e) {
      errMsg = e instanceof Error ? e.message : String(e);
    }

    if (ok) base.sent++;
    else base.failed++;

    await supabase.from("chat_flow_recontact_runs").insert({
      empresa_id: rule.empresa_id,
      rule_id: rule.id,
      flow_code: rule.flow_code,
      conversation_id: cand.conversation_id,
      flow_session_id: f.active_flow_session_id ?? null,
      decision: ok ? "sent" : "failed",
      skip_reason: null,
      correlation_id: opts.correlationId,
      payload_snapshot: {
        node_code: sentNode,
        idle_minutes: cand.idle_min,
        source: "cron_chat_recontact",
        error: ok ? undefined : errMsg,
      },
    });

    await new Promise((r) => setTimeout(r, SEND_DELAY_MS));
  }

  return base;
}

async function handle(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ ok: false, error: "no autorizado" }, { status: 401 });
  }

  const pool = getChatPostgresPool();
  if (!pool) {
    return NextResponse.json({ ok: false, error: "pool no disponible" }, { status: 503 });
  }

  const url = new URL(request.url);
  const apply = parseBool(url.searchParams.get("apply"), false);
  const maxSend = parseIntCap(url.searchParams.get("max_send"), DEFAULT_MAX_SEND, HARD_CAP_SEND);
  const maxIdleMin = parseIntCap(url.searchParams.get("max_idle_min"), DEFAULT_MAX_IDLE_MIN, 24 * 60);

  const correlationId = randomUUID();
  const now = new Date();
  const startedAt = now.toISOString();
  const empresas = resolveEnabledEmpresas();

  console.info("[chat-recontact][cron] start", {
    correlation_id: correlationId.slice(0, 8),
    apply,
    max_send: maxSend,
    single_client: isSingleClientMode(),
    empresas: empresas.map((e) => e.slice(0, 8)),
  });

  const out: Array<{ empresa_id_short: string; ok: boolean; rules: RuleResult[]; error?: string }> = [];

  for (const empresaId of empresas) {
    try {
      const supabase = await getChatServiceClientForEmpresa(empresaId);
      const schema = await fetchDataSchemaForEmpresaId(empresaId);

      const { data: ruleRows, error: rulesErr } = await supabase
        .from("chat_flow_recontact_rules")
        .select(
          "id, empresa_id, flow_code, nombre, activo, prioridad, included_node_codes, excluded_node_codes, idle_after_seconds, max_attempts, cooldown_seconds, schedule_config, guard_config, message_config"
        )
        .eq("empresa_id", empresaId)
        .eq("activo", true)
        .order("prioridad", { ascending: true });

      if (rulesErr) {
        out.push({ empresa_id_short: empresaId.slice(0, 8), ok: false, rules: [], error: rulesErr.message });
        continue;
      }

      const rules = (ruleRows ?? []) as RuleRow[];
      const rulesRes: RuleResult[] = [];
      let globalBudget = maxSend; // presupuesto global de envíos por corrida, repartido por prioridad
      for (const rule of rules) {
        const r = await processRule(supabase, pool, schema, rule, {
          apply,
          maxSend: Math.max(0, globalBudget),
          maxIdleMin,
          correlationId,
          now,
        });
        globalBudget -= r.sent;
        rulesRes.push(r);
        console.info("[chat-recontact][cron] rule", {
          rule_id: r.rule_id.slice(0, 8),
          nombre: r.nombre,
          within_schedule: r.within_schedule,
          candidates: r.candidates,
          sent: r.sent,
          failed: r.failed,
        });
        if (globalBudget <= 0 && apply) break;
      }

      out.push({ empresa_id_short: empresaId.slice(0, 8), ok: true, rules: rulesRes });
    } catch (e) {
      out.push({
        empresa_id_short: empresaId.slice(0, 8),
        ok: false,
        rules: [],
        error: e instanceof Error ? e.message : "unknown",
      });
    }
  }

  return NextResponse.json({
    ok: true,
    started_at: startedAt,
    ended_at: new Date().toISOString(),
    correlation_id: correlationId,
    apply,
    max_send: maxSend,
    empresas: out,
  });
}

export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}
