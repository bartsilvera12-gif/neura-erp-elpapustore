import type { Pool } from "pg";
import { assertAllowedChatDataSchema } from "@/lib/supabase/chat-data-schema";
import { schemaHasBulkCategoryFn } from "./has-bulk-category-fn";

/**
 * Etiquetas Automáticas - FASE 2 (dry-run).
 * READ-ONLY: solo SELECT, no escribe en chat_conversations ni en chat_conversation_tag_history.
 * El motor de aplicación efectiva quedará para una fase posterior.
 */

export const TAG_DRY_RUN_DEFAULT_LIMIT = 100;
export const TAG_DRY_RUN_MAX_LIMIT = 500;
export const TAG_DRY_RUN_DEFAULT_DAYS = 7;

export type TagPurchaseCategory =
  | "purchased_once"
  | "purchased_multiple_tickets"
  | "repurchased"
  | "payment_received_incomplete"
  | "data_incomplete"
  | "abandoned"
  | "no_purchase"
  | "unknown";

export type SuggestedTagCode =
  | "compro_boleta"
  | "compro_varias"
  | "recomprador"
  | "no_compro"
  | "comprobante_pendiente"
  | "datos_incompletos"
  | "abandonado"
  | null;

export const CATEGORY_TO_TAG_CODE: Record<TagPurchaseCategory, Exclude<SuggestedTagCode, null>> = {
  purchased_once: "compro_boleta",
  purchased_multiple_tickets: "compro_varias",
  repurchased: "recomprador",
  payment_received_incomplete: "comprobante_pendiente",
  data_incomplete: "datos_incompletos",
  abandoned: "abandonado",
  no_purchase: "no_compro",
  unknown: "no_compro",
};

/**
 * Filtros disponibles para el dry-run.
 * - "any": no filtra.
 * - "purchased_any": agrupador (purchased_once + purchased_multiple_tickets + repurchased).
 * - "no_purchase" | "payment_pending" | "abandoned" | "data_incomplete": agregadores legacy.
 * - FASE 3C-1: matching 1:1 con cada `TagPurchaseCategory` real (purchased_once,
 *   purchased_multiple_tickets, repurchased, payment_received_incomplete, unknown).
 *   Esto permite que cada regla cuente exclusivamente su categoría.
 */
export type TagDryRunPurchaseFilter =
  | "any"
  | "purchased_any"
  | "no_purchase"
  | "payment_pending"
  | "abandoned"
  | "data_incomplete"
  | "purchased_once"
  | "purchased_multiple_tickets"
  | "repurchased"
  | "payment_received_incomplete"
  | "unknown";

export interface TagDryRunInput {
  empresaId: string;
  schema: string;
  daysWithoutActivity: number;
  limit: number;
  channelId?: string | null;
  purchaseCondition?: TagDryRunPurchaseFilter;
  ruleId?: string | null;
  includeReasons?: boolean;
  excludeHumanTakenOver?: boolean;
  excludeActiveBotSession?: boolean;
  excludeManualClosure?: boolean;
  /**
   * FASE 3A - Modo simulación de sesiones zombies.
   * Cuando true, una `active_flow_session_id` no excluye automáticamente la conversación;
   * se considera candidata si la conversación está stale por last_message_at, no está en
   * humano y no está dentro del grace de un nodo crítico.
   * NO altera el comportamiento productivo: solo afecta el dry-run.
   */
  staleActiveSessionMode?: boolean;
  /** Lista de nodos sensibles que requieren mayor grace cuando staleActiveSessionMode=true. */
  criticalNodeCodes?: string[];
  /** Grace en horas para nodos críticos; default 48. */
  criticalNodeGraceHours?: number;
}

export interface TagDryRunSampleItem {
  conversation_id: string;
  contact_id: string | null;
  phone_masked: string | null;
  last_message_at: string | null;
  days_without_activity: number | null;
  current_node_code: string | null;
  category: TagPurchaseCategory;
  suggested_tag: Exclude<SuggestedTagCode, null>;
  rule_id: string | null;
  decision: "included_clean" | "included_stale_active";
  reason?: string;
}

export interface TagDryRunExcludedItem {
  conversation_id: string;
  excluded_reason: string;
}

