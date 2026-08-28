"use server";

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
  loadActiveFlowSessionsByConversationForInboxList,
} from "@/lib/chat/inbox-list-flow-sessions";
import { parseComprobanteValidationConfig, type ComprobanteValidacionListRow } from "@/lib/chat/comprobante-validation-types";
import {
  applyBotWakeKeywordsInputToChannelConfig,
  type BotWakeKeywordsMatchMode,
} from "@/lib/chat/bot-wake-keywords";
import {
  approveComprobanteAndCloseSorteoPurchase,
  type ManualSorteoApprovalResult,
} from "@/lib/chat/sorteo-manual-approval-service";
import { requireEmpresaTenantServiceRole } from "@/lib/chat/empresa-tenant-service-role";
import { isMissingColumnError } from "@/lib/chat/postgres-column-error";
import { logChatListClassificationInvariant } from "@/lib/chat/chat-list-classification-invariant";
import {
  appendOmnicanalConversationScopeToQuery,
  getOmnicanalScope,
  isOmnicanalAdminScope,
  OMNICANAL_IMPOSSIBLE_CONVERSATION_ID,
  resolveQueueIdsForUsuarios,
  shouldBypassOmnicanalConversationScope,
} from "@/lib/chat/omnicanal-scope";
import { ensureCentralChatChannelMirror } from "@/lib/chat/central-chat-channel-mirror";
import {
  deleteOmnichannelRouteByMetaPhone,
  syncOmnichannelRouteForWhatsappChannel,
} from "@/lib/chat/omnichannel-route-sync";
import { SUPABASE_APP_SCHEMA, type AppSupabaseClient } from "@/lib/supabase/schema";
import {
  getChatPostgresPool,
  isPgPoolExhaustionMessage,
  logPgPoolStats,
  quoteSchemaTable,
} from "@/lib/supabase/chat-pg-pool";
import { isLikelyUnexposedTenantChatSchema } from "@/lib/supabase/chat-data-schema";
import { toNationalPhoneDigits } from "@/lib/telefono";
import {
  pgDeleteChatChannel,
  pgInsertChatChannelMetaWhatsapp,
  pgInsertGenericOmnichannelChannel,
  pgInsertYCloudWhatsappChannel,
  pgSelectChatChannelConfig,
  pgSelectChatChannelMetaPrev,
  pgUpdateChatChannelConfig,
  pgUpdateChatChannelMetaWhatsapp,
  pgUpdateGenericOmnichannelChannel,
  pgUpdateYCloudWhatsappChannel,
} from "@/lib/chat/chat-channels-mutate-pg";

async function mirrorTenantChatChannelToCentralCatalog(
  dataSchema: string,
  empresaId: string,
  channelId: string
): Promise<void> {
  if (dataSchema.trim() === SUPABASE_APP_SCHEMA) return;
  await ensureCentralChatChannelMirror({
    pool: getChatPostgresPool(),
    tenantDataSchema: dataSchema,
    empresaId,
    channelId,
  });
}
import { pgMarkConversationUnreadZero, pgReleaseConversationToBot } from "@/lib/chat/chat-send-persist-pg";
import { isInvalidPostgrestSchemaError } from "@/lib/chat/postgrest-schema-error";
import { normalizeChannelType } from "@/lib/chat/channel-type-utils";
import { fetchChatConversationsFromTenantPg } from "@/lib/chat/chat-inbox-fetch-pg";
import { withInboxLatencyMeasure } from "@/lib/chat/inbox-observability";
import {
  pgConversationBelongsToEmpresa,
  pgFetchComprobanteValidacionesForConversation,
} from "@/lib/chat/chat-comprobante-validacion-pg";

export type ConversacionesVista = "inbox" | "bot" | "historial";

export type ChatInboxAssignmentFilter = "all" | "mine" | "unassigned";

export type ChatInboxFilters = {
  assignment?: ChatInboxAssignmentFilter;
  queue_id?: string | null;
  status?: string | null;
  priority?: string | null;
  /** Filtro opcional por `chat_conversations.channel_id` (UUID). */
  channel_id?: string | null;
  /**
   * Búsqueda server-side por teléfono/nombre del contacto. Sin esto el buscador sólo filtra la
   * página cargada (tope PostgREST ~1000), así que conversaciones fuera de esa ventana no se
   * encuentran. Con `search`, el fetch resuelve los `contact_id` que matchean y trae SOLO esas
   * conversaciones, sin importar cuán viejas sean.
   */
  search?: string | null;
};

export type InboxConversation = {
  id: string;
  status: string;
  priority: string;
  queue_id: string | null;
  queue_name: string | null;
  /** manual_queue | no_eligible_agent cuando queda en cola sin agente; null si hay agente o no aplica. */
  assignment_wait_code: string | null;
  assigned_agent_id: string | null;
  assigned_agent_name: string | null;
  last_message_at: string | null;
  last_message_preview: string | null;
  unread_count: number;
  flow_status: string;
  human_taken_over: boolean;
  /**
   * Último mensaje del contacto sin respuesta humana posterior (RPC `neura_inbox_awaiting_reply_since_batch`).
   * null si no aplica o si el RPC no está desplegado.
   */
  awaiting_agent_reply_since: string | null;
  /**
   * Último mensaje del hilo es saliente (empresa) y no aplica `awaiting_agent_reply_since` (turno del contacto).
   * Requiere migración con columna `client_turn_since` en el mismo RPC.
   */
  awaiting_client_reply_since: string | null;
  /** Flujo asignado (`chat_conversations.flow_code`), si existe. */
  flow_code: string | null;
  /** Nodo actual del motor (`chat_conversations.flow_current_node`), si existe. */
  flow_current_node: string | null;
  channel: {
    id: string;
    type: string;
    nombre: string | null;
    /** Si el canal tiene activada la validación inteligente de comprobantes (UI inbox). */
    comprobante_validation_enabled: boolean;
    /** Respuestas rápidas en inbox (`config.quick_replies_inbox_enabled`, default true). */
    quick_replies_inbox_enabled: boolean;
  };
  contact: {
    id: string;
    name: string | null;
    phone_number: string;
    cliente_id: string | null;
    crm_prospecto_id: string | null;
  };
};

export type ChatConversationsFetchResult = {
  conversations: InboxConversation[];
  /** Filas que devolvió la query base antes del split Inbox/Bot (o cerradas en historial). */
  base_row_count: number;
  /**
   * El listado principal no pudo leerse (p. ej. pool PG agotado). El cliente puede conservar datos previos en refetch silencioso.
   */
  transient_list_error?: boolean;
};

/**
 * Último mensaje por conversación (respaldo si el RPC de turnos falla o no está desplegado).
 * Una subconsulta por id en paralelo por lotes, para no mezclar límites entre conversaciones.
 */
async function mapLastMessageByConversation(
  supabase: AppSupabaseClient,
  empresaId: string,
  convIds: string[]
): Promise<Record<string, { created_at: string; from_me: boolean }>> {
  if (convIds.length === 0) return {};
  const unique = [...new Set(convIds.map((x) => x.trim()).filter(Boolean))];
  const out: Record<string, { created_at: string; from_me: boolean }> = {};
  const batchSize = 30;
  for (let i = 0; i < unique.length; i += batchSize) {
    const batch = unique.slice(i, i + batchSize);
    await Promise.all(
      batch.map(async (cid) => {
        const { data, error } = await supabase
          .from("chat_messages")
          .select("conversation_id, created_at, from_me")
          .eq("empresa_id", empresaId)
          .eq("conversation_id", cid)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (error) {
          console.warn("[fetchChatConversations] último mensaje conv", cid, error.message);
          return;
        }
        if (!data) return;
        const created_at = String((data as { created_at?: string }).created_at ?? "").trim();
        if (!created_at) return;
        out[cid] = {
          created_at,
          from_me: Boolean((data as { from_me?: boolean }).from_me),
        };
      })
    );
  }
  return out;
}

export async function fetchChatConversations(
  vista: ConversacionesVista = "inbox",
  filters?: ChatInboxFilters
): Promise<ChatConversationsFetchResult> {
  /**
   * La ruta PostgREST lanzaba ante cualquier error (query base con timeout bajo carga, RPC ausente,
   * alcance omnicanal, etc.). En un tenant con decenas de miles de conversaciones open/pending
   * (p. ej. elpapustore), ese throw crasheaba la lista del inbox con el error genérico de
   * "Server Components render" en producción. Igualamos el comportamiento de la ruta `tenant_pg`:
   * degradamos suave a `transient_list_error` para que el cliente conserve la vista previa y muestre
   * un aviso en lugar de romperse. El error real queda logueado para diagnóstico.
   */
  try {
    return await fetchChatConversationsUnsafe(vista, filters);
  } catch (e) {
    console.error("[fetchChatConversations] fallo no controlado; degradando a transient_list_error", {
      vista,
      assignment: filters?.assignment ?? null,
      has_search: Boolean(filters?.search?.trim()),
      error: e instanceof Error ? e.message : String(e),
      stack: e instanceof Error ? e.stack?.split("\n").slice(0, 4).join(" | ") : undefined,
    });
    return { conversations: [], base_row_count: 0, transient_list_error: true };
  }
}

type BotTabClassifyCtx = {
  activeFlowCodeSet: Set<string>;
  sessionById: Map<string, FlowSessionRowMin>;
  activeSessionByConversationId: Map<string, FlowSessionRowMin>;
};

