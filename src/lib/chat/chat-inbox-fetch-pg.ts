import type { Pool } from "pg";
import { awaitingReplyRpcAdmitsSchema } from "@/lib/chat/awaiting-reply-rpc";
import {
  aggregateBotClassificationReasons,
  buildActiveFlowMatchSet,
  buildFlowSessionMap,
  conversationBelongsToBotTab,
  explainConversationBotClassification,
  flowTokenMatchesActiveCatalog,
  maskPhonePartialForLog,
  type FlowSessionRowMin,
} from "@/lib/chat/inbox-bot-tab-classification";
import {
  loadActiveFlowSessionsByConversationForInboxListPg,
} from "@/lib/chat/inbox-list-flow-sessions";
import { parseComprobanteValidationConfig } from "@/lib/chat/comprobante-validation-types";
import { logChatListClassificationInvariant } from "@/lib/chat/chat-list-classification-invariant";
import {
  getOmnicanalScope,
  isOmnicanalAdminScope,
  OMNICANAL_IMPOSSIBLE_CONVERSATION_ID,
  resolveQueueIdsForUsuarios,
  shouldBypassOmnicanalConversationScope,
} from "@/lib/chat/omnicanal-scope";
import { buildPgOmnicanalConversationScopeAndClause } from "@/lib/chat/omnicanal-scope-pg";
import { pgSelectChatAgentIdsForUsuarios } from "@/lib/chat/omnicanal-scope-pg";
import { schemaHasHiddenByTagColumn } from "@/lib/chat/tags/has-hidden-by-tag-column";
import type { AppSupabaseClient } from "@/lib/supabase/schema";
import {
  isPgPoolExhaustionMessage,
  logPgPoolStats,
  quoteSchemaTable,
} from "@/lib/supabase/chat-pg-pool";
import type {
  ChatConversationsFetchResult,
  ChatInboxFilters,
  ConversacionesVista,
  InboxConversation,
} from "@/lib/chat/actions";
import { normalizeChannelType } from "@/lib/chat/channel-type-utils";

type FlowCtx = {
  supabase: AppSupabaseClient;
  catalogSr: AppSupabaseClient;
  empresa_id: string;
  usuario_id: string;
};