export interface TagDryRunResult {
  dry_run: true;
  wrote_changes: false;
  rule_id: string | null;
  filters: {
    days_without_activity: number;
    limit: number;
    channel_id: string | null;
    purchase_condition: TagDryRunPurchaseFilter;
    exclude_human_taken_over: boolean;
    exclude_active_bot_session: boolean;
    exclude_manual_closure: boolean;
    stale_active_session_mode: boolean;
    critical_node_codes: string[];
    critical_node_grace_hours: number;
  };
  scanned: number;
  total_candidates: number;
  by_category: Record<string, number>;
  by_suggested_tag: Record<string, number>;
  /** Contadores de decisión (Fase 3A). */
  decision_counts: {
    evaluated: number;
    excluded_human: number;
    excluded_critical_grace: number;
    excluded_active_bot_strict: number;
    excluded_category_filter: number;
    included_clean: number;
    included_stale_active: number;
    candidates_final: number;
  };
  sample: TagDryRunSampleItem[];
  excluded: TagDryRunExcludedItem[];
}

export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D+/g, "");
  if (digits.length <= 4) return digits;
  const tail = digits.slice(-4);
  return `***${tail}`;
}

function categoryMatchesFilter(
  category: TagPurchaseCategory,
  filter: TagDryRunPurchaseFilter
): boolean {
  switch (filter) {
    case "any":
      return true;
    case "purchased_any":
      return (
        category === "purchased_once" ||
        category === "purchased_multiple_tickets" ||
        category === "repurchased"
      );
    // Agregadores legacy (cuando vienen de UI / reportes globales).
    case "no_purchase":
      // FASE 3C-1: matching estricto 1:1. Antes incluía 'unknown'; ahora no.
      return category === "no_purchase";
    case "payment_pending":
      return category === "payment_received_incomplete";
    case "abandoned":
      return category === "abandoned";
    case "data_incomplete":
      return category === "data_incomplete";
    // FASE 3C-1: matching estricto 1:1 con la categoría real.
    case "purchased_once":
      return category === "purchased_once";
    case "purchased_multiple_tickets":
      return category === "purchased_multiple_tickets";
    case "repurchased":
      return category === "repurchased";
    case "payment_received_incomplete":
      return category === "payment_received_incomplete";
    case "unknown":
      return category === "unknown";
    default:
      return true;
  }
}

export interface TagRuleRow {
  id: string;
  empresa_id: string;
  channel_id: string | null;
  tag_id: string;
  days_without_activity: number;
  purchase_condition: string;
  exclude_human_taken_over: boolean;
  exclude_active_bot_session: boolean;
  exclude_manual_closure: boolean;
}

export async function loadTagRule(
  pool: Pool,
  schema: string,
  empresaId: string,
  ruleId: string
): Promise<TagRuleRow | null> {
  const sch = assertAllowedChatDataSchema(schema);
  const r = await pool.query(
    `SELECT id::text, empresa_id::text, channel_id::text, tag_id::text,
            days_without_activity, purchase_condition,
            exclude_human_taken_over, exclude_active_bot_session, exclude_manual_closure
       FROM "${sch}".chat_conversation_tag_rules
       WHERE id = $1 AND empresa_id = $2
       LIMIT 1`,
    [ruleId, empresaId]
  );
  if (!r.rows.length) return null;
  return r.rows[0] as TagRuleRow;
}

export const TAG_DRY_RUN_DEFAULT_CRITICAL_NODES = [
  "pedido_de_comprobante",
  "confirmacion_de_compra",
  "aprobacion_de_compra",
];

export const TAG_DRY_RUN_DEFAULT_CRITICAL_GRACE_HOURS = 48;

type DecisionCode =
  | "excluded_human"
  | "excluded_critical_grace"
  | "excluded_active_bot_strict"
  | "included_clean"
  | "included_stale_active";