async function logBotTabClassificationSamplePostgrest(
  supabase: AppSupabaseClient,
  empresa_id: string,
  vista: ConversacionesVista,
  listBeforeSplit: Record<string, unknown>[],
  botLikeCount: number,
  activeSessionsSize: number,
  classifyCtx: BotTabClassifyCtx,
  activeFlowCatalogRowCount: number
): Promise<void> {
  if (vista !== "bot" || botLikeCount > 0 || activeSessionsSize === 0) return;

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
    const { data: chRows, error: chErr } = await supabase
      .from("chat_channels")
      .select("id, type, nombre")
      .eq("empresa_id", empresa_id)
      .in("id", chIds);
    if (chErr) {
      console.warn("[chat-list][classification-sample] chat_channels:", chErr.message);
    } else {
      for (const r of chRows ?? []) {
        const row = r as { id?: string; type?: string; nombre?: string | null };
        const id = String(row.id ?? "").trim();
        if (!id) continue;
        chById[id] = { type: String(row.type ?? "").trim() || "unknown", nombre: row.nombre ?? null };
      }
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

/** UUID imposible para forzar 0 resultados cuando la búsqueda no matcheó ningún contacto. */
const IMPOSSIBLE_CONTACT_ID = "00000000-0000-0000-0000-000000000000";
const CONTACT_SEARCH_ID_LIMIT = 500;

/**
 * Resuelve los `contact_id` cuyo teléfono o nombre matchean la búsqueda (path PostgREST).
 * - Teléfono: compara por número nacional significativo (sin `595` ni `0`) como substring, así
 *   encuentra el contacto tenga el guardado en formato local o internacional.
 * - Nombre: `ilike` cuando el término contiene letras.
 * Devuelve `[]` si no matchea nada (el llamador lo trata como "sin resultados").
 */
async function resolveContactIdsForSearchPostgrest(
  supabase: AppSupabaseClient,
  empresaId: string,
  rawTerm: string
): Promise<string[]> {
  const term = rawTerm.trim();
  const nat = toNationalPhoneDigits(term);
  const ids = new Set<string>();

  if (nat.length >= 3) {
    const { data, error } = await supabase
      .from("chat_contacts")
      .select("id")
      .eq("empresa_id", empresaId)
      .ilike("phone_number", `%${nat}%`)
      .limit(CONTACT_SEARCH_ID_LIMIT);
    if (error) {
      console.warn("[fetchChatConversations] búsqueda contactos por teléfono:", error.message);
    } else {
      for (const r of data ?? []) {
        const id = String((r as { id?: string }).id ?? "").trim();
        if (id) ids.add(id);
      }
    }
  }

  if (term.length >= 3 && /[a-zA-Z]/.test(term)) {
    const { data, error } = await supabase
      .from("chat_contacts")
      .select("id")
      .eq("empresa_id", empresaId)
      .ilike("name", `%${term}%`)
      .limit(CONTACT_SEARCH_ID_LIMIT);
    if (error) {
      console.warn("[fetchChatConversations] búsqueda contactos por nombre:", error.message);
    } else {
      for (const r of data ?? []) {
        const id = String((r as { id?: string }).id ?? "").trim();
        if (id) ids.add(id);
      }
    }
  }

  return [...ids];
}

async function fetchChatConversationsUnsafe(
  vista: ConversacionesVista = "inbox",
  filters?: ChatInboxFilters
): Promise<ChatConversationsFetchResult> {
  const { supabase, catalogSr, empresa_id, usuario_id, dataSchema } = await requireEmpresaTenantServiceRole();

  const poolInbox = getChatPostgresPool();
  const useTenantPg = Boolean(poolInbox && isLikelyUnexposedTenantChatSchema(dataSchema));
  const scopeLog = await getOmnicanalScope(supabase, empresa_id, usuario_id, {
    tenantDataSchema: dataSchema,
  });
  const bypassLog = await shouldBypassOmnicanalConversationScope(catalogSr, usuario_id, scopeLog);
  const ts = new Date().toISOString();
  console.info("[chat-list][fetch-start]", {
    vista,
    schema: dataSchema,
    empresa_id,
    source: useTenantPg ? "tenant_pg" : "postgrest",
    timestamp: ts,
  });
  console.info("[chat-list][scope]", {
    schema: dataSchema,
    empresa_id,
    bypass: bypassLog,
    role: scopeLog.role,
    queue_ids_len: scopeLog.queueIds.length,
    agent_usuario_ids_len: scopeLog.agentUsuarioIds.length,
    is_admin_scope: isOmnicanalAdminScope(scopeLog),
    timestamp: ts,
  });
  console.info("[chat-list][filters]", {
    vista,
    assignment: filters?.assignment ?? "all",
    queue_id: filters?.queue_id ?? null,
    channel_id: filters?.channel_id ?? null,
    status: filters?.status ?? null,
    priority: filters?.priority ?? null,
    timestamp: ts,
  });

  if (poolInbox && isLikelyUnexposedTenantChatSchema(dataSchema)) {
    /**
     * Observabilidad: `withInboxLatencyMeasure` mide la duración del fetch.
     * Es no-op si `CHAT_INBOX_OBSERVABILITY` no está activo, así que el
     * comportamiento productivo actual queda intacto. El `logPgPoolStats`
     * posterior emite snapshot del pool solo cuando el flag está activo.
     */
    const result = await withInboxLatencyMeasure(
      "fetchChatConversationsFromTenantPg",
      () =>
        fetchChatConversationsFromTenantPg(poolInbox, dataSchema, vista, filters, {
          supabase,
          catalogSr,
          empresa_id,
          usuario_id,
        }),
      { schema: dataSchema, vista },
    );
    if (process.env.CHAT_INBOX_OBSERVABILITY?.trim().toLowerCase() === "true") {
      logPgPoolStats("inbox_list_after_fetch", poolInbox, { schema: dataSchema, vista });
    }
    return result;
  }

  const { data: activeFlowRows, error: activeFlowsErr } = await supabase
    .from("chat_flows")
    .select("id, flow_code, label")
    .eq("empresa_id", empresa_id)
    .eq("activo", true);
  if (activeFlowsErr) {
    console.warn("[fetchChatConversations] chat_flows activos:", activeFlowsErr.message);
  }
  const activeFlowCodeSet = buildActiveFlowMatchSet(activeFlowRows ?? []);
  const activeFlowCatalogRowCount = (activeFlowRows ?? []).length;

  /**
   * ¿El tenant usa ruteo humano (colas)? Si NO tiene colas, la separación Inbox/Bot no le aplica:
   * casi todas sus conversaciones son del bot y el Inbox quedaría vacío. En ese caso el Inbox
   * muestra TODAS las conversaciones abiertas (el Bot sigue mostrando sólo las del flujo bot).
   */
  let tenantUsesHumanRouting = false;
  try {
    const { count: queueCount, error: queueErr } = await supabase
      .from("chat_queues")
      .select("id", { count: "exact", head: true })
      .eq("empresa_id", empresa_id);
    if (!queueErr) tenantUsesHumanRouting = (queueCount ?? 0) > 0;
  } catch (e) {
    console.warn("[fetchChatConversations] chat_queues count:", e instanceof Error ? e.message : e);
  }

  if (vista === "bot" && activeFlowCatalogRowCount === 0) {
    return { conversations: [], base_row_count: 0 };
  }

  /**
   * Búsqueda server-side: si hay término (≥3), resolvemos los contactos que matchean y luego
   * filtramos las conversaciones por esos `contact_id`. Esto evita el tope ~1000 del listado
   * (sólo trae los pocos matches). Si no matchea ningún contacto, forzamos 0 resultados.
   */
  const searchTerm = (filters?.search ?? "").trim();
  let searchContactIds: string[] | null = null;
  if (searchTerm.length >= 3) {
    searchContactIds = await resolveContactIdsForSearchPostgrest(supabase, empresa_id, searchTerm);
    if (searchContactIds.length === 0) searchContactIds = [IMPOSSIBLE_CONTACT_ID];
  }

  /**
   * Sin embeds desde `chat_conversations`: en esquemas tenant PostgREST suele no tener en caché
   * las FKs hacia `chat_channels` / `chat_queues` / `chat_agents` y falla el select anidado.
   */
  const convSelectWithWait = `
      id,
      status,
      priority,
      queue_id,
      assignment_wait_code,
      assigned_agent_id,
      last_message_at,
      last_message_preview,
      unread_count,
      contact_id,
      channel_id,
      flow_code,
      flow_current_node,
      flow_status,
      human_taken_over,
      active_flow_session_id
    `;
  const convSelectLegacy = `
      id,
      status,
      priority,
      queue_id,
      assigned_agent_id,
      last_message_at,
      last_message_preview,
      unread_count,
      contact_id,
      channel_id,
      flow_code,
      flow_current_node,
      flow_status,
      human_taken_over,
      active_flow_session_id
    `;
  /** Sin `priority` ni `assignment_wait_code` (tenants desalineados). */
  const convSelectLegacyNoPriority = `
      id,
      status,
      queue_id,
      assigned_agent_id,
      last_message_at,
      last_message_preview,
      unread_count,
      contact_id,
      channel_id,
      flow_code,
      flow_current_node,
      flow_status,
      human_taken_over,
      active_flow_session_id
    `;

  /** Ver `appendOmnicanalConversationScopeToQuery`: el builder PostgREST no debe devolverse “crudo” desde async. */
  const buildFilteredConversationQuery = async (selectStr: string) => {
    let qb = supabase.from("chat_conversations").select(selectStr).eq("empresa_id", empresa_id);

    if (vista === "inbox" || vista === "bot") {
      /** Misma base abierta/pendiente; Inbox vs Bot se resuelve en memoria (`conversationBelongsToBotTab`). */
      qb = qb.in("status", ["open", "pending"]);
    } else if (vista === "historial") {
      qb = qb.eq("status", "closed");
    }

    /** Búsqueda server-side por contacto: restringe a las conversaciones de los contactos que matchean. */
    if (searchContactIds) {
      qb = qb.in("contact_id", searchContactIds);
    }

    const scope = await getOmnicanalScope(supabase, empresa_id, usuario_id, {
      tenantDataSchema: dataSchema,
    });
    const bypass = await shouldBypassOmnicanalConversationScope(catalogSr, usuario_id, scope);
    try {
      if (!bypass) {
        const { builder } = await appendOmnicanalConversationScopeToQuery(
          supabase,
          empresa_id,
          scope,
          qb,
          undefined,
          dataSchema
        );
        qb = builder;
      }
    } catch (e) {
      console.error("[fetchChatConversations] alcance omnicanal omitido:", e);
    }

    const assignment = filters?.assignment ?? "all";
    if (assignment === "mine") {
      let myAgents: { id: string }[] | null = null;
      let maErr = null as { message: string } | null;
      let r = await supabase
        .from("chat_agents")
        .select("id")
        .eq("empresa_id", empresa_id)
        .eq("usuario_id", usuario_id)
        .eq("is_active", true);
      if (r.error && isMissingColumnError(r.error.message, "is_active")) {
        r = await supabase
          .from("chat_agents")
          .select("id")
          .eq("empresa_id", empresa_id)
          .eq("usuario_id", usuario_id);
      }
      myAgents = r.data as { id: string }[] | null;
      maErr = r.error;
      if (maErr) {
        console.warn(
          "[fetchChatConversations] no se pudo cargar chat_agents para filtro «mios»; se listan todas:",
          maErr.message
        );
      } else {
        const ids = (myAgents ?? []).map((row) => row.id as string);
        if (ids.length > 0) {
          qb = qb.in("assigned_agent_id", ids);
        } else {
          console.warn(
            "[fetchChatConversations] filtro «mios» sin filas en chat_agents para el usuario; se listan todas las conversaciones"
          );
        }
      }
    } else if (assignment === "unassigned") {
      qb = qb.is("assigned_agent_id", null);
    }

    const fq = filters?.queue_id?.trim();
    if (fq) {
      let queueOk = true;
      if (!bypass && !isOmnicanalAdminScope(scope)) {
        const allowedQueues = await resolveQueueIdsForUsuarios(
          supabase,
          empresa_id,
          scope.agentUsuarioIds,
          dataSchema
        );
        queueOk = allowedQueues.includes(fq);
      }
      qb = queueOk ? qb.eq("queue_id", fq) : qb.eq("id", OMNICANAL_IMPOSSIBLE_CONVERSATION_ID);
    }

    const fs = filters?.status?.trim().toLowerCase();
    if (fs && ["open", "pending", "closed"].includes(fs)) {
      qb = qb.eq("status", fs);
    }

    const fp = filters?.priority?.trim().toLowerCase();
    if (fp && ["low", "medium", "high"].includes(fp)) {
      qb = qb.eq("priority", fp);
    }

    const fch = filters?.channel_id?.trim();
    if (fch) {
      qb = qb.eq("channel_id", fch);
    }

    return { builder: qb };
  };

  /* PostgREST: desempaquetar `.builder` — el builder es thenable y no puede devolverse solo desde async. */
  let q: any = (await buildFilteredConversationQuery(convSelectWithWait)).builder;
  let { data: convs, error } = await q.order("last_message_at", {
    ascending: false,
    nullsFirst: false,
  });

  if (error && isMissingColumnError(error.message, "assignment_wait_code")) {
    console.warn("[fetchChatConversations] assignment_wait_code ausente; reintento sin columna");
    q = (await buildFilteredConversationQuery(convSelectLegacy)).builder;
    ({ data: convs, error } = await q.order("last_message_at", {
      ascending: false,
      nullsFirst: false,
    }));
  }

  if (error) {
    console.warn("[fetchChatConversations] reintento select mínimo sin priority ni assignment_wait_code");
    q = (await buildFilteredConversationQuery(convSelectLegacyNoPriority)).builder;
    ({ data: convs, error } = await q.order("last_message_at", {
      ascending: false,
      nullsFirst: false,
    }));
  }

  if (error) {
    console.warn("[fetchChatConversations] listado conversaciones no disponible:", error.message);
    throw new Error(`[fetchChatConversations] listado conversaciones: ${error.message}`);
  }
  let list = (convs ?? []) as Record<string, unknown>[];
  const totalAfterQuery = list.length;
  console.info("[chat-list][fetch-result]", {
    source: "postgrest",
    schema: dataSchema,
    empresa_id,
    total_fetched: totalAfterQuery,
    timestamp: new Date().toISOString(),
  });

  const sessionIds = [
    ...new Set(
      list
        .map((row: Record<string, unknown>) =>
          String((row as { active_flow_session_id?: string | null }).active_flow_session_id ?? "").trim()
        )
        .filter((id: string) => id.length > 0)
    ),
  ];
  const flowSessionById = new Map<string, FlowSessionRowMin>();
  const sessionChunk = 100;
  for (let i = 0; i < sessionIds.length; i += sessionChunk) {
    const chunk = sessionIds.slice(i, i + sessionChunk);
    const { data: sessRows, error: sessErr } = await supabase
      .from("chat_flow_sessions")
      .select("id, status, flow_code, conversation_id")
      .eq("empresa_id", empresa_id)
      .in("id", chunk);
    if (sessErr) {
      console.warn("[fetchChatConversations] chat_flow_sessions:", sessErr.message);
      continue;
    }
    for (const [k, v] of buildFlowSessionMap(sessRows as FlowSessionRowMin[]).entries()) {
      flowSessionById.set(k, v);
    }
  }

  const activeSessionByConversationId = await loadActiveFlowSessionsByConversationForInboxList(
    supabase,
    empresa_id,
    list,
    flowSessionById
  );

  if (
    String(process.env.CHAT_REPAIR_FLOW_SESSION_POINTERS ?? "")
      .trim()
      .toLowerCase() === "true"
  ) {
    for (const row of list) {
      const cid = String((row as { id?: unknown }).id ?? "").trim();
      const sess = activeSessionByConversationId.get(cid);
      const cur = String((row as { active_flow_session_id?: string | null }).active_flow_session_id ?? "").trim();
      if (sess && cur !== sess.id) {
        const { error: repErr } = await supabase
          .from("chat_conversations")
          .update({
            active_flow_session_id: sess.id,
            updated_at: new Date().toISOString(),
          })
          .eq("id", cid)
          .eq("empresa_id", empresa_id);
        if (!repErr) {
          (row as { active_flow_session_id?: string | null }).active_flow_session_id = sess.id;
        } else {
          console.warn("[chat-list] repair active_flow_session_id:", repErr.message);
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

  const isBotRow = (row: Record<string, unknown>) => conversationBelongsToBotTab(row, classifyCtx);

  let botLikeCount = 0;
  if (vista === "inbox") {
    botLikeCount = list.filter((row) => isBotRow(row as Record<string, unknown>)).length;
    /**
     * Con ruteo humano (colas): el Inbox excluye las del bot (van a la pestaña Bot).
     * Sin ruteo (tenant bot-céntrico como El Papu): NO excluir; el Inbox muestra todas,
     * si no quedaría vacío porque prácticamente todo está en flujo bot.
     */
    if (tenantUsesHumanRouting) {
      list = list.filter((row) => !isBotRow(row as Record<string, unknown>));
    } else {
      botLikeCount = 0;
    }
  } else if (vista === "bot") {
    list = list.filter((row) => isBotRow(row as Record<string, unknown>));
    botLikeCount = list.length;
  }

  console.info("[chat-list][classification]", {
    vista,
    empresa_id,
    schema: dataSchema,
    source: "postgrest",
    total_fetched: totalAfterQuery,
    after_tab_split: list.length,
    bot_like_count: botLikeCount,
    active_flow_codes: activeFlowCatalogRowCount,
    active_flow_match_tokens: activeFlowCodeSet.size,
    session_map_size: flowSessionById.size,
    active_sessions_by_conversation: activeSessionByConversationId.size,
  });

  console.info("[chat-list][active-flows]", {
    schema: dataSchema,
    empresa_id,
    count: activeFlowCatalogRowCount,
    sample: (activeFlowRows ?? []).slice(0, 12).map((r) => {
      const row = r as { id?: string; flow_code?: string; label?: string | null; activo?: boolean };
      return {
        id: String(row.id ?? "").trim(),
        flow_code: String(row.flow_code ?? "").trim(),
        name: String(row.label ?? "").trim() || null,
        active: row.activo !== false,
      };
    }),
  });

  await logBotTabClassificationSamplePostgrest(
    supabase,
    empresa_id,
    vista,
    listBeforeBotTabSplit,
    botLikeCount,
    activeSessionByConversationId.size,
    classifyCtx,
    activeFlowCatalogRowCount
  );

  if (vista === "bot" && botLikeCount === 0 && activeSessionByConversationId.size > 0) {
    console.info("[chat-list][classification-reasons-summary]", {
      schema: dataSchema,
      empresa_id,
      counts: aggregateBotClassificationReasons(listBeforeBotTabSplit, classifyCtx),
    });
  }

  logChatListClassificationInvariant({
    vista,
    source: "postgrest",
    schema: dataSchema,
    empresa_id,
    totalAfterQuery,
    listAfterTabSplit: list,
    botTabCount: botLikeCount,
    baseRows: listBeforeBotTabSplit,
    classifyCtx,
  });

  if (vista === "inbox") {
    console.info("[chat-list][inbox]", {
      empresa_id,
      schema: dataSchema,
      total_fetched: totalAfterQuery,
      after_excluding_bot_tab: list.length,
      excluded_bot_like: botLikeCount,
    });
  } else if (vista === "bot") {
    console.info("[chat-list][bot]", {
      empresa_id,
      schema: dataSchema,
      total_fetched: totalAfterQuery,
      bot_tab_rows: list.length,
    });
  }

  if (rowsSnapshotForLogs.length > 0) {
    const contactIds = [
      ...new Set(
        rowsSnapshotForLogs
          .map((r) => String((r as { contact_id?: string | null }).contact_id ?? "").trim())
          .filter(Boolean)
      ),
    ];
    const contactById: Record<string, { name: string | null; phone_number: string | null }> = {};
    const cchunk = 80;
    for (let i = 0; i < contactIds.length; i += cchunk) {
      const part = contactIds.slice(i, i + cchunk);
      const { data: cRows } = await supabase
        .from("chat_contacts")
        .select("id, name, phone_number")
        .eq("empresa_id", empresa_id)
        .in("id", part);
      for (const c of cRows ?? []) {
        const cr = c as { id?: string; name?: string | null; phone_number?: string | null };
        const id = String(cr.id ?? "").trim();
        if (!id) continue;
        contactById[id] = { name: cr.name ?? null, phone_number: cr.phone_number ?? null };
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

  const convIdList = list.map((row) => String((row as { id?: unknown }).id ?? "").trim()).filter(Boolean);
  const awaitingById: Record<string, string | null> = {};
  const clientTurnById: Record<string, string | null> = {};
  if (convIdList.length > 0) {
    try {
      const { data: rpcRows, error: rpcErr } = await catalogSr.rpc("neura_inbox_awaiting_reply_since_batch", {
        p_schema: dataSchema,
        p_empresa_id: empresa_id,
        p_conversation_ids: convIdList,
      });
      if (rpcErr) {
        console.warn("[fetchChatConversations] awaiting_reply RPC:", rpcErr.message);
      } else if (Array.isArray(rpcRows)) {
        for (const r of rpcRows as {
          conversation_id?: string;
          awaiting_since?: string | null;
          client_turn_since?: string | null;
        }[]) {
          const id = String(r.conversation_id ?? "").trim();
          if (!id) continue;
          awaitingById[id] = r.awaiting_since ?? null;
          clientTurnById[id] = (r as { client_turn_since?: string | null }).client_turn_since ?? null;
        }
      }
    } catch (e) {
      console.warn("[fetchChatConversations] awaiting_reply RPC:", e instanceof Error ? e.message : e);
    }
    const lastByConv = await mapLastMessageByConversation(supabase, empresa_id, convIdList);
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
    const { data: chrows, error: chErr } = await supabase
      .from("chat_channels")
      .select("id, type, nombre, config")
      .eq("empresa_id", empresa_id)
      .in("id", channelIds);
    if (chErr) {
      console.warn("[fetchChatConversations] chat_channels:", chErr.message);
    } else {
      channelById = Object.fromEntries(
        (chrows ?? []).map((r) => {
          const rec = r as {
            id: string;
            type?: string | null;
            nombre?: string | null;
            config?: unknown;
          };
          const cfg = rec.config;
          const compOn =
            cfg && typeof cfg === "object" && !Array.isArray(cfg)
              ? parseComprobanteValidationConfig(cfg as Record<string, unknown>).enabled
              : false;
          const qrOn =
            cfg && typeof cfg === "object" && !Array.isArray(cfg)
              ? (cfg as Record<string, unknown>).quick_replies_inbox_enabled !== false
              : true;
          return [
            rec.id,
            {
              type: (rec.type as string) ?? "whatsapp",
              nombre: rec.nombre ?? null,
              comprobante_validation_enabled: compOn,
              quick_replies_inbox_enabled: qrOn,
            },
          ];
        })
      );
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
    const { data: qrows, error: qErr } = await supabase
      .from("chat_queues")
      .select("id, nombre")
      .eq("empresa_id", empresa_id)
      .in("id", queueIds);
    if (qErr) {
      console.warn("[fetchChatConversations] chat_queues:", qErr.message);
    } else {
      queueNombreById = Object.fromEntries(
        (qrows ?? []).map((r) => [r.id as string, (r as { nombre?: string | null }).nombre ?? null])
      );
    }
  }

  let agentUsuarioById: Record<string, string> = {};
  if (assignedAgentIds.length > 0) {
    const { data: arows, error: aErr } = await supabase
      .from("chat_agents")
      .select("id, usuario_id")
      .eq("empresa_id", empresa_id)
      .in("id", assignedAgentIds);
    if (aErr) {
      console.warn("[fetchChatConversations] chat_agents (enriquecido):", aErr.message);
    } else {
      agentUsuarioById = Object.fromEntries(
        (arows ?? []).map((r) => [r.id as string, (r as { usuario_id: string }).usuario_id])
      );
    }
  }

  const contactIds = [
    ...new Set(
      list
        .map((c) => (c.contact_id as string | null | undefined)?.trim())
        .filter((x): x is string => Boolean(x && x.length > 0))
    ),
  ];
  const byId: Record<string, Record<string, unknown>> = {};
  if (contactIds.length > 0) {
    const cchunk = 80;
    for (let i = 0; i < contactIds.length; i += cchunk) {
      const part = contactIds.slice(i, i + cchunk);
      const { data: contacts, error: e2 } = await supabase
        .from("chat_contacts")
        .select("id, name, phone_number, cliente_id, crm_prospecto_id")
        .eq("empresa_id", empresa_id)
        .in("id", part);
      if (e2) {
        console.warn("[fetchChatConversations] chat_contacts:", e2.message, {
          chunk_index: i,
          chunk_size: part.length,
        });
        continue;
      }
      for (const c of contacts ?? []) {
        byId[c.id as string] = c as Record<string, unknown>;
      }
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

  const mapped = list.map((row) => {
    const c = byId[row.contact_id as string] as
      | { id?: string; name?: string | null; phone_number?: string; cliente_id?: string | null; crm_prospecto_id?: string | null }
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
    const waitCode = ((row as { assignment_wait_code?: string | null }).assignment_wait_code ?? null) as
      | string
      | null;
    const aid = (row.assigned_agent_id as string | null | undefined)?.trim();
    const uid = aid ? agentUsuarioById[aid] : undefined;
    const uMeta = uid ? usuarioNombreById[uid] : undefined;
    const assignedName =
      (uMeta?.nombre?.trim() || uMeta?.email?.trim() || null) as string | null;
    return {
      id: row.id as string,
      status: row.status as string,
      priority: (row.priority as string) ?? "medium",
      queue_id: (row.queue_id as string | null) ?? null,
      queue_name: qRowNombre ?? null,
      assignment_wait_code: typeof waitCode === "string" && waitCode.trim() ? waitCode.trim() : null,
      assigned_agent_id: (row.assigned_agent_id as string | null) ?? null,
      assigned_agent_name: assignedName,
      last_message_at: row.last_message_at as string | null,
      last_message_preview: row.last_message_preview as string | null,
      unread_count: (row.unread_count as number) ?? 0,
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
        type: channelType,
        nombre: channelNombre,
        comprobante_validation_enabled: compValEnabled,
        quick_replies_inbox_enabled: qrInboxEnabled,
      },
      contact: {
        id: c?.id ?? (row.contact_id as string),
        name: c?.name ?? null,
        phone_number: c?.phone_number ?? "",
        cliente_id: c?.cliente_id ?? null,
        crm_prospecto_id: c?.crm_prospecto_id ?? null,
      },
      awaiting_agent_reply_since: awaitingById[row.id as string] ?? null,
      awaiting_client_reply_since: clientTurnById[row.id as string] ?? null,
    };
  });
  return { conversations: mapped, base_row_count: totalAfterQuery };
}

/** True si la empresa tiene al menos un flujo de chat activo (tab Bot en inbox). */
export async function hasEmpresaActiveChatFlows(): Promise<boolean> {
  const { supabase, empresa_id, dataSchema } = await requireEmpresaTenantServiceRole();
  const pool = getChatPostgresPool();
  if (pool && isLikelyUnexposedTenantChatSchema(dataSchema)) {
    try {
      const r = await pool.query(
        `SELECT 1 AS one
         FROM ${quoteSchemaTable(dataSchema, "chat_flows")}
         WHERE empresa_id = $1::uuid AND COALESCE(activo, false) = true
         LIMIT 1`,
        [empresa_id]
      );
      return (r.rowCount ?? 0) > 0;
    } catch {
      return false;
    }
  }
  const { count, error } = await supabase
    .from("chat_flows")
    .select("id", { count: "exact", head: true })
    .eq("empresa_id", empresa_id)
    .eq("activo", true);
  if (error) return false;
  return (count ?? 0) > 0;
}

/**
 * Vuelve a modo bot (solo operador). No reinicia el flujo ni la sesión.
 */
export async function releaseConversationToBot(conversationId: string): Promise<void> {
  const { supabase, empresa_id, dataSchema } = await requireEmpresaTenantServiceRole();
  const id = conversationId.trim();
  if (!id) throw new Error("ID inválido");

  const pool = getChatPostgresPool();
  if (pool && isLikelyUnexposedTenantChatSchema(dataSchema)) {
    await pgReleaseConversationToBot(pool, dataSchema, empresa_id, id);
    return;
  }

  const { error } = await supabase
    .from("chat_conversations")
    .update({
      human_taken_over: false,
      flow_status: "bot",
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("empresa_id", empresa_id);

  if (error) throw new Error(error.message);
}

export async function markConversationRead(conversationId: string): Promise<void> {
  const { supabase, empresa_id, dataSchema } = await requireEmpresaTenantServiceRole();
  const pool = getChatPostgresPool();
  if (pool && isLikelyUnexposedTenantChatSchema(dataSchema)) {
    await pgMarkConversationUnreadZero(pool, dataSchema, empresa_id, conversationId.trim());
    return;
  }

  const { error } = await supabase
    .from("chat_conversations")
    .update({ unread_count: 0, updated_at: new Date().toISOString() })
    .eq("id", conversationId)
    .eq("empresa_id", empresa_id);

  if (error) throw new Error(error.message);
}

export type ChatChannelRow = {
  id: string;
  empresa_id: string;
  type: string;
  meta_phone_number_id: string | null;
  nombre: string | null;
  provider: string;
  provider_channel_id: string | null;
  activo: boolean;
  connection_mode: string | null;
  config_status: string;
  config: Record<string, unknown>;
  created_at: string;
  updated_at?: string;
  /** Sin exponer secretos; solo presente cuando el servidor puede calcularlo (p. ej. Postgres). */
  meta_access_token_present?: boolean | null;
  /** Presencia de API key YCloud en `config` sin exponer el valor. */
  ycloud_api_key_present?: boolean | null;
};

function isoFromPgOrJson(v: unknown): string {
  if (typeof v === "string") return v;
  if (v instanceof Date) return v.toISOString();
  return String(v ?? "");
}

function mapChatChannelRow(r: Record<string, unknown>): ChatChannelRow {
  const mp = r.meta_phone_number_id;
  const upd = r.updated_at;
  const metaTok = r.meta_access_token_present;
  const ycKey = r.ycloud_api_key_present;
  const rawId = r.id;
  const idStr = typeof rawId === "string" ? rawId.trim() : rawId != null ? String(rawId).trim() : "";
  return {
    id: idStr,
    empresa_id: r.empresa_id as string,
    type: normalizeChannelType(r.type),
    meta_phone_number_id: typeof mp === "string" ? mp : mp != null ? String(mp) : null,
    nombre: (r.nombre as string) ?? null,
    provider: (r.provider as string) ?? "meta",
    provider_channel_id: (r.provider_channel_id as string) ?? null,
    activo: r.activo !== false,
    connection_mode: (r.connection_mode as string | null) ?? null,
    config_status: (r.config_status as string) ?? "incomplete",
    config: (typeof r.config === "object" && r.config !== null ? r.config : {}) as Record<string, unknown>,
    created_at: isoFromPgOrJson(r.created_at),
    meta_access_token_present:
      typeof metaTok === "boolean" ? metaTok : metaTok === null ? null : undefined,
    ycloud_api_key_present: typeof ycKey === "boolean" ? ycKey : ycKey === null ? null : undefined,
    updated_at:
      upd === null || upd === undefined
        ? undefined
        : typeof upd === "string"
          ? upd
          : upd instanceof Date
            ? upd.toISOString()
            : String(upd),
  };
}

const POSTGREST_TENANT_SCHEMA_HINT =
  "PostgREST no puede usar el schema de datos de esta empresa. Configurá SUPABASE_DB_URL o DIRECT_URL (pooler Postgres) en el entorno del servidor, o agregá el schema en Supabase → Settings → API → Exposed schemas.";

/** Dedupe + micro-cache canales por empresa/schema (reduce picos de conexiones PG en Omnicanal). */
const CHAT_CHANNELS_CACHE_TTL_MS = 4000;
const chatChannelsCache = new Map<string, { at: number; rows: ChatChannelRow[] }>();
const chatChannelsInflight = new Map<string, Promise<ChatChannelRow[]>>();

function chatChannelsCacheKey(empresaId: string, schema: string) {
  return `${schema}::${empresaId}`;
}

function postgrestMutationError(dataSchema: string, message: string): Error {
  if (isLikelyUnexposedTenantChatSchema(dataSchema) && isInvalidPostgrestSchemaError(message)) {
    return new Error(POSTGREST_TENANT_SCHEMA_HINT);
  }
  return new Error(message);
}

async function enrichChatChannelsSecretFlagsFromPg(
  dataSchema: string,
  empresaId: string,
  rows: ChatChannelRow[]
): Promise<void> {
  const pool = getChatPostgresPool();
  if (!pool || rows.length === 0) return;
  const qt = quoteSchemaTable(dataSchema, "chat_channels");
  try {
    const r = await pool.query(
      `
      SELECT id::text AS id,
        (LOWER(TRIM(COALESCE(provider::text, ''))) = 'meta'
          AND whatsapp_access_token IS NOT NULL
          AND LENGTH(TRIM(COALESCE(whatsapp_access_token, ''))) > 0) AS meta_access_token_present,
        (LOWER(TRIM(COALESCE(provider::text, ''))) = 'ycloud'
          AND COALESCE(TRIM(config->>'ycloud_api_key'), '') <> '') AS ycloud_api_key_present
      FROM ${qt}
      WHERE empresa_id = $1::uuid
    `,
      [empresaId]
    );
    const byId = new Map<string, { m: boolean; y: boolean }>();
    for (const row of r.rows ?? []) {
      const rec = row as Record<string, unknown>;
      byId.set(String(rec.id), {
        m: Boolean(rec.meta_access_token_present),
        y: Boolean(rec.ycloud_api_key_present),
      });
    }
    for (const row of rows) {
      const f = byId.get(row.id);
      if (f) {
        row.meta_access_token_present = f.m;
        row.ycloud_api_key_present = f.y;
      }
    }
  } catch {
    /* flags opcionales */
  }
}

async function tryFetchChatChannelsFromPg(
  dataSchema: string,
  empresaId: string
): Promise<ChatChannelRow[] | undefined> {
  const pool = getChatPostgresPool();
  if (!pool) return undefined;
  const qt = quoteSchemaTable(dataSchema, "chat_channels");
  const qFull = `
    SELECT id, empresa_id, type, meta_phone_number_id, nombre, provider, provider_channel_id,
           activo, connection_mode, config_status, config, created_at, updated_at,
           (LOWER(TRIM(COALESCE(provider::text, ''))) = 'meta'
             AND whatsapp_access_token IS NOT NULL
             AND LENGTH(TRIM(COALESCE(whatsapp_access_token, ''))) > 0) AS meta_access_token_present,
           (LOWER(TRIM(COALESCE(provider::text, ''))) = 'ycloud'
             AND COALESCE(TRIM(config->>'ycloud_api_key'), '') <> '') AS ycloud_api_key_present
    FROM ${qt}
    WHERE empresa_id = $1::uuid
    ORDER BY created_at ASC
  `;
  const qMinimal = `
    SELECT id, empresa_id, type, meta_phone_number_id, nombre, provider, provider_channel_id,
           activo, connection_mode, config_status, config, created_at, updated_at
    FROM ${qt}
    WHERE empresa_id = $1::uuid
    ORDER BY created_at ASC
  `;
  try {
    const r = await pool.query(qFull, [empresaId]);
    return (r.rows ?? []).map((row) => mapChatChannelRow(row as Record<string, unknown>));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[fetchChatChannels] pg_full_failed", {
      schema: dataSchema,
      empresa_id: empresaId,
      message: msg.slice(0, 300),
    });
    if (isPgPoolExhaustionMessage(msg)) {
      logPgPoolStats("tryFetchChatChannelsFromPg_full", pool, {
        schema: dataSchema,
        empresa_id: empresaId,
        caller: "tryFetchChatChannelsFromPg",
      });
      console.error("[fetchChatChannels][pg-pool-exhausted]", {
        schema: dataSchema,
        empresa_id: empresaId,
        stage: "full",
      });
      console.error("[chat-list][pg-pool-exhausted]", {
        schema: dataSchema,
        empresa_id: empresaId,
        surface: "channels",
        stage: "full",
      });
    }
    try {
      const r = await pool.query(qMinimal, [empresaId]);
      return (r.rows ?? []).map((row) => mapChatChannelRow(row as Record<string, unknown>));
    } catch (e2) {
      const msg2 = e2 instanceof Error ? e2.message : String(e2);
      console.error("[fetchChatChannels] pg_minimal_failed", {
        schema: dataSchema,
        empresa_id: empresaId,
        message: msg2.slice(0, 300),
      });
      if (isPgPoolExhaustionMessage(msg2)) {
        logPgPoolStats("tryFetchChatChannelsFromPg_minimal", pool, {
          schema: dataSchema,
          empresa_id: empresaId,
          caller: "tryFetchChatChannelsFromPg",
        });
        console.error("[fetchChatChannels][pg-pool-exhausted]", {
          schema: dataSchema,
          empresa_id: empresaId,
          stage: "minimal",
        });
        console.error("[chat-list][pg-pool-exhausted]", {
          schema: dataSchema,
          empresa_id: empresaId,
          surface: "channels",
          stage: "minimal",
        });
      }
      return undefined;
    }
  }
}

async function tryFetchChatChannelByIdFromPg(
  dataSchema: string,
  empresaId: string,
  channelId: string
): Promise<ChatChannelRow | null | undefined> {
  const pool = getChatPostgresPool();
  if (!pool) return undefined;
  const qt = quoteSchemaTable(dataSchema, "chat_channels");
  const attempts = [
    `SELECT id, empresa_id, type, meta_phone_number_id, nombre, provider, provider_channel_id,
           activo, connection_mode, config_status, config, created_at, updated_at FROM ${qt}
     WHERE id = $1::uuid AND empresa_id = $2::uuid LIMIT 1`,
    `SELECT id, empresa_id, type, meta_phone_number_id, nombre, provider, provider_channel_id,
           activo, config_status, config, created_at, updated_at FROM ${qt}
     WHERE id = $1::uuid AND empresa_id = $2::uuid LIMIT 1`,
    `SELECT id, empresa_id, type, meta_phone_number_id, nombre, provider, provider_channel_id,
           activo, config, created_at, updated_at FROM ${qt}
     WHERE id = $1::uuid AND empresa_id = $2::uuid LIMIT 1`,
  ];
  for (let i = 0; i < attempts.length; i++) {
    try {
      const r = await pool.query(attempts[i]!, [channelId, empresaId]);
      const row = r.rows?.[0];
      if (!row) return null;
      return mapChatChannelRow(row as Record<string, unknown>);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (i === attempts.length - 1) {
        console.error("[fetchChatChannelById] pg_failed", {
          schema: dataSchema,
          empresa_id: empresaId,
          message: msg.slice(0, 300),
        });
        return undefined;
      }
    }
  }
  return undefined;
}

async function loadChatChannelsUncached(
  ctx: Awaited<ReturnType<typeof requireEmpresaTenantServiceRole>>
): Promise<{ rows: ChatChannelRow[]; cacheable: boolean }> {
  const { supabase, empresa_id, dataSchema } = ctx;

  if (isLikelyUnexposedTenantChatSchema(dataSchema)) {
    const rows = await tryFetchChatChannelsFromPg(dataSchema, empresa_id);
    if (rows !== undefined) return { rows, cacheable: true };

    const pool = getChatPostgresPool();
    if (pool) {
      logPgPoolStats("fetchChatChannels_skip_postgrest", pool, {
        schema: dataSchema,
        empresa_id,
      });
    }
    console.error("[pg_pool_exhausted]", {
      kind: "channels_skip_postgrest",
      schema: dataSchema,
      empresa_id,
    });
    return { rows: [], cacheable: false };
  }

  const selectAttempts = [
    "id, empresa_id, type, meta_phone_number_id, nombre, provider, provider_channel_id, activo, connection_mode, config_status, config, created_at, updated_at",
    "id, empresa_id, type, meta_phone_number_id, nombre, provider, provider_channel_id, activo, config_status, config, created_at, updated_at",
    "id, empresa_id, type, meta_phone_number_id, nombre, provider, provider_channel_id, activo, config, created_at, updated_at",
  ];

  let data: Record<string, unknown>[] | null = null;
  let lastError: { message: string } | null = null;

  for (let i = 0; i < selectAttempts.length; i++) {
    const sel = selectAttempts[i]!;
    const res = await supabase
      .from("chat_channels")
      .select(sel)
      .eq("empresa_id", empresa_id)
      .order("created_at", { ascending: true });

    if (!res.error) {
      data = ((res.data ?? []) as unknown) as Record<string, unknown>[];
      lastError = null;
      break;
    }
    lastError = res.error;
    const msg = res.error.message ?? "";
    const retryable =
      i < selectAttempts.length - 1 &&
      (isMissingColumnError(msg, "connection_mode") ||
        isMissingColumnError(msg, "config_status") ||
        isMissingColumnError(msg, "provider_channel_id"));
    if (!retryable) break;
    console.warn("[fetchChatChannels] postgrest_retry_narrow_select", {
      schema: dataSchema,
      attempt: i + 1,
      message: msg.slice(0, 200),
    });
  }

  if (lastError) {
    const msg = lastError.message ?? "";
    if (isLikelyUnexposedTenantChatSchema(dataSchema) && isInvalidPostgrestSchemaError(msg)) {
      throw new Error(POSTGREST_TENANT_SCHEMA_HINT);
    }
    throw new Error(msg);
  }

  const mapped = (data ?? [])
    .map((r) => mapChatChannelRow(r))
    .filter((r) => typeof r.id === "string" && r.id.trim().length > 0);
  await enrichChatChannelsSecretFlagsFromPg(dataSchema, empresa_id, mapped);
  return { rows: mapped, cacheable: true };
}

export async function fetchChatChannels(): Promise<ChatChannelRow[]> {
  const ctx = await requireEmpresaTenantServiceRole();
  const ck = chatChannelsCacheKey(ctx.empresa_id, ctx.dataSchema);

  const cached = chatChannelsCache.get(ck);
  if (cached && Date.now() - cached.at < CHAT_CHANNELS_CACHE_TTL_MS) {
    return cached.rows;
  }

  const inflight = chatChannelsInflight.get(ck);
  if (inflight) return inflight;

  const promise = loadChatChannelsUncached(ctx).then(({ rows, cacheable }) => {
    if (cacheable) chatChannelsCache.set(ck, { at: Date.now(), rows });
    return rows;
  });
  chatChannelsInflight.set(ck, promise);
  void promise.finally(() => {
    chatChannelsInflight.delete(ck);
  });
  return promise;
}

export async function fetchChatChannelById(channelId: string): Promise<ChatChannelRow | null> {
  const { supabase, empresa_id, dataSchema } = await requireEmpresaTenantServiceRole();
  const id = channelId.trim();
  if (!id) return null;

  if (isLikelyUnexposedTenantChatSchema(dataSchema)) {
    const row = await tryFetchChatChannelByIdFromPg(dataSchema, empresa_id, id);
    if (row !== undefined) return row;
  }

  const selectAttempts = [
    "id, empresa_id, type, meta_phone_number_id, nombre, provider, provider_channel_id, activo, connection_mode, config_status, config, created_at, updated_at",
    "id, empresa_id, type, meta_phone_number_id, nombre, provider, provider_channel_id, activo, config_status, config, created_at, updated_at",
    "id, empresa_id, type, meta_phone_number_id, nombre, provider, provider_channel_id, activo, config, created_at, updated_at",
  ];

  let data: Record<string, unknown> | null = null;
  let lastError: { message: string } | null = null;

  for (let i = 0; i < selectAttempts.length; i++) {
    const sel = selectAttempts[i]!;
    const res = await supabase
      .from("chat_channels")
      .select(sel)
      .eq("id", id)
      .eq("empresa_id", empresa_id)
      .maybeSingle();

    if (!res.error) {
      data = (res.data ?? null) as Record<string, unknown> | null;
      lastError = null;
      break;
    }
    lastError = res.error;
    const msg = res.error.message ?? "";
    const retryable =
      i < selectAttempts.length - 1 &&
      (isMissingColumnError(msg, "connection_mode") ||
        isMissingColumnError(msg, "config_status") ||
        isMissingColumnError(msg, "provider_channel_id"));
    if (!retryable) break;
    console.warn("[fetchChatChannelById] postgrest_retry_narrow_select", {
      schema: dataSchema,
      attempt: i + 1,
      message: msg.slice(0, 200),
    });
  }

  if (lastError) {
    const msg = lastError.message ?? "";
    if (isLikelyUnexposedTenantChatSchema(dataSchema) && isInvalidPostgrestSchemaError(msg)) {
      throw new Error(POSTGREST_TENANT_SCHEMA_HINT);
    }
    throw new Error(msg);
  }
  if (!data) return null;
  const row = mapChatChannelRow(data);
  return row.id.trim().length > 0 ? row : null;
}

export type ChatChannelFormInput = {
  id?: string;
  nombre: string;
  meta_phone_number_id: string;
  provider_channel_id: string;
  activo: boolean;
  display_phone_number?: string;
  /** Token Meta para enviar desde el ERP; en edición, vacío = no cambiar el guardado */
  whatsapp_access_token?: string;
  /** Opcionales Cloud API (se persisten en `config`). */
  meta_waba_id?: string;
  meta_app_id?: string;
  meta_verify_token?: string;
  /** Se guarda en `config.comprobante_validation` (validación de comprobantes WhatsApp). */
  comprobante_validation?: Record<string, unknown>;
  /** Mensajes automáticos livianos en `config.business_automation` (no es chat_flows). */
  business_automation?: Record<string, unknown>;
  /** Estado UI de secciones del formulario en `config.form_section_state`. */
  form_section_state?: Record<string, { active: boolean; expanded: boolean }>;
  /** Persistido en `config.quick_replies_inbox_enabled` (icono rayo en inbox). */
  quick_replies_inbox_enabled?: boolean;
  /** Palabras para reiniciar/despertar bot (`config.bot_wake_*`). Opcional; omitido en otros guardados. */
  bot_wake_keywords_enabled?: boolean;
  bot_wake_keywords?: string[];
  bot_wake_keywords_match_mode?: BotWakeKeywordsMatchMode;
};

function metaChannelConfigStatus(params: {
  activo: boolean;
  phoneId: string;
  hasAccessToken: boolean;
}): "inactive" | "incomplete" | "active" {
  if (!params.activo) return "inactive";
  if (!params.phoneId) return "incomplete";
  if (!params.hasAccessToken) return "incomplete";
  return "active";
}

export type YCloudWhatsappChannelInput = {
  id?: string;
  nombre: string;
  activo: boolean;
  ycloud_api_key?: string;
  ycloud_webhook_secret?: string;
  ycloud_sender_id?: string;
  ycloud_channel_id?: string;
  /** WABA / identificador de cuenta en API de plantillas YCloud (`/v2/whatsapp/wabas/{id}/...`). */
  ycloud_waba_id?: string;
  /** Misma persistencia que Meta: validación de comprobantes, automatización, estado UI de secciones. */
  comprobante_validation?: Record<string, unknown>;
  business_automation?: Record<string, unknown>;
  form_section_state?: Record<string, { active: boolean; expanded: boolean }>;
  quick_replies_inbox_enabled?: boolean;
  bot_wake_keywords_enabled?: boolean;
  bot_wake_keywords?: string[];
  bot_wake_keywords_match_mode?: BotWakeKeywordsMatchMode;
};

/** WhatsApp vía YCloud (coexistencia). Sin ruta omnicanal Meta. */
export async function saveYCloudWhatsappChannel(input: YCloudWhatsappChannelInput): Promise<string> {
  const { supabase, empresa_id, dataSchema } = await requireEmpresaTenantServiceRole();
  const pool = getChatPostgresPool();
  const tenantPg = isLikelyUnexposedTenantChatSchema(dataSchema) && pool != null;
  const existingId = typeof input.id === "string" && input.id.trim().length > 0 ? input.id.trim() : undefined;
  let config: Record<string, unknown> = {};
  if (existingId) {
    let prevRaw: unknown = null;
    if (tenantPg) {
      prevRaw = await pgSelectChatChannelConfig(pool!, dataSchema, empresa_id, existingId);
    } else {
      const { data: prevRow, error: prevErr } = await supabase
        .from("chat_channels")
        .select("config")
        .eq("id", existingId)
        .eq("empresa_id", empresa_id)
        .maybeSingle();
      if (prevErr) throw postgrestMutationError(dataSchema, prevErr.message);
      prevRaw = prevRow?.config;
    }
    const prev =
      prevRaw && typeof prevRaw === "object" && prevRaw !== null && !Array.isArray(prevRaw)
        ? ({ ...(prevRaw as Record<string, unknown>) } as Record<string, unknown>)
        : {};
    config = { ...prev };
  }
  const keyPatch = input.ycloud_api_key?.trim();
  if (keyPatch) config.ycloud_api_key = keyPatch;
  if (input.ycloud_webhook_secret !== undefined) {
    const s = input.ycloud_webhook_secret.trim();
    if (s) config.ycloud_webhook_secret = s;
  }
  if (input.ycloud_sender_id !== undefined) {
    const s = input.ycloud_sender_id.trim();
    if (s) config.ycloud_sender_id = s;
  }
  if (input.ycloud_channel_id !== undefined) {
    const s = input.ycloud_channel_id.trim();
    if (s) config.ycloud_channel_id = s;
  }
  if (input.ycloud_waba_id !== undefined) {
    const s = input.ycloud_waba_id.trim();
    if (s) config.ycloud_waba_id = s;
  }

  if (input.comprobante_validation !== undefined) {
    config.comprobante_validation = input.comprobante_validation;
  }
  if (input.business_automation !== undefined) {
    config.business_automation = input.business_automation;
  }
  if (input.form_section_state !== undefined) {
    config.form_section_state = input.form_section_state;
  }
  if (input.quick_replies_inbox_enabled !== undefined) {
    config.quick_replies_inbox_enabled = input.quick_replies_inbox_enabled;
  }
  applyBotWakeKeywordsInputToChannelConfig(config, {
    bot_wake_keywords_enabled: input.bot_wake_keywords_enabled,
    bot_wake_keywords: input.bot_wake_keywords,
    bot_wake_keywords_match_mode: input.bot_wake_keywords_match_mode,
  });

  const hasKey =
    Boolean(keyPatch) ||
    Boolean(
      typeof config.ycloud_api_key === "string" && (config.ycloud_api_key as string).trim().length > 0
    );
  const config_status: "inactive" | "incomplete" | "active" = !input.activo
    ? "inactive"
    : hasKey
      ? "active"
      : "incomplete";

  const base = {
    nombre: input.nombre.trim() || "WhatsApp (YCloud)",
    type: "whatsapp" as const,
    meta_phone_number_id: null as string | null,
    provider: "ycloud",
    provider_channel_id: (input.ycloud_channel_id?.trim() || input.ycloud_sender_id?.trim() || null) as
      | string
      | null,
    activo: input.activo,
    connection_mode: "coexistence",
    config_status,
    config,
  };

  const updatedAt = new Date().toISOString();

  if (existingId) {
    if (tenantPg) {
      const updated = await pgUpdateYCloudWhatsappChannel(pool!, dataSchema, empresa_id, existingId, {
        nombre: base.nombre,
        type: base.type,
        provider: base.provider,
        provider_channel_id: base.provider_channel_id,
        activo: base.activo,
        connection_mode: base.connection_mode,
        config_status: base.config_status,
        config: base.config,
        updated_at: updatedAt,
      });
      if (!updated) throw new Error("No se pudo actualizar el canal.");
      await mirrorTenantChatChannelToCentralCatalog(dataSchema, empresa_id, existingId);
      return existingId;
    }
    const { data: updated, error } = await supabase
      .from("chat_channels")
      .update({ ...base, updated_at: updatedAt })
      .eq("id", existingId)
      .eq("empresa_id", empresa_id)
      .select("id")
      .maybeSingle();
    if (error) throw postgrestMutationError(dataSchema, error.message);
    if (!updated) throw new Error("No se pudo actualizar el canal.");
    await mirrorTenantChatChannelToCentralCatalog(dataSchema, empresa_id, existingId);
    return existingId;
  }

  if (tenantPg) {
    const yId = await pgInsertYCloudWhatsappChannel(pool!, dataSchema, {
      empresa_id,
      nombre: base.nombre,
      type: base.type,
      provider: base.provider,
      provider_channel_id: base.provider_channel_id,
      activo: base.activo,
      connection_mode: base.connection_mode,
      config_status: base.config_status,
      config: base.config,
    });
    await mirrorTenantChatChannelToCentralCatalog(dataSchema, empresa_id, yId);
    return yId;
  }

  const { data: inserted, error } = await supabase
    .from("chat_channels")
    .insert({
      empresa_id,
      ...base,
    })
    .select("id")
    .single();
  if (error) throw postgrestMutationError(dataSchema, error.message);
  const newId = inserted?.id as string | undefined;
  if (!newId) throw new Error("No se pudo crear el canal.");
  await mirrorTenantChatChannelToCentralCatalog(dataSchema, empresa_id, newId);
  return newId;
}

export type GenericOmnichannelChannelInput = {
  id?: string;
  type: "instagram" | "facebook" | "linkedin" | "email";
  nombre: string;
  provider: string;
  activo: boolean;
  config?: Record<string, unknown>;
};

/** Canal no WhatsApp: registro base para Etapa 2 (sin phone Meta). */
/**
 * Persiste estado UI de “Respuestas rápidas” sin guardar todo el formulario del canal (p. ej. omnicanal no WhatsApp).
 */
export async function patchChatChannelQuickRepliesSectionState(
  channelId: string,
  slice: { active: boolean; expanded: boolean }
): Promise<void> {
  const { supabase, empresa_id, dataSchema } = await requireEmpresaTenantServiceRole();
  const pool = getChatPostgresPool();
  const tenantPg = isLikelyUnexposedTenantChatSchema(dataSchema) && pool != null;
  const id = channelId.trim();
  if (!id) throw new Error("Canal inválido.");

  let rawCfg: unknown = null;
  if (tenantPg) {
    rawCfg = await pgSelectChatChannelConfig(pool!, dataSchema, empresa_id, id);
    if (rawCfg === null) throw new Error("Canal no encontrado.");
  } else {
    const { data: prevRow, error: fetchErr } = await supabase
      .from("chat_channels")
      .select("config")
      .eq("id", id)
      .eq("empresa_id", empresa_id)
      .maybeSingle();
    if (fetchErr) throw postgrestMutationError(dataSchema, fetchErr.message);
    rawCfg = prevRow?.config;
    if (!prevRow) throw new Error("Canal no encontrado.");
  }

  const prevCfg =
    rawCfg && typeof rawCfg === "object" && rawCfg !== null && !Array.isArray(rawCfg)
      ? ({ ...(rawCfg as Record<string, unknown>) } as Record<string, unknown>)
      : {};

  const prevFsRaw = prevCfg.form_section_state;
  const prevFs =
    prevFsRaw && typeof prevFsRaw === "object" && !Array.isArray(prevFsRaw)
      ? ({ ...(prevFsRaw as Record<string, unknown>) } as Record<string, unknown>)
      : {};

  prevFs.quick_replies = { active: slice.active, expanded: slice.expanded };
  prevCfg.form_section_state = prevFs;
  prevCfg.quick_replies_inbox_enabled = slice.active;

  const updatedAt = new Date().toISOString();

  if (tenantPg) {
    await pgUpdateChatChannelConfig(pool!, dataSchema, empresa_id, id, prevCfg, updatedAt);
    return;
  }

  const { error } = await supabase
    .from("chat_channels")
    .update({ config: prevCfg, updated_at: updatedAt })
    .eq("id", id)
    .eq("empresa_id", empresa_id);

  if (error) throw postgrestMutationError(dataSchema, error.message);
}

export async function saveGenericOmnichannelChannel(input: GenericOmnichannelChannelInput): Promise<string> {
  const { supabase, empresa_id, dataSchema } = await requireEmpresaTenantServiceRole();
  const pool = getChatPostgresPool();
  const tenantPg = isLikelyUnexposedTenantChatSchema(dataSchema) && pool != null;
  const existingId = typeof input.id === "string" && input.id.trim().length > 0 ? input.id.trim() : undefined;
  let config: Record<string, unknown> = input.config ? { ...input.config } : {};
  if (existingId) {
    let prevRaw: unknown = null;
    if (tenantPg) {
      prevRaw = await pgSelectChatChannelConfig(pool!, dataSchema, empresa_id, existingId);
    } else {
      const { data: prevRow, error: prevErr } = await supabase
        .from("chat_channels")
        .select("config")
        .eq("id", existingId)
        .eq("empresa_id", empresa_id)
        .maybeSingle();
      if (prevErr) throw postgrestMutationError(dataSchema, prevErr.message);
      prevRaw = prevRow?.config;
    }
    const prev =
      prevRaw && typeof prevRaw === "object" && prevRaw !== null && !Array.isArray(prevRaw)
        ? ({ ...(prevRaw as Record<string, unknown>) } as Record<string, unknown>)
        : {};
    config = { ...prev, ...config };
  }

  const config_status: "inactive" | "incomplete" | "active" = !input.activo
    ? "inactive"
    : "incomplete";

  const base = {
    nombre: input.nombre.trim() || input.type,
    type: input.type,
    meta_phone_number_id: null as string | null,
    provider: (input.provider || "meta").trim() || "meta",
    provider_channel_id: null as string | null,
    activo: input.activo,
    connection_mode: "standard" as const,
    config_status,
    config,
  };

  const updatedAt = new Date().toISOString();

  if (existingId) {
    if (tenantPg) {
      const updated = await pgUpdateGenericOmnichannelChannel(pool!, dataSchema, empresa_id, existingId, {
        nombre: base.nombre,
        type: base.type,
        meta_phone_number_id: null,
        provider: base.provider,
        provider_channel_id: null,
        activo: base.activo,
        connection_mode: "standard",
        config_status: base.config_status,
        config: base.config,
        updated_at: updatedAt,
      });
      if (!updated) throw new Error("No se pudo actualizar el canal.");
      await mirrorTenantChatChannelToCentralCatalog(dataSchema, empresa_id, existingId);
      return existingId;
    }
    const { data: updated, error } = await supabase
      .from("chat_channels")
      .update({ ...base, updated_at: updatedAt })
      .eq("id", existingId)
      .eq("empresa_id", empresa_id)
      .select("id")
      .maybeSingle();
    if (error) throw postgrestMutationError(dataSchema, error.message);
    if (!updated) throw new Error("No se pudo actualizar el canal.");
    await mirrorTenantChatChannelToCentralCatalog(dataSchema, empresa_id, existingId);
    return existingId;
  }

  if (tenantPg) {
    const gId = await pgInsertGenericOmnichannelChannel(pool!, dataSchema, {
      empresa_id,
      nombre: base.nombre,
      type: base.type,
      meta_phone_number_id: null,
      provider: base.provider,
      provider_channel_id: null,
      activo: base.activo,
      connection_mode: "standard",
      config_status: base.config_status,
      config: base.config,
    });
    await mirrorTenantChatChannelToCentralCatalog(dataSchema, empresa_id, gId);
    return gId;
  }

  const { data: inserted, error } = await supabase
    .from("chat_channels")
    .insert({
      empresa_id,
      ...base,
    })
    .select("id")
    .single();
  if (error) throw postgrestMutationError(dataSchema, error.message);
  const newId = inserted?.id as string | undefined;
  if (!newId) throw new Error("No se pudo crear el canal.");
  await mirrorTenantChatChannelToCentralCatalog(dataSchema, empresa_id, newId);
  return newId;
}

/** Crea o actualiza canal WhatsApp Cloud API (Meta). Devuelve el id del canal. */
export async function saveChatChannel(input: ChatChannelFormInput): Promise<string> {
  const { supabase, empresa_id, dataSchema } = await requireEmpresaTenantServiceRole();
  const pool = getChatPostgresPool();
  const tenantPg = isLikelyUnexposedTenantChatSchema(dataSchema) && pool != null;

  const pid = input.meta_phone_number_id.trim();
  if (!pid) throw new Error("Phone Number ID es obligatorio");

  const existingId =
    typeof input.id === "string" && input.id.trim().length > 0 ? input.id.trim() : undefined;

  const disp = input.display_phone_number?.trim();

  let config: Record<string, unknown> = { phone_number_id: pid };
  let previousMetaPhone: string | null = null;
  let existingToken: string | null = null;
  if (existingId) {
    if (tenantPg) {
      const pr = await pgSelectChatChannelMetaPrev(pool!, dataSchema, empresa_id, existingId);
      previousMetaPhone = pr?.meta_phone_number_id?.trim() || null;
      existingToken = pr?.whatsapp_access_token?.trim() || null;
      const prev =
        pr?.config && typeof pr.config === "object" && pr.config !== null && !Array.isArray(pr.config)
          ? ({ ...(pr.config as Record<string, unknown>) } as Record<string, unknown>)
          : {};
      config = { ...prev, phone_number_id: pid };
      if (disp) config.display_phone_number = disp;
    } else {
      const { data: prevRow, error: prevErr } = await supabase
        .from("chat_channels")
        .select("config, meta_phone_number_id, whatsapp_access_token")
        .eq("id", existingId)
        .eq("empresa_id", empresa_id)
        .maybeSingle();
      if (prevErr) throw postgrestMutationError(dataSchema, prevErr.message);
      previousMetaPhone =
        (prevRow as { meta_phone_number_id?: string | null } | null)?.meta_phone_number_id?.trim() || null;
      existingToken =
        (prevRow as { whatsapp_access_token?: string | null } | null)?.whatsapp_access_token?.trim() || null;
      const prev =
        prevRow?.config &&
        typeof prevRow.config === "object" &&
        prevRow.config !== null &&
        !Array.isArray(prevRow.config)
          ? ({ ...(prevRow.config as Record<string, unknown>) } as Record<string, unknown>)
          : {};
      config = { ...prev, phone_number_id: pid };
      if (disp) config.display_phone_number = disp;
    }
  } else if (disp) {
    config.display_phone_number = disp;
  }

  const waba = input.meta_waba_id?.trim();
  if (waba) config.meta_waba_id = waba;
  const appId = input.meta_app_id?.trim();
  if (appId) config.meta_app_id = appId;
  const verify = input.meta_verify_token?.trim();
  if (verify) config.meta_verify_token = verify;

  if (input.comprobante_validation !== undefined) {
    config.comprobante_validation = input.comprobante_validation;
  }
  if (input.business_automation !== undefined) {
    config.business_automation = input.business_automation;
  }
  if (input.form_section_state !== undefined) {
    config.form_section_state = input.form_section_state;
  }
  if (input.quick_replies_inbox_enabled !== undefined) {
    config.quick_replies_inbox_enabled = input.quick_replies_inbox_enabled;
  }
  applyBotWakeKeywordsInputToChannelConfig(config, {
    bot_wake_keywords_enabled: input.bot_wake_keywords_enabled,
    bot_wake_keywords: input.bot_wake_keywords,
    bot_wake_keywords_match_mode: input.bot_wake_keywords_match_mode,
  });

  const tokenPatch = input.whatsapp_access_token?.trim();
  const hasAccessToken = Boolean(tokenPatch) || Boolean(existingToken);

  const config_status = metaChannelConfigStatus({
    activo: input.activo,
    phoneId: pid,
    hasAccessToken,
  });

  const base = {
    nombre: input.nombre.trim() || "WhatsApp",
    type: "whatsapp" as const,
    meta_phone_number_id: pid,
    provider: "meta",
    provider_channel_id: input.provider_channel_id.trim() || pid,
    activo: input.activo,
    connection_mode: "official",
    config_status,
    config,
  };

  if (existingId) {
    const updatedAt = new Date().toISOString();
    if (tenantPg) {
      const updated = await pgUpdateChatChannelMetaWhatsapp(pool!, dataSchema, empresa_id, existingId, {
        nombre: base.nombre,
        type: base.type,
        meta_phone_number_id: base.meta_phone_number_id,
        provider: base.provider,
        provider_channel_id: base.provider_channel_id,
        activo: base.activo,
        connection_mode: base.connection_mode,
        config_status: base.config_status,
        config: base.config,
        updated_at: updatedAt,
        whatsapp_access_token_patch: tokenPatch ? tokenPatch : undefined,
      });
      if (!updated) {
        throw new Error("No se pudo actualizar el canal (¿pertenece a tu empresa?).");
      }
      if (previousMetaPhone && previousMetaPhone !== pid) {
        await deleteOmnichannelRouteByMetaPhone(previousMetaPhone);
      }
      await syncOmnichannelRouteForWhatsappChannel({
        metaPhoneNumberId: pid,
        empresaId: empresa_id,
        channelId: existingId,
        activo: input.activo,
        dataSchema,
      });
      return existingId;
    }

    const updatePayload: Record<string, unknown> = {
      ...base,
      updated_at: updatedAt,
    };
    if (tokenPatch) {
      updatePayload.whatsapp_access_token = tokenPatch;
    }
    const { data: updated, error } = await supabase
      .from("chat_channels")
      .update(updatePayload)
      .eq("id", existingId)
      .eq("empresa_id", empresa_id)
      .select("id")
      .maybeSingle();

    if (error) throw postgrestMutationError(dataSchema, error.message);
    if (!updated) {
      throw new Error("No se pudo actualizar el canal (¿pertenece a tu empresa?).");
    }
    if (previousMetaPhone && previousMetaPhone !== pid) {
      await deleteOmnichannelRouteByMetaPhone(previousMetaPhone);
    }
    await syncOmnichannelRouteForWhatsappChannel({
      metaPhoneNumberId: pid,
      empresaId: empresa_id,
      channelId: existingId,
      activo: input.activo,
      dataSchema,
    });
    return existingId;
  }

  if (tenantPg) {
    const newId = await pgInsertChatChannelMetaWhatsapp(pool!, dataSchema, {
      empresa_id,
      nombre: base.nombre,
      type: base.type,
      meta_phone_number_id: base.meta_phone_number_id,
      provider: base.provider,
      provider_channel_id: base.provider_channel_id,
      activo: base.activo,
      connection_mode: base.connection_mode,
      config_status: base.config_status,
      config: base.config,
      whatsapp_access_token: tokenPatch || null,
    });
    await syncOmnichannelRouteForWhatsappChannel({
      metaPhoneNumberId: pid,
      empresaId: empresa_id,
      channelId: newId,
      activo: input.activo,
      dataSchema,
    });
    return newId;
  }

  const { data: inserted, error } = await supabase
    .from("chat_channels")
    .insert({
      empresa_id,
      ...base,
      whatsapp_access_token: tokenPatch || null,
    })
    .select("id")
    .single();

  if (error) throw postgrestMutationError(dataSchema, error.message);
  const newId = inserted?.id as string | undefined;
  if (!newId) throw new Error("No se pudo obtener el id del canal creado.");
  await syncOmnichannelRouteForWhatsappChannel({
    metaPhoneNumberId: pid,
    empresaId: empresa_id,
    channelId: newId,
    activo: input.activo,
    dataSchema,
  });
  return newId;
}

/**
 * Activa o desactiva un canal WhatsApp sin borrar la fila ni credenciales guardadas.
 * Meta: sincroniza `omnichannel_routes` igual que al guardar desde el formulario.
 */
export async function patchChatChannelActivo(channelId: string, activo: boolean): Promise<void> {
  const id = channelId.trim();
  if (!id) throw new Error("Canal inválido.");

  const row = await fetchChatChannelById(id);
  if (!row) throw new Error("Canal no encontrado.");
  if (normalizeChannelType(row.type) !== "whatsapp") {
    throw new Error("Solo se puede activar o desactivar canales WhatsApp desde este acceso.");
  }

  const prov = String(row.provider ?? "meta").trim().toLowerCase();
  if (prov === "ycloud") {
    await saveYCloudWhatsappChannel({
      id: row.id,
      nombre: row.nombre?.trim() || "WhatsApp (YCloud)",
      activo,
    });
    return;
  }

  await saveChatChannel({
    id: row.id,
    nombre: row.nombre?.trim() || "WhatsApp",
    meta_phone_number_id: row.meta_phone_number_id?.trim() || "",
    provider_channel_id: row.provider_channel_id?.trim() || row.meta_phone_number_id?.trim() || "",
    activo,
    display_phone_number:
      typeof row.config?.display_phone_number === "string" ? row.config.display_phone_number : "",
    whatsapp_access_token: "",
    meta_waba_id: typeof row.config?.meta_waba_id === "string" ? row.config.meta_waba_id : "",
    meta_app_id: typeof row.config?.meta_app_id === "string" ? row.config.meta_app_id : "",
    meta_verify_token: typeof row.config?.meta_verify_token === "string" ? row.config.meta_verify_token : "",
  });
}

export type { ComprobanteValidacionListRow } from "@/lib/chat/comprobante-validation-types";
export type { ManualSorteoApprovalResult } from "@/lib/chat/sorteo-manual-approval-service";

export async function fetchComprobanteValidacionesForConversation(
  conversationId: string
): Promise<ComprobanteValidacionListRow[]> {
  const { supabase, empresa_id, dataSchema } = await requireEmpresaTenantServiceRole();
  const cid = conversationId.trim();
  if (!cid) return [];

  const pool = getChatPostgresPool();
  if (pool && isLikelyUnexposedTenantChatSchema(dataSchema)) {
    const ok = await pgConversationBelongsToEmpresa(pool, dataSchema, empresa_id, cid);
    if (!ok) return [];
    return pgFetchComprobanteValidacionesForConversation(pool, dataSchema, empresa_id, cid);
  }

  const { data: conv, error: cErr } = await supabase
    .from("chat_conversations")
    .select("id")
    .eq("id", cid)
    .eq("empresa_id", empresa_id)
    .maybeSingle();
  if (cErr) throw new Error(cErr.message);
  if (!conv) return [];

  const { data, error } = await supabase
    .from("chat_comprobante_validaciones")
    .select(
      "id, estado_validacion, motivo_validacion, comprobante_url, sorteo_entrada_id, flow_code, created_at, ocr_referencia, ocr_monto, monto_validacion_esperado_gs, monto_validacion_ocr_gs, monto_validacion_diferencia_gs, monto_validacion_status, bank_val_titular_esperado, bank_val_cuenta_esperada, bank_val_alias_esperado, bank_val_titular_ocr, bank_val_cuenta_ocr, bank_val_alias_ocr, bank_val_coincidencias, bank_val_min_requeridas, bank_val_status"
    )
    .eq("conversation_id", cid)
    .eq("empresa_id", empresa_id)
    .order("created_at", { ascending: false });

  if (error) throw new Error(error.message);
  return (data ?? []) as ComprobanteValidacionListRow[];
}

export async function approveComprobanteValidacion(
  validacionId: string,
  approvalNote?: string | null,
  options?: { forceClosePurchase?: boolean }
): Promise<ManualSorteoApprovalResult> {
  const { supabase, empresa_id, usuario_id, dataSchema } = await requireEmpresaTenantServiceRole();
  const id = validacionId.trim();
  if (!id) return { ok: false, code: "invalid", message: "ID de validación inválido" };

  const res = await approveComprobanteAndCloseSorteoPurchase({
    supabase,
    empresaId: empresa_id,
    usuarioId: usuario_id,
    validacionId: id,
    approvalNote,
    forceClosePurchase: options?.forceClosePurchase === true,
  });
  if (!res.ok && isLikelyUnexposedTenantChatSchema(dataSchema) && isInvalidPostgrestSchemaError(res.message)) {
    return {
      ...res,
      message:
        "No se pudo acceder a los datos del chat por la API. La operación debería usar base directa; si ves este mensaje, contactá soporte.",
    };
  }
  return res;
}

export async function deleteChatChannel(id: string): Promise<void> {
  const { supabase, empresa_id, dataSchema } = await requireEmpresaTenantServiceRole();
  const pool = getChatPostgresPool();
  const tenantPg = isLikelyUnexposedTenantChatSchema(dataSchema) && pool != null;

  let prev: { meta_phone_number_id: string | null; provider: string | null } | null = null;

  if (tenantPg) {
    const del = await pgDeleteChatChannel(pool!, dataSchema, empresa_id, id);
    prev = del ? { meta_phone_number_id: del.meta_phone_number_id, provider: del.provider } : null;
  } else {
    const { data: prevRow, error: selErr } = await supabase
      .from("chat_channels")
      .select("meta_phone_number_id, provider")
      .eq("id", id)
      .eq("empresa_id", empresa_id)
      .maybeSingle();
    if (selErr) throw postgrestMutationError(dataSchema, selErr.message);
    const { error } = await supabase.from("chat_channels").delete().eq("id", id).eq("empresa_id", empresa_id);
    if (error) throw postgrestMutationError(dataSchema, error.message);
    prev = prevRow as typeof prev;
  }

  const prov = String(prev?.provider ?? "meta").toLowerCase();
  const mp = prev?.meta_phone_number_id?.trim();
  if (mp && prov === "meta") await deleteOmnichannelRouteByMetaPhone(mp);
}