function isoPg(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

type ActiveFlowCatalogRow = {
  id: string;
  flow_code: string;
  name: string;
  activo: boolean;
};

async function pgLoadActiveFlowsForClassification(
  pool: Pool,
  schema: string,
  empresaId: string
): Promise<{ rows: ActiveFlowCatalogRow[]; matchSet: Set<string> }> {
  try {
    const qt = quoteSchemaTable(schema, "chat_flows");
    /** Misma regla que PostgREST en `fetchChatConversations`: flujos activos; incluye id para coincidir sesiones que guardan UUID. */
    const q = `
      SELECT id::text AS id, flow_code::text AS flow_code,
             COALESCE(label, '')::text AS name,
             COALESCE(activo, false) AS activo
      FROM ${qt}
      WHERE empresa_id = $1::uuid
        AND COALESCE(activo, false) = true
    `;
    const r = await pool.query(q, [empresaId]);
    const rows: ActiveFlowCatalogRow[] = (r.rows ?? []).map((row: Record<string, unknown>) => ({
      id: String(row.id ?? "").trim(),
      flow_code: String(row.flow_code ?? "").trim(),
      name: String(row.name ?? "").trim(),
      activo: Boolean(row.activo),
    }));
    return { rows, matchSet: buildActiveFlowMatchSet(rows) };
  } catch (e) {
    console.warn("[bot-routing]", "pgLoadActiveFlowsForClassification_failed", {
      empresa_id: empresaId,
      schema,
      message: e instanceof Error ? e.message : String(e),
    });
    return { rows: [], matchSet: new Set() };
  }
}

async function logBotTabClassificationSampleTenantPg(
  pool: Pool,
  schema: string,
  empresaId: string,
  vista: ConversacionesVista,
  listBeforeSplit: Record<string, unknown>[],
  botTabCount: number,
  activeSessionsSize: number,
  classifyCtx: {
    activeFlowCodeSet: Set<string>;
    sessionById: Map<string, FlowSessionRowMin>;
    activeSessionByConversationId: Map<string, FlowSessionRowMin>;
  },
  activeFlowCatalogRowCount: number
): Promise<void> {
  if (vista !== "bot" || botTabCount > 0 || activeSessionsSize === 0) return;

  const withMappedSession = listBeforeSplit.filter((row) => {
    const cid = String(row.id ?? "").trim();
    return cid.length > 0 && classifyCtx.activeSessionByConversationId.has(cid);
  });
  const pick = (withMappedSession.length > 0 ? withMappedSession : listBeforeSplit).slice(0, 5);
  if (pick.length === 0) return;

  const chIds = [
    ...new Set(
      pick
        .map((row) => String((row as { channel_id?: string | null }).channel_id ?? "").trim())
        .filter(Boolean)
    ),
  ];
  const chById: Record<string, { type: string; nombre: string | null }> = {};
  if (chIds.length > 0) {
    try {
      const chQt = quoteSchemaTable(schema, "chat_channels");
      const chr = await pool.query(
        `SELECT id::text, type::text, nombre::text FROM ${chQt}
         WHERE empresa_id = $1::uuid AND id = ANY($2::uuid[])`,
        [empresaId, chIds]
      );
      for (const r of chr.rows ?? []) {
        const row = r as { id?: string; type?: string; nombre?: string | null };
        const id = String(row.id ?? "").trim();
        if (!id) continue;
        chById[id] = { type: String(row.type ?? "").trim() || "unknown", nombre: row.nombre ?? null };
      }
    } catch {
      /* sin metadatos de canal */
    }
  }

  for (const row of pick) {
    const ex = explainConversationBotClassification(row, classifyCtx);
    const cid = String(row.id ?? "").trim();
    const ptr = String((row as { active_flow_session_id?: string | null }).active_flow_session_id ?? "").trim();
    const mapped = classifyCtx.activeSessionByConversationId.get(cid);
    const resolvedId = ex.resolvedSessionId ?? mapped?.id ?? null;
    const resolvedRow = resolvedId ? classifyCtx.sessionById.get(resolvedId) ?? mapped : mapped;
    const sessFlow = resolvedRow ? String(resolvedRow.flow_code ?? "").trim() : "";
    const chId = String((row as { channel_id?: string | null }).channel_id ?? "").trim();
    const ch = chId ? chById[chId] : undefined;

    console.info("[chat-list][classification-sample]", {
      conversation_id: cid,
      status: String(row.status ?? ""),
      human_taken_over: Boolean(row.human_taken_over),
      flow_status: String(row.flow_status ?? ""),
      active_flow_session_id: ptr || null,
      resolved_session_id: resolvedId,
      resolved_session_status: resolvedRow ? String(resolvedRow.status ?? "") : null,
      resolved_session_flow_code: sessFlow || null,
      channel_id: chId || null,
      channel_provider: ch?.type ?? null,
      channel_name: ch?.nombre ?? null,
      has_channel_flow: ex.flags.hasChannelFlow,
      active_flow_codes: activeFlowCatalogRowCount,
      flow_code_in_active_set: flowTokenMatchesActiveCatalog(sessFlow, classifyCtx.activeFlowCodeSet),
      result_is_bot: ex.isBot,
      reason_not_bot: ex.isBot ? null : ex.reason,
      flags: ex.flags,
    });
  }
}

async function pgFetchConversationsWithColumns(
  pool: Pool,
  schema: string,
  whereSql: string,
  params: unknown[],
  variant: "full" | "legacy" | "min"
): Promise<Record<string, unknown>[] | null> {
  const qt = quoteSchemaTable(schema, "chat_conversations");
  const colsFull = `
    id, status, priority, queue_id, assignment_wait_code, assigned_agent_id,
    last_message_at, last_message_preview, unread_count, contact_id, channel_id,
    flow_code, flow_current_node, flow_status, human_taken_over, active_flow_session_id
  `;
  const colsLegacy = `
    id, status, priority, queue_id, assigned_agent_id,
    last_message_at, last_message_preview, unread_count, contact_id, channel_id,
    flow_code, flow_current_node, flow_status, human_taken_over, active_flow_session_id
  `;
  const colsMin = `
    id, status, queue_id, assigned_agent_id,
    last_message_at, last_message_preview, unread_count, contact_id, channel_id,
    flow_code, flow_current_node, flow_status, human_taken_over, active_flow_session_id
  `;
  const cols = variant === "full" ? colsFull : variant === "legacy" ? colsLegacy : colsMin;
  const q = `
    SELECT ${cols}
    FROM ${qt}
    WHERE ${whereSql}
    ORDER BY last_message_at DESC NULLS LAST
  `;
  try {
    const r = await pool.query(q, params);
    return (r.rows ?? []) as Record<string, unknown>[];
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (isPgPoolExhaustionMessage(msg)) {
      logPgPoolStats("pgFetchConversationsWithColumns", pool, {
        schema,
        variant,
        caller: "pgFetchConversationsWithColumns",
      });
      console.error("[chat-list][pg-pool-exhausted]", {
        schema,
        variant,
        surface: "conversations_query",
      });
    }
    return null;
  }
}

async function pgMapLastMessageByConversation(
  pool: Pool,
  schema: string,
  empresaId: string,
  convIds: string[]
): Promise<Record<string, { created_at: string; from_me: boolean }>> {
  const unique = [...new Set(convIds.map((x) => x.trim()).filter(Boolean))];
  const out: Record<string, { created_at: string; from_me: boolean }> = {};
  if (unique.length === 0) return out;
  const qt = quoteSchemaTable(schema, "chat_messages");
  const batchSize = 80;
  for (let i = 0; i < unique.length; i += batchSize) {
    const batch = unique.slice(i, i + batchSize);
    const q = `
      SELECT conversation_id::text AS conversation_id, created_at, from_me
      FROM (
        SELECT conversation_id, created_at, from_me,
          ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY created_at DESC) AS rn
        FROM ${qt}
        WHERE empresa_id = $1::uuid AND conversation_id = ANY($2::uuid[])
      ) x
      WHERE rn = 1
    `;
    try {
      const r = await pool.query(q, [empresaId, batch]);
      for (const row of r.rows ?? []) {
        const cid = String((row as { conversation_id?: string }).conversation_id ?? "").trim();
        if (!cid) continue;
        const created_at = isoPg((row as { created_at?: unknown }).created_at) ?? "";
        if (!created_at) continue;
        out[cid] = {
          created_at,
          from_me: Boolean((row as { from_me?: boolean }).from_me),
        };
      }
    } catch {
      /* ignore batch */
    }
  }
  return out;
}

/** Inbox/Bot/Historial con SQL directo en schema tenant (PostgREST sin exponer `erp_*`). */
export async function fetchChatConversationsFromTenantPg(
  pool: Pool,
  dataSchema: string,
  vista: ConversacionesVista,
  filters: ChatInboxFilters | undefined,
  ctx: FlowCtx
): Promise<ChatConversationsFetchResult> {
  const { supabase, catalogSr, empresa_id, usuario_id } = ctx;

  const { rows: activeFlowRows, matchSet: activeFlowCodeSet } = await pgLoadActiveFlowsForClassification(
    pool,
    dataSchema,
    empresa_id
  );
  const activeFlowCatalogRowCount = activeFlowRows.length;
  if (vista === "bot" && activeFlowCatalogRowCount === 0) {
    return { conversations: [], base_row_count: 0 };
  }

  const scope = await getOmnicanalScope(supabase, empresa_id, usuario_id, {
    tenantDataSchema: dataSchema,
  });
  const bypass = await shouldBypassOmnicanalConversationScope(catalogSr, usuario_id, scope);

  const params: unknown[] = [empresa_id];
  let pi = 2;
  const whereParts: string[] = [`empresa_id = $1::uuid`];

  if (vista === "inbox" || vista === "bot") {
    /** Inbox y Bot comparten el mismo universo (abiertas/pendientes); la pestaña se decide al clasificar. */
    whereParts.push(`status IN ('open','pending')`);
  } else if (vista === "historial") {
    whereParts.push(`status = 'closed'`);
  }

  // FASE 5B-INBOX: ocultar conversaciones con hidden_by_tag=true en inbox/bot.
  // Guard multi-tenant: solo aplica el filtro si el schema tiene la columna
  // (hoy únicamente erp_el_papu_store_5ad0bdda; otros tenants quedan intactos).
  // Historial puede seguir mostrando ocultas-por-tag (no afecta la queja
  // operativa del usuario), pero por simetría también las omitimos cuando
  // la columna existe.
  if (await schemaHasHiddenByTagColumn(pool, dataSchema)) {
    whereParts.push(`COALESCE(hidden_by_tag, false) = false`);
  }

  const assignment = filters?.assignment ?? "all";
  if (assignment === "mine") {
    const mids = await pgSelectChatAgentIdsForUsuarios(pool, dataSchema, empresa_id, [usuario_id], true);
    const mids2 =
      mids.length > 0 ? mids : await pgSelectChatAgentIdsForUsuarios(pool, dataSchema, empresa_id, [usuario_id], false);
    if (mids2.length > 0) {
      whereParts.push(`assigned_agent_id = ANY($${pi}::uuid[])`);
      params.push(mids2);
      pi++;
    }
  } else if (assignment === "unassigned") {
    whereParts.push(`assigned_agent_id IS NULL`);
  }

  const fq = filters?.queue_id?.trim();
  if (fq) {
    let queueOk = true;
    if (!bypass && !isOmnicanalAdminScope(scope)) {
      const allowedQueues = await resolveQueueIdsForUsuarios(supabase, empresa_id, scope.agentUsuarioIds, dataSchema);
      queueOk = allowedQueues.includes(fq);
    }
    if (queueOk) {
      whereParts.push(`queue_id = $${pi}::uuid`);
      params.push(fq);
      pi++;
    } else {
      whereParts.push(`id = $${pi}::uuid`);
      params.push(OMNICANAL_IMPOSSIBLE_CONVERSATION_ID);
      pi++;
    }
  }

  const fs = filters?.status?.trim().toLowerCase();
  if (fs && ["open", "pending", "closed"].includes(fs)) {
    whereParts.push(`status = $${pi}`);
    params.push(fs);
    pi++;
  }

  const fp = filters?.priority?.trim().toLowerCase();
  if (fp && ["low", "medium", "high"].includes(fp)) {
    whereParts.push(`priority = $${pi}`);
    params.push(fp);
    pi++;
  }

  const fch = filters?.channel_id?.trim();
  if (fch) {
    whereParts.push(`channel_id = $${pi}::uuid`);
    params.push(fch);
    pi++;
  }

  if (!bypass) {
    const scopeSql = await buildPgOmnicanalConversationScopeAndClause(
      pool,
      dataSchema,
      empresa_id,
      scope,
      pi
    );
    whereParts.push(`(${scopeSql.sql})`);
    params.push(...scopeSql.params);
    pi = scopeSql.nextOffset;
  }

  const whereSql = whereParts.join(" AND ");

  const full = await pgFetchConversationsWithColumns(pool, dataSchema, whereSql, params, "full");
  const legacy =
    full === null
      ? await pgFetchConversationsWithColumns(pool, dataSchema, whereSql, params, "legacy")
      : null;
  const min =
    full === null && legacy === null
      ? await pgFetchConversationsWithColumns(pool, dataSchema, whereSql, params, "min")
      : null;

  let list: Record<string, unknown>[];
  if (full !== null) {
    list = full;
  } else if (legacy !== null) {
    list = legacy;
  } else if (min !== null) {
    list = min;
  } else {
    logPgPoolStats("fetchChatConversationsFromTenantPg", pool, {
      schema: dataSchema,
      empresa_id,
      caller: "main_conversation_select",
    });
    console.error("[pg_pool_exhausted]", {
      kind: "tenant_pg_list",
      schema: dataSchema,
      empresa_id,
    });
    return {
      conversations: [],
      base_row_count: 0,
      transient_list_error: true,
    };
  }

  const totalAfterQuery = list.length;
  console.info("[chat-list][fetch-result]", {
    source: "tenant_pg",
    schema: dataSchema,
    empresa_id,
    total_fetched: totalAfterQuery,
    timestamp: new Date().toISOString(),
  });

  const sessionIds = [
    ...new Set(
      list
        .map((row) => String((row as { active_flow_session_id?: string | null }).active_flow_session_id ?? "").trim())
        .filter(Boolean)
    ),
  ];
  const flowSessionById = new Map<string, FlowSessionRowMin>();
  const sch = dataSchema;
  const sessQt = quoteSchemaTable(sch, "chat_flow_sessions");
  const sessionChunk = 100;
  for (let i = 0; i < sessionIds.length; i += sessionChunk) {
    const chunk = sessionIds.slice(i, i + sessionChunk);
    try {
      const qr = await pool.query(
        `
        SELECT id::text, status::text, flow_code::text, conversation_id::text
        FROM ${sessQt}
        WHERE empresa_id = $1::uuid AND id = ANY($2::uuid[])
      `,
        [empresa_id, chunk]
      );
      for (const [k, v] of buildFlowSessionMap(qr.rows as FlowSessionRowMin[]).entries()) {
        flowSessionById.set(k, v);
      }
    } catch {
      /* sin sesiones */
    }
  }

  const activeSessionByConversationId = await loadActiveFlowSessionsByConversationForInboxListPg(
    pool,
    dataSchema,
    empresa_id,
    list,
    flowSessionById
  );

  if (
    String(process.env.CHAT_REPAIR_FLOW_SESSION_POINTERS ?? "")
      .trim()
      .toLowerCase() === "true"
  ) {
    const convT = quoteSchemaTable(sch, "chat_conversations");
    for (const row of list) {
      const cid = String((row as { id?: unknown }).id ?? "").trim();
      const sess = activeSessionByConversationId.get(cid);
      const cur = String((row as { active_flow_session_id?: string | null }).active_flow_session_id ?? "").trim();
      if (sess && cur !== sess.id) {
        try {
          await pool.query(
            `UPDATE ${convT} SET active_flow_session_id = $1::uuid, updated_at = now() WHERE id = $2::uuid AND empresa_id = $3::uuid`,
            [sess.id, cid, empresa_id]
          );
          (row as { active_flow_session_id?: string | null }).active_flow_session_id = sess.id;
        } catch (e) {
          console.warn("[chat-list] pg repair active_flow_session_id:", e instanceof Error ? e.message : e);
        }
      }
    }
  }

  const classifyCtx = {
    activeFlowCodeSet,
    sessionById: flowSessionById,
    activeSessionByConversationId,
  };

  const listBeforeBotTabSplit = [...list];

  const rowsSnapshotForLogs = (
    String(process.env.CHAT_LIST_CLASSIFICATION_VERBOSE ?? "")
      .trim()
      .toLowerCase() === "true"
      ? [...list]
      : []
  ) as Record<string, unknown>[];

  let botTabCount = 0;
  if (vista === "inbox") {
    botTabCount = list.filter((row) => conversationBelongsToBotTab(row, classifyCtx)).length;
    list = list.filter((row) => !conversationBelongsToBotTab(row, classifyCtx));
  } else if (vista === "bot") {
    list = list.filter((row) => conversationBelongsToBotTab(row, classifyCtx));
    botTabCount = list.length;
  }

  console.info("[chat-list][classification]", {
    vista,
    empresa_id,
    schema: dataSchema,
    source: "tenant_pg",
    total_fetched: totalAfterQuery,
    after_tab_split: list.length,
    bot_like_count: botTabCount,
    active_flow_codes: activeFlowCatalogRowCount,
    active_flow_match_tokens: activeFlowCodeSet.size,
    session_map_size: flowSessionById.size,
    active_sessions_by_conversation: activeSessionByConversationId.size,
  });

  console.info("[chat-list][active-flows]", {
    schema: dataSchema,
    empresa_id,
    count: activeFlowCatalogRowCount,
    sample: activeFlowRows.slice(0, 12).map((r) => ({
      id: r.id,
      flow_code: r.flow_code,
      name: r.name.trim() ? r.name : null,
      active: r.activo,
    })),
  });

  await logBotTabClassificationSampleTenantPg(
    pool,
    dataSchema,
    empresa_id,
    vista,
    listBeforeBotTabSplit,
    botTabCount,
    activeSessionByConversationId.size,
    classifyCtx,
    activeFlowCatalogRowCount
  );

  if (vista === "bot" && botTabCount === 0 && activeSessionByConversationId.size > 0) {
    console.info("[chat-list][classification-reasons-summary]", {
      schema: dataSchema,
      empresa_id,
      counts: aggregateBotClassificationReasons(listBeforeBotTabSplit, classifyCtx),
    });
  }

  logChatListClassificationInvariant({
    vista,
    source: "tenant_pg",
    schema: dataSchema,
    empresa_id,
    totalAfterQuery,
    listAfterTabSplit: list,
    botTabCount,
    baseRows: listBeforeBotTabSplit,
    classifyCtx,
  });

  if (rowsSnapshotForLogs.length > 0) {
    const contactIds = [
      ...new Set(
        rowsSnapshotForLogs
          .map((r) => String((r as { contact_id?: string | null }).contact_id ?? "").trim())
          .filter(Boolean)
      ),
    ];
    const contactById: Record<string, { name: string | null; phone_number: string | null }> = {};
    const contQt = quoteSchemaTable(sch, "chat_contacts");
    const cchunk = 80;
    for (let i = 0; i < contactIds.length; i += cchunk) {
      const part = contactIds.slice(i, i + cchunk);
      try {
        const cr = await pool.query(
          `SELECT id::text, name::text, phone_number::text FROM ${contQt}
           WHERE empresa_id = $1::uuid AND id = ANY($2::uuid[])`,
          [empresa_id, part]
        );
        for (const c of cr.rows ?? []) {
          const row = c as { id?: string; name?: string | null; phone_number?: string | null };
          const id = String(row.id ?? "").trim();
          if (!id) continue;
          contactById[id] = { name: row.name ?? null, phone_number: row.phone_number ?? null };
        }
      } catch (e) {
        console.warn("[chat-list][classification-debug] contactos:", e instanceof Error ? e.message : e);
      }
    }

    for (const row of rowsSnapshotForLogs) {
      const ex = explainConversationBotClassification(row, classifyCtx);
      const cid = String(row.id ?? "").trim();
      const ctc = String((row as { contact_id?: string | null }).contact_id ?? "").trim();
      const ct = ctc ? contactById[ctc] : undefined;
      const label =
        (ct?.name && String(ct.name).trim()) ||
        maskPhonePartialForLog(ct?.phone_number ?? undefined) ||
        "(sin contacto)";
      console.info("[chat-list][classification-debug]", {
        empresa_id,
        schema: dataSchema,
        vista,
        source: "tenant_pg",
        conversation_id: cid,
        contact_label: label,
        status: String(row.status ?? ""),
        human_taken_over: Boolean(row.human_taken_over),
        flow_status: String(row.flow_status ?? ""),
        active_flow_session_id: String((row as { active_flow_session_id?: string | null }).active_flow_session_id ?? "") || null,
        flow_code: String((row as { flow_code?: string | null }).flow_code ?? "") || null,
        channel_id: String((row as { channel_id?: string | null }).channel_id ?? "") || null,
        has_channel_flow: ex.flags.hasChannelFlow,
        has_active_flow_session_from_table: ex.flags.hasActiveSessionInTable,
        chat_flow_sessions: {
          id: ex.resolvedSessionId,
          status: ex.flags.sessionStatus,
        },
        result_is_bot_conversation: ex.isBot,
        reason_not_bot: ex.isBot ? null : ex.reason,
        flags: ex.flags,
      });
    }
  }

  if (list.length === 0) {
    return { conversations: [], base_row_count: totalAfterQuery };
  }

  const convIdList = list.map((row) => String(row.id ?? "").trim()).filter(Boolean);

  const awaitingById: Record<string, string | null> = {};
  const clientTurnById: Record<string, string | null> = {};
  if (convIdList.length > 0) {
    // Fuera del allowlist de la función SQL la RPC siempre falla: ni se intenta (ver awaiting-reply-rpc).
    if (awaitingReplyRpcAdmitsSchema(dataSchema)) try {
      const { data: rpcRows, error: rpcErr } = await catalogSr.rpc("neura_inbox_awaiting_reply_since_batch", {
        p_schema: dataSchema,
        p_empresa_id: empresa_id,
        p_conversation_ids: convIdList,
      });
      if (!rpcErr && Array.isArray(rpcRows)) {
        for (const r of rpcRows as {
          conversation_id?: string;
          awaiting_since?: string | null;
          client_turn_since?: string | null;
        }[]) {
          const id = String(r.conversation_id ?? "").trim();
          if (!id) continue;
          awaitingById[id] = r.awaiting_since ?? null;
          clientTurnById[id] = r.client_turn_since ?? null;
        }
      } else if (rpcErr) {
        console.warn("[fetchChatConversations] awaiting_reply RPC:", rpcErr.message);
      }
    } catch (e) {
      console.warn("[fetchChatConversations] awaiting_reply RPC:", e instanceof Error ? e.message : e);
    }

    const lastByConv = await pgMapLastMessageByConversation(pool, sch, empresa_id, convIdList);
    for (const id of convIdList) {
      if (awaitingById[id] != null || clientTurnById[id] != null) continue;
      const last = lastByConv[id];
      if (!last?.created_at) continue;
      if (!last.from_me) awaitingById[id] = last.created_at;
      else clientTurnById[id] = last.created_at;
    }
  }

  const channelIds = [
    ...new Set(
      list
        .map((c) => (c.channel_id as string | null | undefined)?.trim())
        .filter((x): x is string => Boolean(x && x.length > 0))
    ),
  ];

  let channelById: Record<
    string,
    {
      type: string;
      nombre: string | null;
      comprobante_validation_enabled: boolean;
      quick_replies_inbox_enabled: boolean;
    }
  > = {};

  if (channelIds.length > 0) {
    try {
      const chQt = quoteSchemaTable(sch, "chat_channels");
      const chr = await pool.query(
        `SELECT id::text, type::text, nombre::text, config FROM ${chQt}
         WHERE empresa_id = $1::uuid AND id = ANY($2::uuid[])`,
        [empresa_id, channelIds]
      );
      channelById = Object.fromEntries(
        (chr.rows ?? []).map((r: Record<string, unknown>) => {
          const id = String(r.id ?? "").trim();
          const cfg = r.config;
          const compOn =
            cfg && typeof cfg === "object" && !Array.isArray(cfg)
              ? parseComprobanteValidationConfig(cfg as Record<string, unknown>).enabled
              : false;
          const qrOn =
            cfg && typeof cfg === "object" && !Array.isArray(cfg)
              ? (cfg as Record<string, unknown>).quick_replies_inbox_enabled !== false
              : true;
          return [
            id,
            {
              type: (r.type as string) ?? "whatsapp",
              nombre: (r.nombre as string) ?? null,
              comprobante_validation_enabled: compOn,
              quick_replies_inbox_enabled: qrOn,
            },
          ];
        })
      );
    } catch {
      console.warn("[fetchChatConversations] chat_channels pg batch falló");
    }
  }

  const queueIds = [
    ...new Set(
      list
        .map((c) => (c.queue_id as string | null | undefined)?.trim())
        .filter((x): x is string => Boolean(x && x.length > 0))
    ),
  ];
  const assignedAgentIds = [
    ...new Set(
      list
        .map((c) => (c.assigned_agent_id as string | null | undefined)?.trim())
        .filter((x): x is string => Boolean(x && x.length > 0))
    ),
  ];

  let queueNombreById: Record<string, string | null> = {};
  if (queueIds.length > 0) {
    try {
      const qq = quoteSchemaTable(sch, "chat_queues");
      const qr = await pool.query(
        `SELECT id::text, nombre::text FROM ${qq}
         WHERE empresa_id = $1::uuid AND id = ANY($2::uuid[])`,
        [empresa_id, queueIds]
      );
      queueNombreById = Object.fromEntries(
        (qr.rows ?? []).map((r: { id?: string; nombre?: string | null }) => [
          String(r.id ?? ""),
          r.nombre ?? null,
        ])
      );
    } catch {
      console.warn("[fetchChatConversations] chat_queues pg batch falló");
    }
  }

  let agentUsuarioById: Record<string, string> = {};
  if (assignedAgentIds.length > 0) {
    try {
      const aq = quoteSchemaTable(sch, "chat_agents");
      const ar = await pool.query(
        `SELECT id::text, usuario_id::text FROM ${aq}
         WHERE empresa_id = $1::uuid AND id = ANY($2::uuid[])`,
        [empresa_id, assignedAgentIds]
      );
      agentUsuarioById = Object.fromEntries(
        (ar.rows ?? []).map((r: { id?: string; usuario_id?: string }) => [
          String(r.id ?? ""),
          String(r.usuario_id ?? ""),
        ])
      );
    } catch {
      console.warn("[fetchChatConversations] chat_agents pg batch falló");
    }
  }

  const contactIds = [
    ...new Set(
      list
        .map((c) => (c.contact_id as string | null | undefined)?.trim())
        .filter((x): x is string => Boolean(x && x.length > 0))
    ),
  ];
  let byId: Record<string, Record<string, unknown>> = {};
  if (contactIds.length > 0) {
    try {
      const cq = quoteSchemaTable(sch, "chat_contacts");
      const cr = await pool.query(
        `SELECT id::text, name::text, phone_number::text, cliente_id::uuid, crm_prospecto_id::uuid
         FROM ${cq}
         WHERE empresa_id = $1::uuid AND id = ANY($2::uuid[])`,
        [empresa_id, contactIds]
      );
      byId = Object.fromEntries((cr.rows ?? []).map((c) => [String(c.id), c as Record<string, unknown>]));
    } catch {
      console.warn("[fetchChatConversations] chat_contacts pg batch falló");
    }
  }

  const agentUserIds = [
    ...new Set(
      list
        .map((row) => {
          const aid = (row.assigned_agent_id as string | null | undefined)?.trim();
          const uid = aid ? agentUsuarioById[aid] : undefined;
          return uid;
        })
        .filter(Boolean) as string[]
    ),
  ];

  let usuarioNombreById: Record<string, { nombre: string | null; email: string | null }> = {};
  if (agentUserIds.length > 0) {
    const { data: urows, error: uErr } = await catalogSr
      .from("usuarios")
      .select("id, nombre, email")
      .in("id", agentUserIds);
    if (uErr) {
      console.warn("[fetchChatConversations] usuarios (catálogo):", uErr.message);
    } else {
      usuarioNombreById = Object.fromEntries(
        (urows ?? []).map((u) => [
          u.id as string,
          {
            nombre: (u as { nombre?: string | null }).nombre ?? null,
            email: (u as { email?: string | null }).email ?? null,
          },
        ])
      );
    }
  }

  const priorityFallback = (row: Record<string, unknown>): string =>
    row.priority != null && String(row.priority).trim() !== ""
      ? String(row.priority)
      : "medium";

  const mapped = list.map((row) => {
    const c = byId[row.contact_id as string] as
      | {
          id?: string;
          name?: string | null;
          phone_number?: string;
          cliente_id?: string | null;
          crm_prospecto_id?: string | null;
        }
      | undefined;
    const cid = (row.channel_id as string | null | undefined)?.trim() ?? "";
    const chMeta = cid ? channelById[cid] : undefined;
    const channelId = cid;
    const channelType = chMeta?.type ?? "whatsapp";
    const channelNombre = chMeta?.nombre ?? null;
    const compValEnabled = chMeta?.comprobante_validation_enabled ?? false;
    const qrInboxEnabled = chMeta?.quick_replies_inbox_enabled !== false;
    const qid = (row.queue_id as string | null | undefined)?.trim() || null;
    const qRowNombre = qid ? queueNombreById[qid] : null;
    const waitCode = ((row as { assignment_wait_code?: string | null }).assignment_wait_code ?? null) as string | null;
    const aid = (row.assigned_agent_id as string | null | undefined)?.trim();
    const uid = aid ? agentUsuarioById[aid] : undefined;
    const uMeta = uid ? usuarioNombreById[uid] : undefined;
    const assignedName =
      (uMeta?.nombre?.trim() || uMeta?.email?.trim() || null) as string | null;
    const rid = String(row.id ?? "").trim();
    return {
      id: rid,
      status: row.status as string,
      priority: priorityFallback(row),
      queue_id: (row.queue_id as string | null) ?? null,
      queue_name: qRowNombre ?? null,
      assignment_wait_code: typeof waitCode === "string" && waitCode.trim() ? waitCode.trim() : null,
      assigned_agent_id: (row.assigned_agent_id as string | null) ?? null,
      assigned_agent_name: assignedName,
      last_message_at: isoPg(row.last_message_at),
      last_message_preview: (row.last_message_preview as string | null) ?? null,
      unread_count: Number(row.unread_count ?? 0) || 0,
      flow_status: String((row as { flow_status?: string | null }).flow_status ?? ""),
      human_taken_over: Boolean(row.human_taken_over),
      flow_code: (() => {
        const f = String((row as { flow_code?: string | null }).flow_code ?? "").trim();
        return f || null;
      })(),
      flow_current_node: (() => {
        const n = String((row as { flow_current_node?: string | null }).flow_current_node ?? "").trim();
        return n || null;
      })(),
      channel: {
        id: channelId,
        type: normalizeChannelType(channelType),
        nombre: channelNombre,
        comprobante_validation_enabled: compValEnabled,
        quick_replies_inbox_enabled: qrInboxEnabled,
      },
      contact: {
        id: c?.id ?? (row.contact_id as string),
        name: c?.name ?? null,
        phone_number: c?.phone_number ?? "",
        cliente_id: c?.cliente_id != null ? String(c.cliente_id) : null,
        crm_prospecto_id: c?.crm_prospecto_id != null ? String(c.crm_prospecto_id) : null,
      },
      awaiting_agent_reply_since: awaitingById[rid] ?? null,
      awaiting_client_reply_since: clientTurnById[rid] ?? null,
    };
  });
  return { conversations: mapped as InboxConversation[], base_row_count: totalAfterQuery };
}