export async function runTagDryRun(pool: Pool, input: TagDryRunInput): Promise<TagDryRunResult> {
  const sch = assertAllowedChatDataSchema(input.schema);
  // Optimización: si el schema tiene el clasificador set-based, se calcula la
  // categoría de todas las conversaciones en una pasada (JOIN) en vez de llamar
  // la función fila-por-fila (que con decenas de miles de candidatas tardaba
  // ~165 s y saturaba la base). Fallback transparente a la función original.
  const useBulk = await schemaHasBulkCategoryFn(pool, sch);
  const days = Math.max(1, Math.floor(input.daysWithoutActivity || TAG_DRY_RUN_DEFAULT_DAYS));
  const limit = Math.min(
    TAG_DRY_RUN_MAX_LIMIT,
    Math.max(1, Math.floor(input.limit || TAG_DRY_RUN_DEFAULT_LIMIT))
  );
  const channelId = input.channelId?.trim() || null;
  const purchaseFilter: TagDryRunPurchaseFilter = (input.purchaseCondition ?? "any") as TagDryRunPurchaseFilter;
  const excludeHuman = input.excludeHumanTakenOver !== false;
  const excludeActiveBotStrict = input.excludeActiveBotSession !== false;
  const excludeManualClosure = input.excludeManualClosure !== false;
  const includeReasons = input.includeReasons === true;
  const staleMode = input.staleActiveSessionMode === true;
  const criticalNodes =
    input.criticalNodeCodes && input.criticalNodeCodes.length > 0
      ? input.criticalNodeCodes
      : TAG_DRY_RUN_DEFAULT_CRITICAL_NODES;
  const criticalGraceHours = Math.max(
    0,
    Math.floor(input.criticalNodeGraceHours ?? TAG_DRY_RUN_DEFAULT_CRITICAL_GRACE_HOURS)
  );

  // FASE 3A: la clasificacion vive en una CTE para que un mismo SELECT entregue:
  //   - counters por decision (evaluated, excluded_*, included_*)
  //   - sample con los included
  // READ-ONLY: solo SELECT. No toca chat_conversations, sesiones ni historial.
  const params: unknown[] = [input.empresaId, days];
  let whereExtra = "";
  if (channelId) {
    params.push(channelId);
    whereExtra += ` AND c.channel_id = $${params.length}`;
  }
  if (excludeManualClosure) {
    whereExtra += ` AND c.closed_by_usuario_id IS NULL`;
  }
  params.push(criticalNodes);
  const pCriticalNodes = `$${params.length}::text[]`;
  params.push(criticalGraceHours);
  const pCriticalGrace = `$${params.length}::int`;

  const strictActiveBotClause = excludeActiveBotStrict && !staleMode
    ? `WHEN b.active_flow_session_id IS NOT NULL THEN 'excluded_active_bot_strict'`
    : "";

  // Clasificador: bulk set-based (JOIN) cuando el schema lo tiene; si no, la
  // función fila-por-fila original. $1 = empresa_id (mismo del WHERE de base).
  const bulkCte = useBulk
    ? `cats_src AS (
        SELECT conversation_id, category
          FROM "${sch}".chat_tag_purchase_category_bulk($1)
      ),`
    : "";
  const bulkJoin = useBulk ? `LEFT JOIN cats_src ON cats_src.conversation_id = c.id` : "";
  const categoryExpr = useBulk ? "cats_src.category" : `"${sch}".chat_tag_purchase_category(c.id)`;

  const sql = `
    WITH ${bulkCte} base AS (
      SELECT
        c.id,
        c.contact_id,
        c.last_message_at,
        c.channel_id,
        c.active_flow_session_id,
        c.human_taken_over,
        c.flow_status,
        c.flow_current_node,
        ct.phone_number,
        EXTRACT(EPOCH FROM (now() - c.last_message_at)) / 86400.0 AS days_idle,
        ${categoryExpr} AS category
      FROM "${sch}".chat_conversations c
      LEFT JOIN "${sch}".chat_contacts ct ON ct.id = c.contact_id
      ${bulkJoin}
      WHERE c.empresa_id = $1
        AND c.status IN ('open','pending')
        AND c.hidden_by_tag = false
        AND c.current_tag_id IS NULL
        AND c.last_message_at < now() - ($2::int * interval '1 day')
        ${whereExtra}
    ),
    classified AS (
      SELECT b.*,
        CASE
          ${
            excludeHuman
              ? `WHEN b.human_taken_over IS TRUE OR b.flow_status = 'human' THEN 'excluded_human'`
              : ""
          }
          ${
            criticalGraceHours > 0
              ? `WHEN b.flow_current_node = ANY(${pCriticalNodes})
                       AND b.last_message_at > now() - (${pCriticalGrace} * interval '1 hour')
                       THEN 'excluded_critical_grace'`
              : ""
          }
          ${strictActiveBotClause}
          WHEN b.active_flow_session_id IS NOT NULL THEN 'included_stale_active'
          ELSE 'included_clean'
        END AS decision
      FROM base b
    )
    SELECT
      id::text AS conversation_id,
      contact_id::text AS contact_id,
      last_message_at,
      channel_id::text AS channel_id,
      phone_number,
      flow_current_node,
      days_idle,
      category,
      decision
    FROM classified
  `;

  const fullResult = await pool.query(sql, params);

  const sample: TagDryRunSampleItem[] = [];
  const excluded: TagDryRunExcludedItem[] = [];
  const byCategory: Record<string, number> = {};
  const byTag: Record<string, number> = {};

  const counts = {
    evaluated: fullResult.rows.length,
    excluded_human: 0,
    excluded_critical_grace: 0,
    excluded_active_bot_strict: 0,
    excluded_category_filter: 0,
    included_clean: 0,
    included_stale_active: 0,
    candidates_final: 0,
  };

  for (const row of fullResult.rows as Array<{
    conversation_id: string;
    contact_id: string | null;
    last_message_at: Date | string | null;
    channel_id: string | null;
    phone_number: string | null;
    flow_current_node: string | null;
    days_idle: string | number | null;
    category: string | null;
    decision: DecisionCode;
  }>) {
    if (row.decision === "excluded_human") {
      counts.excluded_human += 1;
      continue;
    }
    if (row.decision === "excluded_critical_grace") {
      counts.excluded_critical_grace += 1;
      if (includeReasons) {
        excluded.push({
          conversation_id: row.conversation_id,
          excluded_reason: `critical_grace_node:${row.flow_current_node ?? "?"}`,
        });
      }
      continue;
    }
    if (row.decision === "excluded_active_bot_strict") {
      counts.excluded_active_bot_strict += 1;
      continue;
    }
    // Included paths: aplicar filtro de categoria y luego cupo (limit).
    const rawCategory = (row.category ?? "unknown") as string;
    const category: TagPurchaseCategory = (
      [
        "purchased_once",
        "purchased_multiple_tickets",
        "repurchased",
        "payment_received_incomplete",
        "data_incomplete",
        "abandoned",
        "no_purchase",
        "unknown",
      ].includes(rawCategory)
        ? (rawCategory as TagPurchaseCategory)
        : "unknown"
    );
    if (!categoryMatchesFilter(category, purchaseFilter)) {
      counts.excluded_category_filter += 1;
      continue;
    }

    if (row.decision === "included_stale_active") counts.included_stale_active += 1;
    else counts.included_clean += 1;
    counts.candidates_final += 1;

    const suggested = CATEGORY_TO_TAG_CODE[category];
    byCategory[category] = (byCategory[category] ?? 0) + 1;
    byTag[suggested] = (byTag[suggested] ?? 0) + 1;

    if (sample.length < limit) {
      const lm =
        row.last_message_at instanceof Date
          ? row.last_message_at.toISOString()
          : row.last_message_at != null
            ? String(row.last_message_at)
            : null;
      const daysIdle =
        row.days_idle == null
          ? null
          : Math.floor(typeof row.days_idle === "string" ? parseFloat(row.days_idle) : row.days_idle);
      const item: TagDryRunSampleItem = {
        conversation_id: row.conversation_id,
        contact_id: row.contact_id,
        phone_masked: maskPhone(row.phone_number),
        last_message_at: lm,
        days_without_activity: daysIdle,
        current_node_code: row.flow_current_node ?? null,
        category,
        suggested_tag: suggested,
        rule_id: input.ruleId ?? null,
        decision: row.decision,
      };
      if (includeReasons) {
        item.reason = `category=${category}; days_idle>=${days}; decision=${row.decision}`;
      }
      sample.push(item);
    }
  }

  return {
    dry_run: true,
    wrote_changes: false,
    rule_id: input.ruleId ?? null,
    filters: {
      days_without_activity: days,
      limit,
      channel_id: channelId,
      purchase_condition: purchaseFilter,
      exclude_human_taken_over: excludeHuman,
      exclude_active_bot_session: excludeActiveBotStrict,
      exclude_manual_closure: excludeManualClosure,
      stale_active_session_mode: staleMode,
      critical_node_codes: criticalNodes,
      critical_node_grace_hours: criticalGraceHours,
    },
    scanned: counts.evaluated,
    total_candidates: counts.candidates_final,
    by_category: byCategory,
    by_suggested_tag: byTag,
    decision_counts: counts,
    sample,
    excluded,
  };
}
