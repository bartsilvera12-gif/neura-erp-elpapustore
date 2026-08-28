"use client";

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";
import {
  trackInboxPollingList,
  trackInboxPollingThread,
  trackInboxRealtimeEvent,
  logRealtimeChannelState,
  logInboxFlagsBoot,
} from "@/lib/chat/inbox-observability";
import { getInboxFlagsSnapshot } from "@/lib/chat/inbox-feature-flags";
import type { ComprobanteValidacionListRow } from "@/lib/chat/comprobante-validation-types";
import {
  approveComprobanteValidacion,
  fetchChatChannels,
  fetchChatConversations,
  fetchComprobanteValidacionesForConversation,
  hasEmpresaActiveChatFlows,
  markConversationRead,
  releaseConversationToBot,
  type ChatInboxAssignmentFilter,
  type ChatChannelRow,
  type ChatInboxFilters,
  type ConversacionesVista,
  type InboxConversation,
} from "@/lib/chat/actions";
import {
  assignConversationToAgent,
  changeConversationQueue,
  changeConversationStatus,
  fetchSupervisorAgentLoads,
  getMyAgentOperationalPresence,
  listChatQueues,
  setMyAgentOperationalPresence,
  touchChatAgentInboxHeartbeat,
  type ChatAgentOperationalStatus,
  type ChatQueueListRow,
  type InboxCabeceraInsignia,
  type SupervisorAgentLoadRow,
} from "@/lib/chat/chat-ops-actions";
import { INBOX_HEARTBEAT_INTERVAL_MS } from "@/lib/chat/agent-presence";
import { formatWaitHuman } from "@/lib/chat/format-wait-human";
import { listActiveQuickRepliesForChannel } from "@/lib/chat/quick-replies-actions";
import { ArrowLeftRight, Flame, Mic, Paperclip, RefreshCw, Square, UserRound, Zap } from "lucide-react";
import {
  finalizeConversationWithClosure,
  loadFinalizeOptionsForConversation,
  type FinalizeOptionsResult,
} from "@/lib/chat/conversation-finalize-actions";
import {
  getErpAttachmentCaption,
  getErpAttachmentFilename,
  getErpAttachmentPublicUrl,
  getMetaInboundDocumentFilename,
  getWhatsAppMediaUrlFromRawPayload,
  isImageMimeHint,
} from "@/lib/chat/message-erp-display";
import { assignmentWaitBadge, assignmentWaitBadgeClass } from "@/lib/chat/inbox-assignment-labels";
import type { OmnicanalOperatorRole } from "@/lib/chat/omnicanal-supervision-read";
import { playInboxNotificationBeep, readInboxNotificationSoundEnabled } from "@/lib/chat/inbox-notification-preference";
import { createBrowserClientForSchema } from "@/lib/supabase";
import { ChannelBadge } from "@/components/chat/ChannelBadge";

type ChatMessage = {
  id: string;
  from_me: boolean;
  message_type: string;
  content: string | null;
  created_at: string;
  raw_payload?: Record<string, unknown> | null;
};

function isHumanContactName(name: string | null | undefined, phone?: string | null): boolean {
  const v = (name ?? "").trim();
  if (!v) return false;
  if (!/\p{L}/u.test(v)) return false;
  if (phone) {
    const dn = v.replace(/\D+/g, "");
    const dp = String(phone).replace(/\D+/g, "");
    if (dn && dn === dp) return false;
  }
  return true;
}

function contactPhoneFallback(
  phone: string | null | undefined,
  name: string | null | undefined
): string {
  const p = (phone ?? "").trim();
  if (p) return p;
  const n = (name ?? "").trim();
  if (n && !/\p{L}/u.test(n)) return n;
  return "—";
}

function formatTime(iso: string) {
  try {
    return new Date(iso).toLocaleString("es-PY", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function mapRowToMessage(row: Record<string, unknown>): ChatMessage {
  return {
    id: row.id as string,
    from_me: Boolean(row.from_me),
    message_type: String(row.message_type ?? "text"),
    content: (row.content as string | null) ?? null,
    created_at: String(row.created_at),
    raw_payload:
      typeof row.raw_payload === "object" && row.raw_payload !== null
        ? (row.raw_payload as Record<string, unknown>)
        : null,
  };
}

function parseOutgoingImageMessage(message: ChatMessage): { url: string | null; caption: string | null } {
  const erpUrl = getErpAttachmentPublicUrl(message.raw_payload);
  if (erpUrl) {
    const cap = getErpAttachmentCaption(message.raw_payload) ?? getErpAttachmentFilename(message.raw_payload);
    return { url: erpUrl, caption: cap };
  }
  const waUrl = getWhatsAppMediaUrlFromRawPayload(message.raw_payload);
  if (waUrl) {
    const imagePayload = (message.raw_payload?.image as { caption?: string } | undefined) ?? {};
    const cap = typeof imagePayload.caption === "string" ? imagePayload.caption.trim() : "";
    return { url: waUrl, caption: cap || null };
  }
  const imagePayload = (message.raw_payload?.image as { link?: string; caption?: string } | undefined) ?? {};
  const link = typeof imagePayload.link === "string" ? imagePayload.link.trim() : "";
  const captionFromPayload = typeof imagePayload.caption === "string" ? imagePayload.caption.trim() : "";
  if (link) return { url: link, caption: captionFromPayload || null };

  const lines = (message.content ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const urlLine = lines.find((line) => /^https?:\/\//i.test(line)) ?? null;
  const captionLine = lines.find((line) => !/^https?:\/\//i.test(line) && !/^Imagen enviada:?/i.test(line)) ?? null;
  return { url: urlLine, caption: captionLine };
}

function resolveAttachmentUrl(message: ChatMessage): string | null {
  return (
    getErpAttachmentPublicUrl(message.raw_payload) ??
    getWhatsAppMediaUrlFromRawPayload(message.raw_payload) ??
    parseOutgoingImageMessage(message).url
  );
}

function displayFilenameForAttachment(message: ChatMessage): string {
  const erp = getErpAttachmentFilename(message.raw_payload);
  if (erp) return erp;
  const meta = getMetaInboundDocumentFilename(message.raw_payload);
  if (meta) return meta;
  const raw = (message.content ?? "").trim();
  const m = /^\[documento\]\s*(.+)$/i.exec(raw);
  if (m?.[1]?.trim()) return m[1].trim();
  if (raw && !raw.startsWith("[")) return raw.slice(0, 120);
  return message.message_type === "video" ? "Video" : "Archivo";
}

/**
 * Lee la definición aditiva `neura_interactive` que el flow engine persiste en
 * `raw_payload` para mensajes interactive nuevos. Devuelve los items para renderizar
 * los botones como chips read-only. Si no existe (mensajes históricos / otros tipos),
 * retorna null y la UI mantiene el render actual.
 */
function getNeuraInteractiveItems(
  message: ChatMessage
): { groupTitle: string | null; items: string[] } | null {
  if (message.message_type !== "interactive") return null;
  const ni = (message.raw_payload?.neura_interactive ?? null) as
    | { groupTitle?: unknown; items?: Array<{ title?: unknown }> }
    | null;
  if (!ni || !Array.isArray(ni.items)) return null;
  const items = ni.items
    .map((it) => (typeof it?.title === "string" ? it.title.trim() : ""))
    .filter((t) => t.length > 0);
  if (items.length === 0) return null;
  return {
    groupTitle: typeof ni.groupTitle === "string" ? ni.groupTitle : null,
    items,
  };
}

function tabClass(active: boolean) {
  return `px-4 py-2 text-xs font-semibold rounded-xl transition-all ${
    active
      ? "bg-[#4FAEB2] text-white shadow-sm shadow-[#4FAEB2]/25"
      : "text-slate-500 hover:bg-slate-100 hover:text-slate-700"
  }`;
}

/**
 * Control segmentado: el modo activo = pastilla blanca con borde de color (no “todo verde”);
 * el inactivo = gris plano (se entiende qué está elegido).
 */
function opPresenceToggleClass(isSelected: boolean, variant: "ready" | "offline") {
  const base =
    "px-3 py-1.5 text-xs font-semibold rounded-md transition-all disabled:opacity-50 min-w-[6.75rem] text-center border-2";
  if (!isSelected) {
    return `${base} border-transparent bg-slate-200/60 text-slate-500 hover:bg-slate-200 hover:text-slate-600`;
  }
  if (variant === "ready") {
    return `${base} border-emerald-500 bg-white text-emerald-700 shadow-sm ring-1 ring-emerald-200/90 z-[1]`;
  }
  return `${base} border-slate-600 bg-white text-slate-800 shadow-sm ring-1 ring-slate-200/90 z-[1]`;
}

function LiveElapsedLabel({ sinceIso }: { sinceIso: string | null }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((x) => x + 1), 1000);
    return () => window.clearInterval(id);
  }, []);
  if (!sinceIso) return <span className="text-slate-400">—</span>;
  return <span className="tabular-nums font-medium">{formatWaitHuman(sinceIso)}</span>;
}

function inboxClientWaitingSince(c: InboxConversation): string | null {
  if (c.awaiting_agent_reply_since) return null;
  return c.awaiting_client_reply_since ?? null;
}

function InboxReplyTurnBadges({ c, dense }: { c: InboxConversation; dense?: boolean }) {
  const agentSince = c.awaiting_agent_reply_since;
  const clientSince = inboxClientWaitingSince(c);
  if (!agentSince && !clientSince) return null;
  const pad = dense ? "px-1.5 py-0.5 text-[9px]" : "px-1.5 py-0.5 text-[10px]";
  return (
    <>
      {agentSince ? (
        <span
          className={`inline-flex items-center gap-0.5 font-semibold text-orange-950 bg-orange-50 border border-orange-200 rounded ${pad} shrink-0`}
          title="Cliente escribió; falta respuesta humana del asesor"
        >
          <Flame className={`shrink-0 text-orange-600 ${dense ? "w-3 h-3" : "w-3.5 h-3.5"}`} aria-hidden />
          <LiveElapsedLabel sinceIso={agentSince} />
        </span>
      ) : null}
      {clientSince ? (
        <span
          className={`inline-flex items-center gap-0.5 font-semibold text-sky-950 bg-sky-50 border border-sky-200 rounded ${pad} shrink-0`}
          title="Último mensaje saliente; turno del contacto"
        >
          <UserRound className={`shrink-0 text-sky-600 ${dense ? "w-3 h-3" : "w-3.5 h-3.5"}`} aria-hidden />
          <LiveElapsedLabel sinceIso={clientSince} />
        </span>
      ) : null}
    </>
  );
}

function parseInboxFilters(sp: URLSearchParams): ChatInboxFilters | undefined {
  const rawA = sp.get("asignacion");
  const assignment: ChatInboxAssignmentFilter =
    rawA === "mios" ? "mine" : rawA === "sin_asignar" ? "unassigned" : "all";
  const queue_id = sp.get("cola")?.trim() || null;
  const channel_id = sp.get("canal")?.trim() || null;
  const statusRaw = sp.get("estado")?.trim().toLowerCase() || null;
  const priorityRaw = sp.get("prioridad")?.trim().toLowerCase() || null;
  const status =
    statusRaw && ["open", "pending", "closed"].includes(statusRaw) ? statusRaw : null;
  const priority =
    priorityRaw && ["low", "medium", "high"].includes(priorityRaw) ? priorityRaw : null;
  const has =
    assignment !== "all" ||
    (queue_id && queue_id.length > 0) ||
    status !== null ||
    priority !== null ||
    (channel_id && channel_id.length > 0);
  if (!has) return undefined;
  return {
    assignment,
    queue_id: queue_id && queue_id.length > 0 ? queue_id : null,
    status,
    priority,
    channel_id: channel_id && channel_id.length > 0 ? channel_id : null,
  };
}

function formatChannelOptionLabel(c: ChatChannelRow): string {
  const name = (c.nombre ?? "").trim() || "Canal";
  const kind = [c.type, c.provider].filter(Boolean).join(" / ");
  const mp = c.meta_phone_number_id?.trim();
  const tail =
    mp && mp.length > 0
      ? ` · ${mp.length > 18 ? `${mp.slice(0, 16)}…` : mp}`
      : "";
  return `${name} · ${kind}${tail}`;
}

function labelEstado(s: string) {
  if (s === "open") return "Abierta";
  if (s === "pending") return "Pendiente";
  if (s === "closed") return "Cerrada";
  return s;
}

function badgeEstadoClass(s: string) {
  if (s === "open") return "text-sky-800 bg-sky-50 border-sky-200";
  if (s === "pending") return "text-amber-800 bg-amber-50 border-amber-200";
  if (s === "closed") return "text-slate-600 bg-slate-100 border-slate-200";
  return "text-slate-600 bg-slate-50 border-slate-200";
}

function omnicanalRoleBadgeClass(role: string | null): string {
  if (role === "admin") return "text-slate-800 bg-slate-100 border-slate-200";
  if (role === "supervisor") return "text-sky-800 bg-sky-50 border-sky-200";
  if (role === "agente") return "text-indigo-900 bg-indigo-50 border-indigo-200";
  return "text-slate-600 bg-slate-50 border-slate-200";
}

function omnicanalRoleShortLabel(role: string | null): string | null {
  if (!role) return null;
  if (role === "admin") return "Admin";
  if (role === "supervisor") return "Supervisor";
  if (role === "agente") return "Agente";
  return null;
}

const CHAT_LIST_DEBUG = process.env.NEXT_PUBLIC_CHAT_LIST_DEBUG === "true";
function chatListUiLog(
  sub: "initial-data" | "refetch-start" | "refetch-result" | "set-conversations" | "filters-applied" | "tab-split" | "refetch-preserve",
  payload: Record<string, unknown>
) {
  if (!CHAT_LIST_DEBUG) return;
  console.info(`[chat-ui][${sub}]`, { ...payload, timestamp: new Date().toISOString() });
}

export type ConversacionesClientMode = "inbox" | "historial";

/** Presencia operativa precargada en el servidor (evita parpadeo y fallos solo-cliente). */
export type ConversacionesInitialOperationalPresence =
  | { in_queues: false; status: null; status_changed_at?: null }
  | { in_queues: true; status: ChatAgentOperationalStatus; status_changed_at: string | null };

export function ConversacionesClient({
  mode,
  chatDataSchema,
  agentDisplayName,
  initialOperationalPresence,
  initialCabeceraInsignia = null,
  initialOmnicanalRole = null,
}: {
  mode: ConversacionesClientMode;
  /** Esquema Postgres de tablas chat_* (zentra_erp o `er_…`). */
  chatDataSchema: string;
  /** Nombre visible del agente logueado (resuelto en servidor). */
  agentDisplayName: string;
  /** Si viene del RSC, el toggle de presencia puede mostrarse sin esperar la primera server action. */
  initialOperationalPresence?: ConversacionesInitialOperationalPresence;
  /** Admin/supervisor sin cola (incluye admin ERP por `usuarios.rol`). */
  initialCabeceraInsignia?: InboxCabeceraInsignia;
  /** Rol operativo omnicanal (precargado para mensajes UX de alcance). */
  initialOmnicanalRole?: OmnicanalOperatorRole | null;
}) {
  const supabaseChat = useMemo(
    () => createBrowserClientForSchema(chatDataSchema),
    [chatDataSchema]
  );
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const vistaParam = searchParams?.get("vista") ?? "";
  const vista: ConversacionesVista =
    mode === "historial" ? "historial" : vistaParam === "bot" ? "bot" : "inbox";

  const [conversations, setConversations] = useState<InboxConversation[]>([]);
  const conversationsRef = useRef<InboxConversation[]>([]);
  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  /** Boot log: snapshot de flags de Inbox. No-op si CHAT_INBOX_OBSERVABILITY=false. */
  useEffect(() => {
    logInboxFlagsBoot(getInboxFlagsSnapshot());
  }, []);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loadingList, setLoadingList] = useState(true);
  const [loadingMsg, setLoadingMsg] = useState(false);
  const [sending, setSending] = useState(false);
  const [uploadingFile, setUploadingFile] = useState(false);
  /** Grabación de nota de voz (MediaRecorder) antes de subir a /api/chat/send-media. */
  const [recordingVoice, setRecordingVoice] = useState(false);
  const [releasingBot, setReleasingBot] = useState(false);
  const [resendFlowStepLoading, setResendFlowStepLoading] = useState(false);
  const [resendFlowNotice, setResendFlowNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [messagesError, setMessagesError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [hasActiveChannel, setHasActiveChannel] = useState<boolean | null>(null);
  /** Canales activos de la empresa (selector de filtro inbox/historial). */
  const [inboxChannels, setInboxChannels] = useState<ChatChannelRow[]>([]);
  const [compVals, setCompVals] = useState<ComprobanteValidacionListRow[]>([]);
  const [compLoading, setCompLoading] = useState(false);
  const [compActionId, setCompActionId] = useState<string | null>(null);
  const [compApproveConfirmId, setCompApproveConfirmId] = useState<string | null>(null);
  const [compApprovalInfo, setCompApprovalInfo] = useState<string | null>(null);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [opsQueues, setOpsQueues] = useState<ChatQueueListRow[]>([]);
  const [opsAgentLoads, setOpsAgentLoads] = useState<SupervisorAgentLoadRow[]>([]);
  const [opsBusy, setOpsBusy] = useState(false);
  const [transferModalOpen, setTransferModalOpen] = useState(false);
  /** Cola elegida: transferencia a cola y filtro de agentes en el modal. */
  const [transferQueueTarget, setTransferQueueTarget] = useState("");
  const [transferAgentSearch, setTransferAgentSearch] = useState("");
  const [transferLoadsRefreshing, setTransferLoadsRefreshing] = useState(false);
  const [channelQuickReplies, setChannelQuickReplies] = useState<
    Array<{ id: string; title: string; body: string }>
  >([]);
  const [quickRepliesLoading, setQuickRepliesLoading] = useState(false);
  const [quickReplyOpen, setQuickReplyOpen] = useState(false);
  const [quickReplySearch, setQuickReplySearch] = useState("");
  const quickReplyPanelRef = useRef<HTMLDivElement | null>(null);
  const [hasActiveBotFlows, setHasActiveBotFlows] = useState(false);
  const [botFlowsChecked, setBotFlowsChecked] = useState(false);
  const [compValidacionesOpen, setCompValidacionesOpen] = useState(false);
  const [listColumnHidden, setListColumnHidden] = useState(false);
  /**
   * Collapsa el encabezado del módulo (eyebrow + nombre + insignia + tabs +
   * filtros) para maximizar el espacio del chat. Persiste en localStorage.
   */
  const [headerCollapsed, setHeaderCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try {
      return window.localStorage.getItem("conversaciones:headerCollapsed") === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        "conversaciones:headerCollapsed",
        headerCollapsed ? "1" : "0",
      );
    } catch {
      /* ignore */
    }
  }, [headerCollapsed]);
  /** Texto del buscador (inmediato). Filtra la página cargada y, con ≥3, dispara búsqueda server-side. */
  const [listSearch, setListSearch] = useState("");
  /** Término debounced que efectivamente se manda al servidor (vacío si <3 chars). */
  const [debouncedSearch, setDebouncedSearch] = useState("");
  /** Búsqueda server-side en vuelo (para mostrar "Buscando…" en vez de "sin resultados"). */
  const [searchLoading, setSearchLoading] = useState(false);
  const [finalizeOpen, setFinalizeOpen] = useState(false);
  const [finalizeLoading, setFinalizeLoading] = useState(false);
  const [opPresenceLoaded, setOpPresenceLoaded] = useState(
    mode !== "inbox" || initialOperationalPresence !== undefined
  );
  const [opInQueues, setOpInQueues] = useState(
    mode !== "inbox" ? false : (initialOperationalPresence?.in_queues ?? false)
  );
  const [opStatus, setOpStatus] = useState<ChatAgentOperationalStatus | null>(
    mode !== "inbox"
      ? null
      : initialOperationalPresence?.in_queues
        ? initialOperationalPresence.status
        : null
  );
  const [opPresenceBusy, setOpPresenceBusy] = useState(false);
  const [opPresenceErr, setOpPresenceErr] = useState<string | null>(null);
  const [opPresenceOkMsg, setOpPresenceOkMsg] = useState<string | null>(null);
  const [opSince, setOpSince] = useState<string | null>(() =>
    mode === "inbox" && initialOperationalPresence?.in_queues
      ? initialOperationalPresence.status_changed_at ?? null
      : null
  );
  /** Ancla de sesión en esta pestaña inbox (tiempo de uso del módulo). */
  const [sessionSinceIso, setSessionSinceIso] = useState<string | null>(null);
  const [finalizeSaving, setFinalizeSaving] = useState(false);
  const [finalizeOptions, setFinalizeOptions] = useState<FinalizeOptionsResult | null>(null);
  const [finalizeStateId, setFinalizeStateId] = useState("");
  const [finalizeSubstateId, setFinalizeSubstateId] = useState("");
  const [finalizeComment, setFinalizeComment] = useState("");
  const [finalizeModalError, setFinalizeModalError] = useState<string | null>(null);

  const inboxFilterKey = searchParams?.toString() ?? "";

  /** Lectura siempre actual para sondeos silenciosos / realtime (evita filtros obsoletos en closure). */
  const searchParamsRef = useRef(searchParams);
  searchParamsRef.current = searchParams;

  /** Búsqueda debounced siempre actual, para que los refetch silenciosos la respeten. */
  const debouncedSearchRef = useRef("");
  debouncedSearchRef.current = debouncedSearch;
  /** Evita un refetch redundante en el montaje (el efecto de carga inicial ya corre). */
  const didInitSearchRef = useRef(false);

  /** Optimista: `router.replace` actualiza la URL un tick después; sin esto el select vuelve al valor anterior. */
  const [pendingCanal, setPendingCanal] = useState<string | null>(null);
  const [pendingCola, setPendingCola] = useState<string | null>(null);
  const [pendingAsignacion, setPendingAsignacion] = useState<string | null>(null);

  const urlCanal = searchParams?.get("canal")?.trim() ?? "";
  const urlCola = searchParams?.get("cola")?.trim() ?? "";
  const urlAsignacionRaw = searchParams?.get("asignacion")?.trim();
  const urlAsignacion =
    urlAsignacionRaw === "mios" ? "mios" : urlAsignacionRaw === "sin_asignar" ? "sin_asignar" : "";

  const displayCanal = pendingCanal !== null ? pendingCanal : urlCanal;
  const displayCola = pendingCola !== null ? pendingCola : urlCola;
  const displayAsignacion = pendingAsignacion !== null ? pendingAsignacion : urlAsignacion;

  useEffect(() => {
    if (pendingCanal !== null && pendingCanal === urlCanal) setPendingCanal(null);
  }, [pendingCanal, urlCanal]);
  useEffect(() => {
    if (pendingCola !== null && pendingCola === urlCola) setPendingCola(null);
  }, [pendingCola, urlCola]);
  useEffect(() => {
    if (pendingAsignacion !== null && pendingAsignacion === urlAsignacion) setPendingAsignacion(null);
  }, [pendingAsignacion, urlAsignacion]);

  /** Si la URL corrige un canal inválido (p. ej. ya no existe), alinear UI optimista. */
  useEffect(() => {
    if (pendingCanal === null || inboxChannels.length === 0) return;
    if (urlCanal !== "") return;
    const stillValid = inboxChannels.some((c) => c.id === pendingCanal);
    if (!stillValid) setPendingCanal(null);
  }, [pendingCanal, urlCanal, inboxChannels]);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const selectedIdRef = useRef<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recordChunksRef = useRef<Blob[]>([]);
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  /** Si el usuario está cerca del final, los mensajes nuevos hacen scroll; si subió a leer historial, no. */
  const stickBottomRef = useRef(true);
  const lastMessageIdRef = useRef<string | null>(null);
  const loadConversationsRef = useRef<(opts?: { silent?: boolean }) => Promise<void>>(async () => {});
  /** Tras la primera carga visible del inbox, se permite el beep (evita sonido en hidratar inicial). */
  const inboxSoundPrimedRef = useRef(false);
  /** Dedupe de ids de mensaje entrante ya notificados con sonido. */
  const inboundSoundMsgIdsRef = useRef<Set<string>>(new Set());

  /** Evita aplicar respuestas viejas si el usuario cambió de chat rápido. */
  const messagesLoadGenRef = useRef(0);
  /** Cache en memoria por sesión: reabrir conversación muestra historial al instante y refresca después. */
  const messagesSessionCacheRef = useRef<Map<string, ChatMessage[]>>(new Map());

  const loadConversations = useCallback(
    async (opts?: { silent?: boolean }) => {
      const silent = opts?.silent ?? false;
      const sp = new URLSearchParams(searchParamsRef.current?.toString() ?? "");
      const baseFilters = parseInboxFilters(sp);
      const searchTerm = debouncedSearchRef.current.trim();
      const filters = searchTerm ? { ...(baseFilters ?? {}), search: searchTerm } : baseFilters;
      const previousCount = conversationsRef.current.length;
      if (silent) {
        chatListUiLog("refetch-start", {
          activeTab: vista,
          previous_count: previousCount,
          source: "loadConversations",
          reason: "silent",
          filters: filters ?? null,
        });
      }
      try {
        const {
          conversations: rows,
          base_row_count: baseRowCount,
          transient_list_error: transientListError,
        } = await fetchChatConversations(vista, filters);
        if (silent) {
          chatListUiLog("refetch-result", {
            activeTab: vista,
            previous_count: previousCount,
            next_count: rows.length,
            base_row_count: baseRowCount,
            source: "fetchChatConversations",
            reason: "ok",
            filters: filters ?? null,
          });
        }
        /** Con búsqueda activa, 0 resultados es válido (no preservar la lista previa). */
        const isSearchingNow = debouncedSearchRef.current.trim().length >= 3;
        const preserveSilentEmpty =
          silent &&
          !isSearchingNow &&
          rows.length === 0 &&
          previousCount > 0 &&
          (baseRowCount === 0 || Boolean(transientListError));
        if (preserveSilentEmpty) {
          chatListUiLog("refetch-preserve", {
            activeTab: vista,
            previous_count: previousCount,
            next_count: 0,
            base_row_count: baseRowCount,
            source: "fetchChatConversations",
            reason: "silent_empty_keeps_previous",
            filters: filters ?? null,
          });
        } else {
          chatListUiLog("set-conversations", {
            activeTab: vista,
            previous_count: previousCount,
            next_count: rows.length,
            base_row_count: baseRowCount,
            source: "fetchChatConversations",
            reason: silent ? "silent_replace" : "load",
            filters: filters ?? null,
          });
          setConversations(rows);
        }
        if (!silent && previousCount === 0) {
          chatListUiLog("initial-data", {
            activeTab: vista,
            previous_count: 0,
            next_count: rows.length,
            base_row_count: baseRowCount,
            source: "first_fetch",
            reason: "hydrated",
            filters: filters ?? null,
          });
        }
        setListError(null);
        if (transientListError && !silent && rows.length === 0) {
          setListError(
            "No pudimos refrescar el listado (base de datos ocupada). La vista anterior se mantiene si ya tenías datos."
          );
        }
      } catch (e) {
        chatListUiLog("refetch-result", {
          activeTab: vista,
          previous_count: previousCount,
          source: "fetchChatConversations",
          reason: "error",
          error: e instanceof Error ? e.message : String(e),
          filters: filters ?? null,
        });
        setListError(e instanceof Error ? e.message : "Error al cargar conversaciones");
      } finally {
        if (!silent) {
          setLoadingList(false);
          inboxSoundPrimedRef.current = true;
        }
      }
    },
    [vista]
  );

  const loadMessages = useCallback(async (conversationId: string, opts?: { silent?: boolean }) => {
    const silent = opts?.silent ?? false;
    const ticket = silent ? -1 : ++messagesLoadGenRef.current;

    if (!silent) {
      setMessagesError(null);
      const cached = messagesSessionCacheRef.current.get(conversationId);
      if (cached && cached.length > 0) {
        setMessages(cached);
        setLoadingMsg(false);
      } else {
        setMessages([]);
        setLoadingMsg(true);
      }
    } else {
      setMessagesError(null);
    }

    try {
      const qs = new URLSearchParams({ conversation_id: conversationId });
      const res = await fetchWithSupabaseSession(`/api/chat/messages?${qs.toString()}`, {
        cache: "no-store",
      });
      if (!res.ok) {
        let detail = "";
        try {
          const j = (await res.json()) as { error?: string; message?: string };
          detail = (j.error || j.message || "").trim();
        } catch {
          detail = (await res.text().catch(() => "")).trim();
        }
        throw new Error(detail || `Error ${res.status} al cargar mensajes`);
      }
      const json = (await res.json()) as { success?: boolean; data?: Record<string, unknown>[] };
      if (!json.success || !Array.isArray(json.data)) {
        if (
          !silent &&
          ticket === messagesLoadGenRef.current &&
          selectedIdRef.current === conversationId
        ) {
          setMessages([]);
          messagesSessionCacheRef.current.delete(conversationId);
        }
        return;
      }
      const mapped = json.data.map(mapRowToMessage);
      messagesSessionCacheRef.current.set(conversationId, mapped);

      if (silent) {
        if (selectedIdRef.current !== conversationId) return;
        setMessages(mapped);
        return;
      }

      if (ticket !== messagesLoadGenRef.current || selectedIdRef.current !== conversationId) {
        return;
      }
      setMessages(mapped);
    } catch (e) {
      if (silent) return;
      if (ticket !== messagesLoadGenRef.current) return;
      if (selectedIdRef.current !== conversationId) return;
      const cachedFallback = messagesSessionCacheRef.current.get(conversationId);
      if (!cachedFallback?.length) {
        setMessages([]);
      }
      setMessagesError(e instanceof Error ? e.message : "Error al cargar mensajes");
    } finally {
      if (!silent && ticket === messagesLoadGenRef.current && selectedIdRef.current === conversationId) {
        setLoadingMsg(false);
      }
    }
  }, []);

  const loadMessagesRef = useRef(loadMessages);
  loadMessagesRef.current = loadMessages;

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  const sendMediaFile = useCallback(async (file: File) => {
    const cid = selectedIdRef.current;
    if (!cid || file.size < 1) return;
    setSendError(null);
    stickBottomRef.current = true;
    setUploadingFile(true);
    try {
      const fd = new FormData();
      fd.set("conversation_id", cid);
      fd.set("file", file);
      const res = await fetchWithSupabaseSession("/api/chat/send-media", {
        method: "POST",
        body: fd,
        credentials: "same-origin",
      });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) {
        throw new Error(typeof json.error === "string" ? json.error : `Error HTTP ${res.status}`);
      }
      await loadMessagesRef.current(cid, { silent: true });
      await loadConversationsRef.current?.({ silent: true });
    } catch (err) {
      setSendError(err instanceof Error ? err.message : "Error al enviar archivo");
    } finally {
      setUploadingFile(false);
    }
  }, []);

  async function toggleVoiceNote() {
    const cid = selectedIdRef.current;
    if (!cid || uploadingFile) return;
    const mr = mediaRecorderRef.current;
    if (mr && mr.state === "recording") {
      mr.stop();
      return;
    }
    setSendError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      recordChunksRef.current = [];
      const mime =
        typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
          ? "audio/webm;codecs=opus"
          : typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported("audio/webm")
            ? "audio/webm"
            : "";
      const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      mediaRecorderRef.current = rec;
      rec.ondataavailable = (ev) => {
        if (ev.data.size > 0) recordChunksRef.current.push(ev.data);
      };
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        mediaRecorderRef.current = null;
        streamRef.current = null;
        const blob = new Blob(recordChunksRef.current, { type: rec.mimeType || "audio/webm" });
        recordChunksRef.current = [];
        setRecordingVoice(false);
        if (blob.size < 300) return;
        const ext = blob.type.includes("ogg") ? "ogg" : "webm";
        const voiceFile = new File([blob], `nota-voz.${ext}`, { type: blob.type || "audio/webm" });
        void sendMediaFile(voiceFile);
      };
      setRecordingVoice(true);
      rec.start(400);
    } catch (e) {
      setSendError(e instanceof Error ? e.message : "No se pudo acceder al micrófono");
      setRecordingVoice(false);
    }
  }

  useEffect(() => {
    return () => {
      try {
        mediaRecorderRef.current?.stop();
      } catch {
        /* noop */
      }
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  loadConversationsRef.current = loadConversations;

  useEffect(() => {
    setSelectedId(null);
    setMessages([]);
  }, [vista]);

  useEffect(() => {
    setLoadingList(true);
    void loadConversations();
  }, [loadConversations, inboxFilterKey]);

  /** Debounce del buscador: sólo es "server-worthy" a partir de 3 caracteres. */
  useEffect(() => {
    const q = listSearch.trim();
    const eff = q.length >= 3 ? q : "";
    if (eff === debouncedSearch) return;
    const t = setTimeout(() => setDebouncedSearch(eff), 350);
    return () => clearTimeout(t);
  }, [listSearch, debouncedSearch]);

  /**
   * Al cambiar la búsqueda debounced, recargar desde el servidor: el fetch resuelve los contactos
   * que matchean y trae SOLO esas conversaciones, sin importar el tope ~1000 del listado.
   */
  useEffect(() => {
    if (!didInitSearchRef.current) {
      didInitSearchRef.current = true;
      return;
    }
    let cancelled = false;
    setSearchLoading(true);
    void (async () => {
      try {
        await loadConversationsRef.current?.({ silent: true });
      } finally {
        if (!cancelled) setSearchLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [debouncedSearch]);

  useEffect(() => {
    listChatQueues()
      .then(setOpsQueues)
      .catch(() => setOpsQueues([]));
    fetchSupervisorAgentLoads()
      .then(setOpsAgentLoads)
      .catch(() => setOpsAgentLoads([]));
  }, []);

  const patchInboxQuery = useCallback(
    (patch: Record<string, string | null | undefined>) => {
      const next = new URLSearchParams(searchParams?.toString() ?? "");
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === undefined || v === "") next.delete(k);
        else next.set(k, v);
      }
      const qs = next.toString();
      const basePath =
        pathname ??
        (mode === "historial" ? "/dashboard/historial-omnicanal" : "/dashboard/conversaciones");
      router.replace(qs ? `${basePath}?${qs}` : basePath);
    },
    [searchParams, router, pathname, mode]
  );

  /** Búsqueda: estado visible ("Buscando…") apenas el usuario tipea ≥3 caracteres o mientras carga. */
  const hasSearchTerm = listSearch.trim().length >= 3;
  const isSearchPending = hasSearchTerm && (searchLoading || listSearch.trim() !== debouncedSearch);

  /** Botón "Buscar": dispara la búsqueda ya (sin esperar el debounce); reintenta si el término no cambió. */
  const runSearchNow = useCallback(() => {
    const eff = listSearch.trim().length >= 3 ? listSearch.trim() : "";
    if (eff !== debouncedSearch) {
      setDebouncedSearch(eff);
    } else {
      setSearchLoading(true);
      void loadConversationsRef.current?.({ silent: true }).finally(() => setSearchLoading(false));
    }
  }, [listSearch, debouncedSearch]);

  /**
   * Filtros de ruteo (Canal/Cola/Asignación): sólo tienen sentido si el cliente usa omnicanal.
   * Con un único canal y sin colas activas (p. ej. este cliente) se ocultan para simplificar la vista.
   * No afecta la query ni el flujo de sorteo: sin filtros seleccionados se listan todas las del alcance.
   */
  const showRoutingFilters = inboxChannels.length > 1 || opsQueues.some((q) => q.is_active);

  useEffect(() => {
    const cola = searchParams?.get("cola")?.trim() ?? "";
    if (!cola || opsQueues.length === 0) return;
    const ok = opsQueues.some((q) => q.id === cola);
    if (!ok) patchInboxQuery({ cola: null });
  }, [opsQueues, searchParams, patchInboxQuery]);

  useEffect(() => {
    const canal = searchParams?.get("canal")?.trim() ?? "";
    if (!canal || inboxChannels.length === 0) return;
    const ok = inboxChannels.some((c) => c.id === canal);
    if (!ok) patchInboxQuery({ canal: null });
  }, [inboxChannels, searchParams, patchInboxQuery]);

  useEffect(() => {
    if (!transferModalOpen) return;
    let cancelled = false;
    setTransferLoadsRefreshing(true);
    void fetchSupervisorAgentLoads()
      .then((rows) => {
        if (!cancelled) setOpsAgentLoads(rows);
      })
      .catch(() => {
        if (!cancelled) setOpsAgentLoads([]);
      })
      .finally(() => {
        if (!cancelled) setTransferLoadsRefreshing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [transferModalOpen]);

  const filteredTransferAgents = useMemo(() => {
    const q = transferAgentSearch.trim().toLowerCase();
    const rows = opsAgentLoads.filter((a) =>
      transferQueueTarget === "" ? true : a.queue_id === transferQueueTarget
    );
    if (!q) return rows;
    return rows.filter(
      (a) =>
        a.nombre.toLowerCase().includes(q) ||
        (a.email && a.email.toLowerCase().includes(q)) ||
        a.queue_nombre.toLowerCase().includes(q)
    );
  }, [opsAgentLoads, transferAgentSearch, transferQueueTarget]);

  function setVista(next: ConversacionesVista) {
    if (mode === "historial") {
      if (next === "inbox") router.push("/dashboard/conversaciones");
      if (next === "bot" && hasActiveBotFlows) router.push("/dashboard/conversaciones?vista=bot");
      return;
    }
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    if (next === "inbox") params.delete("vista");
    else if (next === "bot" && hasActiveBotFlows) params.set("vista", "bot");
    else if (next === "historial") {
      router.push("/dashboard/historial-omnicanal");
      return;
    }
    const qs = params.toString();
    const base = "/dashboard/conversaciones";
    router.push(qs ? `${base}?${qs}` : base);
  }

  useEffect(() => {
    fetchChatChannels()
      .then((ch) => {
        setHasActiveChannel(ch.some((c) => c.activo));
        setInboxChannels(ch.filter((c) => c.activo));
      })
      .catch(() => {
        setHasActiveChannel(null);
        setInboxChannels([]);
      });
  }, []);

  useEffect(() => {
    if (mode !== "inbox") {
      setBotFlowsChecked(true);
      return;
    }
    void hasEmpresaActiveChatFlows().then((v) => {
      setHasActiveBotFlows(v);
      setBotFlowsChecked(true);
    });
  }, [mode]);

  useEffect(() => {
    if (mode !== "inbox") {
      setOpPresenceLoaded(true);
      setOpInQueues(false);
      setOpStatus(null);
      setOpPresenceErr(null);
      return;
    }
    let cancelled = false;
    if (initialOperationalPresence === undefined) {
      setOpPresenceLoaded(false);
    }
    setOpPresenceErr(null);
    void getMyAgentOperationalPresence()
      .then((p) => {
        if (cancelled) return;
        if (p.in_queues) {
          setOpInQueues(true);
          setOpStatus(p.status);
          setOpSince(p.status_changed_at);
        } else {
          setOpInQueues(false);
          setOpStatus(null);
          setOpSince(null);
        }
      })
      .catch((e) => {
        if (cancelled) return;
        if (initialOperationalPresence === undefined) {
          setOpInQueues(false);
          setOpStatus(null);
          setOpSince(null);
        }
        setOpPresenceErr(e instanceof Error ? e.message : "No se pudo cargar estado operativo");
      })
      .finally(() => {
        if (!cancelled) setOpPresenceLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [mode, initialOperationalPresence]);

  useEffect(() => {
    if (mode !== "inbox") return;
    setSessionSinceIso((prev) => prev ?? new Date().toISOString());
  }, [mode]);

  useEffect(() => {
    if (mode !== "inbox" || !opInQueues) return;
    void touchChatAgentInboxHeartbeat();
    const id = window.setInterval(() => void touchChatAgentInboxHeartbeat(), INBOX_HEARTBEAT_INTERVAL_MS);
    const onVis = () => {
      if (document.visibilityState === "visible") void touchChatAgentInboxHeartbeat();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [mode, opInQueues]);

  const applyOperationalStatus = useCallback(async (next: ChatAgentOperationalStatus) => {
    setOpPresenceErr(null);
    setOpPresenceOkMsg(null);
    setOpPresenceBusy(true);
    try {
      const res = await setMyAgentOperationalPresence(next);
      if (!res.applied) {
        if (res.reason === "missing_operational_status_column") {
          setOpPresenceErr(
            "Presencia no disponible en base de datos (falta columna). Ejecutá la migración operational_status en Supabase o contactá soporte."
          );
        } else {
          setOpPresenceErr(res.reason?.trim() || "No se pudo guardar el estado.");
        }
        return;
      }
      const refreshed = await getMyAgentOperationalPresence();
      if (refreshed.in_queues) {
        setOpInQueues(true);
        setOpStatus(refreshed.status);
        setOpSince(refreshed.status_changed_at ?? new Date().toISOString());
      } else {
        setOpInQueues(false);
        setOpStatus(null);
        setOpSince(null);
      }
      setOpPresenceOkMsg(next === "ready" ? "Disponible · guardado" : "En pausa · guardado");
      window.setTimeout(() => setOpPresenceOkMsg(null), 3500);
    } catch (e) {
      setOpPresenceErr(e instanceof Error ? e.message : "No se pudo guardar el estado");
    } finally {
      setOpPresenceBusy(false);
    }
  }, []);

  /** URL legacy: ?vista=historial en inbox → ruta dedicada */
  useEffect(() => {
    if (mode !== "inbox") return;
    if (searchParams?.get("vista") === "historial") {
      router.replace("/dashboard/historial-omnicanal");
    }
  }, [mode, router, searchParams]);

  /** Sin flujos activos, no forzar vista bot */
  useEffect(() => {
    if (mode !== "inbox" || !botFlowsChecked || hasActiveBotFlows) return;
    if (searchParams?.get("vista") !== "bot") return;
    router.replace("/dashboard/conversaciones");
  }, [mode, botFlowsChecked, hasActiveBotFlows, router, searchParams]);

  /**
   * PERF-2A: refetch debounced de respaldo cuando Realtime trae cambios que no
   * podemos parchar incrementalmente (ej. conversación nueva que no está en la
   * lista local o status que la saca del filtro vigente). Coalesce eventos
   * rapidos en una sola llamada y respeta visibilidad.
   */
  const debouncedRefetchTimerRef = useRef<number | null>(null);
  const scheduleListRefetch = useCallback((delayMs = 1500) => {
    if (debouncedRefetchTimerRef.current != null) return;
    debouncedRefetchTimerRef.current = window.setTimeout(() => {
      debouncedRefetchTimerRef.current = null;
      if (document.visibilityState !== "visible") return;
      void loadConversationsRef.current?.({ silent: true });
    }, delayMs);
  }, []);

  /**
   * PERF-2A: aplica un cambio de chat_conversations Realtime sobre la lista local
   * sin recargar todo el inbox. Si la conversación ya no es elegible (status closed
   * o hidden_by_tag=true), se quita. Si llegó un INSERT/UPDATE para una conversación
   * que no está en la lista, se programa un refetch debounced.
   */
  const patchConversationFromRealtime = useCallback(
    (row: Record<string, unknown> | null | undefined) => {
      if (!row || typeof row.id !== "string") return;
      const id = row.id;
      const status = typeof row.status === "string" ? row.status : null;
      const hiddenByTag = row.hidden_by_tag === true;
      const stillInScope = status === "open" || status === "pending";
      setConversations((prev) => {
        const idx = prev.findIndex((c) => c.id === id);
        if (idx < 0) {
          // Conversación no presente en la lista local. Solo si entra al universo
          // visible (open/pending, no oculta) vale la pena reconciliar.
          if (stillInScope && !hiddenByTag) scheduleListRefetch(1500);
          return prev;
        }
        // Si sale del universo visible, quitarla.
        if (!stillInScope || hiddenByTag) {
          return prev.filter((c) => c.id !== id);
        }
        const cur = prev[idx];
        const next = [...prev];
        const lastMessageAt =
          typeof row.last_message_at === "string" ? row.last_message_at : cur.last_message_at;
        const lastMessagePreview =
          typeof row.last_message_preview === "string" ? row.last_message_preview : cur.last_message_preview;
        const unreadCount =
          typeof row.unread_count === "number" ? row.unread_count : cur.unread_count;
        next[idx] = {
          ...cur,
          status: stillInScope ? status ?? cur.status : cur.status,
          priority: typeof row.priority === "string" ? row.priority : cur.priority,
          queue_id: (row.queue_id as string | null) ?? cur.queue_id,
          assigned_agent_id: (row.assigned_agent_id as string | null) ?? cur.assigned_agent_id,
          last_message_at: lastMessageAt,
          last_message_preview: lastMessagePreview,
          unread_count: unreadCount,
          flow_status: typeof row.flow_status === "string" ? row.flow_status : cur.flow_status,
          human_taken_over: row.human_taken_over === true ? true : row.human_taken_over === false ? false : cur.human_taken_over,
          flow_code: typeof row.flow_code === "string" ? row.flow_code : cur.flow_code,
          flow_current_node:
            typeof row.flow_current_node === "string" ? row.flow_current_node : cur.flow_current_node,
        };
        next.sort((a, b) => {
          const ta = a.last_message_at ? new Date(a.last_message_at).getTime() : 0;
          const tb = b.last_message_at ? new Date(b.last_message_at).getTime() : 0;
          return tb - ta;
        });
        return next;
      });
    },
    [scheduleListRefetch]
  );

  /**
   * PERF-2A: ante un INSERT en chat_messages, actualiza last_message_at/preview y
   * unread de la conversación en la lista local sin recargar el inbox. Si la
   * conversación no está en la lista (nueva o fuera del filtro actual), se programa
   * un refetch debounced.
   */
  const patchConversationOnMessageInsert = useCallback(
    (row: Record<string, unknown> | null | undefined) => {
      if (!row || typeof row.conversation_id !== "string") return;
      const convId = row.conversation_id;
      const fromMe = row.from_me === true;
      const createdAt = typeof row.created_at === "string" ? row.created_at : new Date().toISOString();
      const previewRaw = typeof row.content === "string" ? row.content : null;
      const preview = previewRaw ? previewRaw.slice(0, 280) : null;
      setConversations((prev) => {
        const idx = prev.findIndex((c) => c.id === convId);
        if (idx < 0) {
          scheduleListRefetch(1500);
          return prev;
        }
        const cur = prev[idx];
        const next = [...prev];
        const bumpUnread = !fromMe && convId !== selectedIdRef.current;
        next[idx] = {
          ...cur,
          last_message_at: createdAt,
          last_message_preview: preview ?? cur.last_message_preview,
          unread_count: bumpUnread ? (cur.unread_count ?? 0) + 1 : cur.unread_count,
        };
        next.sort((a, b) => {
          const ta = a.last_message_at ? new Date(a.last_message_at).getTime() : 0;
          const tb = b.last_message_at ? new Date(b.last_message_at).getTime() : 0;
          return tb - ta;
        });
        return next;
      });
    },
    [scheduleListRefetch]
  );

  /** Lista: Realtime sobre conversaciones (PERF-2A: merge incremental, sin full refetch). */
  useEffect(() => {
    const channel = supabaseChat
      .channel("conversaciones-inbox-list")
      .on(
        "postgres_changes",
        { event: "*", schema: chatDataSchema, table: "chat_conversations" },
        (payload) => {
          trackInboxRealtimeEvent("conversation", { event: payload.eventType });
          // PERF-2A: parchar en local en vez de full refetch.
          const newRow = payload.new as Record<string, unknown> | null;
          const oldRow = payload.old as Record<string, unknown> | null;
          patchConversationFromRealtime(newRow ?? oldRow);
        }
      )
      .subscribe((status, err) => {
        logRealtimeChannelState({
          channel_name: "conversaciones-inbox-list",
          schema: chatDataSchema,
          table: "chat_conversations",
          status,
          error_message: err instanceof Error ? err.message : err ? String(err) : null,
        });
      });

    return () => {
      void supabaseChat.removeChannel(channel);
    };
  }, [chatDataSchema, supabaseChat, patchConversationFromRealtime]);

  /** Mensajes entrantes: PERF-2A patch local + beep si corresponde (sin full refetch). */
  useEffect(() => {
    const channel = supabaseChat
      .channel("conversaciones-inbox-inbound-messages")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: chatDataSchema, table: "chat_messages" },
        (payload) => {
          trackInboxRealtimeEvent("message_list", { event: payload.eventType });
          const row = payload.new as Record<string, unknown>;
          // PERF-2A: actualizar preview/unread/last_message_at en local.
          patchConversationOnMessageInsert(row);
          // Si el hilo está abierto, el canal por-hilo (más abajo) ya lo agrega via mergeRow.
          // Solo si no hay canal de hilo activo (race), refrescamos puntualmente.
          const convId = typeof row?.conversation_id === "string" ? row.conversation_id : "";
          if (convId && convId === selectedIdRef.current) {
            // El canal por-hilo lo manejará via mergeRow. No disparamos fetch redundante.
          }
          const mid = typeof row?.id === "string" ? row.id : "";
          if (!mid || row.from_me === true) return;
          if (inboundSoundMsgIdsRef.current.has(mid)) return;
          inboundSoundMsgIdsRef.current.add(mid);
          if (inboundSoundMsgIdsRef.current.size > 600) {
            inboundSoundMsgIdsRef.current.clear();
          }
          if (!inboxSoundPrimedRef.current) return;
          if (readInboxNotificationSoundEnabled()) {
            playInboxNotificationBeep();
          }
        }
      )
      .subscribe((status, err) => {
        logRealtimeChannelState({
          channel_name: "conversaciones-inbox-inbound-messages",
          schema: chatDataSchema,
          table: "chat_messages",
          status,
          error_message: err instanceof Error ? err.message : err ? String(err) : null,
        });
      });

    return () => {
      void supabaseChat.removeChannel(channel);
    };
  }, [chatDataSchema, supabaseChat, patchConversationOnMessageInsert]);

  /**
   * PERF-2A: red de seguridad si Realtime falla (publicación RLS, websocket caído).
   * Antes corría cada 2.8s con full refetch — eso saturaba el pool.
   * Ahora 60s, solo cuando la pestaña está visible. Realtime sigue siendo el motor principal.
   */
  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      trackInboxPollingList({ visibility: "visible" });
      void loadConversationsRef.current?.({ silent: true });
    }, 60_000);
    return () => window.clearInterval(id);
  }, []);

  /** Al volver a la pestaña, sincronizar de inmediato (evita depender solo del intervalo). */
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState !== "visible") return;
      void loadConversationsRef.current?.({ silent: true });
      const sid = selectedIdRef.current;
      if (sid) void loadMessagesRef.current(sid, { silent: true });
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  /**
   * PERF-2A: con hilo abierto, el canal por-hilo ya hace merge incremental
   * (mergeRow en INSERT y UPDATE). Antes corría además un setInterval(2.8s)
   * con full refetch del hilo — eso era el doble de tráfico que el inbox.
   * Ahora 30s, solo como red de seguridad si Realtime de mensajes falla.
   */
  useEffect(() => {
    if (!selectedId) return;
    const id = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      trackInboxPollingThread({ has_selected: true });
      void loadMessagesRef.current(selectedId, { silent: true });
    }, 30_000);
    return () => window.clearInterval(id);
  }, [selectedId]);

  /** Mensajes del hilo abierto: INSERT/UPDATE en tiempo real (UPDATE cubre enrich de media YCloud). */
  useEffect(() => {
    if (!selectedId) return;

    const mergeRow = (row: Record<string, unknown>) => {
      if (!row?.id) return;
      const msg = mapRowToMessage(row);
      setMessages((prev) => {
        const i = prev.findIndex((m) => m.id === msg.id);
        let next: ChatMessage[];
        if (i >= 0) {
          next = [...prev];
          next[i] = msg;
        } else {
          next = [...prev, msg].sort(
            (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
          );
        }
        messagesSessionCacheRef.current.set(selectedId, next);
        return next;
      });
    };

    const channel = supabaseChat
      .channel(`conversaciones-msg-${selectedId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: chatDataSchema,
          table: "chat_messages",
          filter: `conversation_id=eq.${selectedId}`,
        },
        (payload) => {
          trackInboxRealtimeEvent("message_thread", { event: "INSERT" });
          mergeRow(payload.new as Record<string, unknown>);
        }
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: chatDataSchema,
          table: "chat_messages",
          filter: `conversation_id=eq.${selectedId}`,
        },
        (payload) => {
          trackInboxRealtimeEvent("message_thread", { event: "UPDATE" });
          mergeRow(payload.new as Record<string, unknown>);
        }
      )
      .subscribe((status, err) => {
        logRealtimeChannelState({
          channel_name: `conversaciones-msg-${selectedId}`,
          schema: chatDataSchema,
          table: "chat_messages",
          status,
          error_message: err instanceof Error ? err.message : err ? String(err) : null,
        });
      });

    return () => {
      void supabaseChat.removeChannel(channel);
    };
  }, [selectedId, chatDataSchema, supabaseChat]);

  const onMessagesScroll = useCallback(() => {
    const el = messagesScrollRef.current;
    if (!el) return;
    const threshold = 100;
    stickBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
  }, []);

  useLayoutEffect(() => {
    if (!selectedId || messages.length === 0) return;
    const last = messages[messages.length - 1]?.id;
    const prev = lastMessageIdRef.current;
    lastMessageIdRef.current = last;

    if (last === prev) return;

    const el = messagesScrollRef.current;
    if (!el) return;
    if (!stickBottomRef.current && prev !== null) return;

    el.scrollTop = el.scrollHeight;
  }, [messages, selectedId]);

  const handleSelect = useCallback(
    async (id: string) => {
      stickBottomRef.current = true;
      lastMessageIdRef.current = null;
      setMessagesError(null);
      setSelectedId(id);
      await loadMessages(id);
      const compOn = conversations.some(
        (c) => c.id === id && c.channel.comprobante_validation_enabled === true
      );
      if (compOn) {
        setCompLoading(true);
        try {
          const rows = await fetchComprobanteValidacionesForConversation(id);
          setCompVals(rows);
        } catch {
          setCompVals([]);
        } finally {
          setCompLoading(false);
        }
      } else {
        setCompVals([]);
        setCompLoading(false);
      }
      try {
        await markConversationRead(id);
        setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, unread_count: 0 } : c)));
      } catch {
        /* no bloquear UI */
      }
    },
    [loadMessages, conversations]
  );

  async function handleSendFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !selectedId || uploadingFile) return;
    await sendMediaFile(file);
  }

  async function handleReleaseToBot() {
    if (!selectedId || releasingBot) return;
    setReleasingBot(true);
    setSendError(null);
    try {
      await releaseConversationToBot(selectedId);
      await loadConversations({ silent: true });
      if (vista === "inbox") {
        setSelectedId(null);
        setMessages([]);
      }
    } catch (err) {
      setSendError(err instanceof Error ? err.message : "No se pudo devolver al bot");
    } finally {
      setReleasingBot(false);
    }
  }

  useEffect(() => {
    if (!resendFlowNotice) return;
    const t = window.setTimeout(() => setResendFlowNotice(null), 5000);
    return () => window.clearTimeout(t);
  }, [resendFlowNotice]);

  async function handleResendCurrentFlowStep() {
    if (!selectedId || resendFlowStepLoading) return;
    const sel = conversationsRef.current.find((c) => c.id === selectedId);
    if (!sel?.flow_code?.trim() || !sel?.flow_current_node?.trim() || sel.status === "closed") return;

    let confirmHumanOverride = false;
    if (sel.human_taken_over || sel.flow_status === "human") {
      const ok = window.confirm(
        "La conversación está en modo humano. ¿Reenviar igualmente el mensaje del paso actual del bot?"
      );
      if (!ok) return;
      confirmHumanOverride = true;
    }

    const postOnce = async (override: boolean) => {
      const res = await fetchWithSupabaseSession(
        `/api/chat/conversations/${encodeURIComponent(selectedId)}/resend-current-node`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ confirm_human_override: override }),
        }
      );
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        needs_human_override_confirmation?: boolean;
      };
      return { res, json };
    };

    setResendFlowStepLoading(true);
    setResendFlowNotice(null);
    setSendError(null);
    try {
      let { res, json } = await postOnce(confirmHumanOverride);
      if (res.status === 409 && json.needs_human_override_confirmation) {
        const ok = window.confirm(
          "La conversación está en modo humano. ¿Reenviar igualmente el mensaje del paso actual del bot?"
        );
        if (!ok) return;
        ({ res, json } = await postOnce(true));
      }
      if (!res.ok || !json.ok) {
        const errMsg =
          typeof json.error === "string" && json.error.trim()
            ? json.error.trim()
            : "No se pudo reenviar el paso actual. Revisá el estado del canal o los logs.";
        setResendFlowNotice({ kind: "err", text: errMsg });
        return;
      }
      setResendFlowNotice({ kind: "ok", text: "Paso actual reenviado correctamente." });
      await loadMessages(selectedId, { silent: true });
      await loadConversations({ silent: true });
    } catch {
      setResendFlowNotice({
        kind: "err",
        text: "No se pudo reenviar el paso actual. Revisá el estado del canal o los logs.",
      });
    } finally {
      setResendFlowStepLoading(false);
    }
  }

  async function runConversationOp(fn: () => Promise<void>) {
    if (!selectedId || opsBusy) return;
    setOpsBusy(true);
    setSendError(null);
    try {
      await fn();
      await loadConversations({ silent: true });
    } catch (e) {
      setSendError(e instanceof Error ? e.message : "Error en la acción");
    } finally {
      setOpsBusy(false);
    }
  }

  async function openFinalizeModal() {
    const sel = selectedId ? conversations.find((c) => c.id === selectedId) : null;
    if (!selectedId || !sel || sel.status === "closed") return;
    setFinalizeModalError(null);
    setFinalizeOpen(true);
    setFinalizeLoading(true);
    setFinalizeOptions(null);
    setFinalizeStateId("");
    setFinalizeSubstateId("");
    setFinalizeComment("");
    try {
      const opts = await loadFinalizeOptionsForConversation(selectedId);
      setFinalizeOptions(opts);
      const first = opts.states[0];
      if (first) {
        setFinalizeStateId(first.id);
        setFinalizeSubstateId(first.substates[0]?.id ?? "");
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "No se pudieron cargar las opciones de cierre";
      setFinalizeModalError(msg);
      if (msg.includes("finalizada")) {
        setFinalizeOpen(false);
      }
    } finally {
      setFinalizeLoading(false);
    }
  }

  function closeFinalizeModal() {
    if (finalizeSaving) return;
    setFinalizeOpen(false);
    setFinalizeModalError(null);
  }

  async function confirmFinalize() {
    if (!selectedId || !finalizeOptions) return;
    setFinalizeModalError(null);
    const st = finalizeOptions.states.find((x) => x.id === finalizeStateId);
    if (!st) {
      setFinalizeModalError("Elegí un estado.");
      return;
    }
    if (st.substates.length > 0 && !finalizeSubstateId) {
      setFinalizeModalError("Elegí un subestado.");
      return;
    }
    const comment = finalizeComment.trim();
    if (comment.length < 3) {
      setFinalizeModalError("El comentario es obligatorio (al menos 3 caracteres).");
      return;
    }
    const sub = st.substates.find((x) => x.id === finalizeSubstateId);
    setFinalizeSaving(true);
    try {
      await finalizeConversationWithClosure({
        conversationId: selectedId,
        closureStateId: st.id,
        closureSubstateId: st.substates.length > 0 ? finalizeSubstateId : null,
        closureStateLabel: st.label,
        closureSubstateLabel: sub?.label ?? (st.substates.length > 0 ? "" : "—"),
        comment,
      });
      setFinalizeOpen(false);
      setFinalizeOptions(null);
      if (mode === "inbox") {
        setSelectedId(null);
        setMessages([]);
      }
      await loadConversations({ silent: true });
    } catch (e) {
      setFinalizeModalError(e instanceof Error ? e.message : "No se pudo finalizar la conversación");
    } finally {
      setFinalizeSaving(false);
    }
  }

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedId || !input.trim() || sending) return;
    setSending(true);
    setSendError(null);
    stickBottomRef.current = true;
    try {
      const res = await fetchWithSupabaseSession("/api/chat/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ conversation_id: selectedId, message: input.trim() }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        error?: string;
        meta?: unknown;
      };
      if (!res.ok) {
        const base =
          typeof json.error === "string"
            ? json.error
            : res.status === 401
              ? "Sesión expirada o no autenticado"
              : `Error al enviar (HTTP ${res.status})`;
        throw new Error(base);
      }
      setInput("");
      setSendError(null);
      await loadMessages(selectedId, { silent: true });
      await loadConversations({ silent: true });
    } catch (err) {
      setSendError(err instanceof Error ? err.message : "Error al enviar");
    } finally {
      setSending(false);
    }
  }

  const visibleConversations = useMemo(() => {
    const q = listSearch.trim().toLowerCase();
    if (!q) return conversations;
    const qDigits = q.replace(/\D/g, "");
    /**
     * Normaliza a "número nacional significativo" PY: sin código país `595` ni `0` de troncal.
     * Así `0992419766` (local), `992419766` y `595992419766` (internacional) matchean el mismo
     * contacto. Los números se guardan en formato internacional (595…), pero el usuario suele
     * tipear el local con `0` inicial, que rompía el match por substring.
     */
    const toNat = (d: string) => {
      let x = d;
      if (x.startsWith("595")) x = x.slice(3);
      x = x.replace(/^0+/, "");
      return x;
    };
    const qNat = toNat(qDigits);
    return conversations.filter((c) => {
      const name = (c.contact.name || "").toLowerCase();
      const phone = String(c.contact.phone_number || "");
      const phoneDigits = phone.replace(/\D/g, "");
      if (name.includes(q)) return true;
      if (phone.toLowerCase().includes(q)) return true;
      if (qDigits.length > 0 && phoneDigits.includes(qDigits)) return true;
      if (qNat.length > 0 && toNat(phoneDigits).includes(qNat)) return true;
      return false;
    });
  }, [conversations, listSearch]);

  const selected = conversations.find((c) => c.id === selectedId);
  const canResendCurrentFlowStep = Boolean(
    selected &&
      selected.status !== "closed" &&
      selected.flow_code?.trim() &&
      selected.flow_current_node?.trim()
  );
  const isHumanActive =
    !!selected && (selected.human_taken_over || selected.flow_status === "human");
  const requestedConversationId = searchParams?.get("conversationId") ?? null;

  useEffect(() => {
    const chId = selected?.channel?.id?.trim();
    if (!chId || vista === "bot") {
      setChannelQuickReplies([]);
      setQuickReplyOpen(false);
      setQuickReplySearch("");
      return;
    }
    let cancelled = false;
    setQuickRepliesLoading(true);
    void listActiveQuickRepliesForChannel(chId)
      .then((rows) => {
        if (!cancelled) {
          setChannelQuickReplies(rows.map((r) => ({ id: r.id, title: r.title, body: r.body })));
        }
      })
      .catch(() => {
        if (!cancelled) setChannelQuickReplies([]);
      })
      .finally(() => {
        if (!cancelled) setQuickRepliesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selected?.channel?.id, vista]);

  useEffect(() => {
    if (selected?.channel.quick_replies_inbox_enabled === false) {
      setQuickReplyOpen(false);
    }
  }, [selected?.channel.quick_replies_inbox_enabled]);

  useEffect(() => {
    if (!quickReplyOpen) return;
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape") setQuickReplyOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [quickReplyOpen]);

  useEffect(() => {
    if (!quickReplyOpen) return;
    function onDoc(ev: MouseEvent) {
      const el = quickReplyPanelRef.current;
      if (!el) return;
      const t = ev.target;
      if (t instanceof Node && el.contains(t)) return;
      setQuickReplyOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [quickReplyOpen]);

  const filteredQuickReplies = useMemo(() => {
    const q = quickReplySearch.trim().toLowerCase();
    if (!q) return channelQuickReplies;
    return channelQuickReplies.filter(
      (r) =>
        r.title.toLowerCase().includes(q) ||
        r.body.toLowerCase().includes(q)
    );
  }, [channelQuickReplies, quickReplySearch]);

  function insertQuickReplyBody(text: string) {
    const t = text.trim();
    if (!t) return;
    setInput((prev) => {
      if (!prev.trim()) return t;
      return `${prev.trimEnd()}\n\n${t}`;
    });
    setQuickReplyOpen(false);
    setQuickReplySearch("");
  }

  useEffect(() => {
    if (!requestedConversationId || !conversations.length) return;
    if (selectedId === requestedConversationId) return;
    const exists = conversations.some((c) => c.id === requestedConversationId);
    if (!exists) return;
    void handleSelect(requestedConversationId);
  }, [requestedConversationId, conversations, selectedId, handleSelect]);

  const transferFromUrl = searchParams?.get("transferir") === "1";
  const transferUrlConsumed = useRef(false);
  useEffect(() => {
    transferUrlConsumed.current = false;
  }, [transferFromUrl, requestedConversationId]);

  useEffect(() => {
    if (!transferFromUrl || !requestedConversationId) return;
    if (selectedId !== requestedConversationId) return;
    if (transferUrlConsumed.current) return;
    transferUrlConsumed.current = true;
    setTransferModalOpen(true);
    patchInboxQuery({ transferir: null });
  }, [transferFromUrl, requestedConversationId, selectedId, patchInboxQuery]);

  useEffect(() => {
    if (selectedId && !conversations.some((c) => c.id === selectedId)) {
      setSelectedId(null);
      setMessages([]);
    }
  }, [conversations, selectedId]);

  useEffect(() => {
    setCompValidacionesOpen(false);
    setCompApprovalInfo(null);
  }, [selectedId]);

  useEffect(() => {
    if (!finalizeOptions || !finalizeStateId) return;
    const st = finalizeOptions.states.find((s) => s.id === finalizeStateId);
    if (!st) return;
    setFinalizeSubstateId((prev) =>
      st.substates.some((sub) => sub.id === prev) ? prev : st.substates[0]?.id ?? ""
    );
  }, [finalizeStateId, finalizeOptions]);

  return (
    <div className="flex flex-col flex-1 min-h-0 h-[calc(100dvh-4.75rem)] max-h-[calc(100dvh-4.75rem)] gap-1 overflow-hidden">
      {lightboxUrl ? (
        <button
          type="button"
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-4 border-0 cursor-zoom-out"
          onClick={() => setLightboxUrl(null)}
          aria-label="Cerrar vista ampliada"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={lightboxUrl}
            alt="Vista ampliada"
            className="max-h-[92vh] max-w-full object-contain rounded-lg shadow-2xl"
            onClick={(ev) => ev.stopPropagation()}
          />
        </button>
      ) : null}

      {compApproveConfirmId ? (
        <div
          className="fixed inset-0 z-[105] flex items-center justify-center bg-black/40 p-4"
          role="presentation"
          onClick={() => setCompApproveConfirmId(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            className="w-full max-w-md rounded-2xl border border-slate-200 bg-white shadow-xl p-5"
            onClick={(ev) => ev.stopPropagation()}
          >
            <p className="text-sm text-slate-800 font-medium">Confirmar aprobación</p>
            <p className="mt-2 text-xs text-slate-600 leading-relaxed">
              ¿Confirmás aprobar este comprobante y cerrar la compra? Esto generará cupones y enviará el resumen al
              cliente por WhatsApp (y el ticket PNG si el sorteo lo tiene configurado).
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
                onClick={() => setCompApproveConfirmId(null)}
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={Boolean(compActionId)}
                className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                onClick={() => {
                  const vid = compApproveConfirmId;
                  const convId = selectedId;
                  if (!vid || !convId) return;
                  setCompApproveConfirmId(null);
                  void (async () => {
                    setCompActionId(vid);
                    setSendError(null);
                    setCompApprovalInfo(null);
                    try {
                      const res = await approveComprobanteValidacion(vid);
                      if (!res.ok) {
                        setSendError(res.message);
                      } else if (res.mode === "pending_participant_data") {
                        const parts = [
                          "Comprobante aprobado. Faltan datos del participante; el bot continuará la carga por WhatsApp.",
                          res.nextNodeCode ? `(Siguiente paso: ${res.nextNodeCode})` : "",
                          res.missingFields?.length
                            ? `Pendiente: ${res.missingFields.join(", ")}.`
                            : "",
                        ].filter(Boolean);
                        if (res.whatsappWarning) parts.push(`WhatsApp: ${res.whatsappWarning}`);
                        setCompApprovalInfo(parts.join(" "));
                      } else if (res.mode === "pending_final_confirmation") {
                        const parts = [
                          "Comprobante aprobado. El cliente debe confirmar en el resumen del chat para crear la orden.",
                          res.nextNodeCode ? `(Paso: ${res.nextNodeCode})` : "",
                        ].filter(Boolean);
                        if (res.whatsappWarning) parts.push(`WhatsApp: ${res.whatsappWarning}`);
                        setCompApprovalInfo(parts.join(" "));
                      } else if (res.mode === "order_closed") {
                        const parts = [
                          res.reused ? "Orden ya existente (reutilizada)." : "Compra cerrada.",
                          `Orden Nº ${res.numeroOrden}.`,
                          `${res.cuponesCount} cupón(es).`,
                        ];
                        if (res.whatsappWarning) parts.push(`WhatsApp: ${res.whatsappWarning}`);
                        if (res.ticketWarning) parts.push(`Ticket: ${res.ticketWarning}`);
                        setCompApprovalInfo(parts.join(" "));
                      }
                      const rows = await fetchComprobanteValidacionesForConversation(convId);
                      setCompVals(rows);
                    } catch (e) {
                      setSendError(e instanceof Error ? e.message : "No se pudo aprobar el comprobante");
                    } finally {
                      setCompActionId(null);
                    }
                  })();
                }}
              >
                Aprobar y cerrar
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {finalizeOpen ? (
        <div
          className="fixed inset-0 z-[110] flex items-center justify-center bg-black/40 p-4"
          role="presentation"
          onClick={() => closeFinalizeModal()}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="finalize-chat-title"
            className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-xl"
            onClick={(ev) => ev.stopPropagation()}
          >
            <h2 id="finalize-chat-title" className="text-lg font-semibold text-slate-900">
              Finalizar conversación
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              Completá el cierre para guardar el resultado en el historial. Todos los campos son obligatorios.
            </p>
            {finalizeLoading ? (
              <p className="mt-4 text-sm text-slate-500">Cargando opciones…</p>
            ) : finalizeOptions && finalizeOptions.states.length > 0 ? (
              <div className="mt-4 space-y-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-500 uppercase mb-1">Estado</label>
                  <select
                    className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
                    value={finalizeStateId}
                    onChange={(e) => setFinalizeStateId(e.target.value)}
                  >
                    {finalizeOptions.states.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </div>
                {(() => {
                  const st = finalizeOptions.states.find((s) => s.id === finalizeStateId);
                  if (!st || st.substates.length === 0) return null;
                  return (
                    <div>
                      <label className="block text-xs font-semibold text-slate-500 uppercase mb-1">Subestado</label>
                      <select
                        className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
                        value={finalizeSubstateId}
                        onChange={(e) => setFinalizeSubstateId(e.target.value)}
                      >
                        <option value="">Elegir…</option>
                        {st.substates.map((sub) => (
                          <option key={sub.id} value={sub.id}>
                            {sub.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  );
                })()}
                <div>
                  <label className="block text-xs font-semibold text-slate-500 uppercase mb-1">Comentario</label>
                  <textarea
                    className="w-full min-h-[88px] border border-slate-200 rounded-lg px-3 py-2 text-sm resize-y"
                    value={finalizeComment}
                    onChange={(e) => setFinalizeComment(e.target.value)}
                    placeholder="Resumí el resultado o próximos pasos para el equipo."
                  />
                </div>
                {finalizeOptions.source === "fallback" ? (
                  <p className="text-xs text-amber-800 bg-amber-50 border border-amber-100 rounded-lg px-2 py-1.5">
                    Esta cola no tiene estados propios configurados. Se muestran opciones por defecto hasta que un
                    administrador los defina en la configuración de la cola.
                  </p>
                ) : null}
              </div>
            ) : (
              <p className="mt-4 text-sm text-red-700">No hay estados de cierre disponibles.</p>
            )}
            {finalizeModalError ? (
              <p className="mt-3 text-sm text-red-700 bg-red-50 border border-red-100 rounded-lg px-2 py-1.5">
                {finalizeModalError}
              </p>
            ) : null}
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                disabled={finalizeSaving}
                onClick={() => closeFinalizeModal()}
                className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={finalizeSaving || finalizeLoading || !finalizeOptions || finalizeOptions.states.length === 0}
                onClick={() => void confirmFinalize()}
                className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
              >
                {finalizeSaving ? "Guardando…" : "Confirmar finalización"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {transferModalOpen && selected && vista !== "bot" ? (
        <div
          className="fixed inset-0 z-[115] flex items-center justify-center bg-black/40 p-4"
          role="presentation"
          onClick={() => setTransferModalOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="transfer-chat-title"
            className="w-full max-w-lg max-h-[min(92vh,720px)] overflow-hidden flex flex-col rounded-2xl border border-slate-200 bg-white shadow-xl"
            onClick={(ev) => ev.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-4 shrink-0">
              <div>
                <h2 id="transfer-chat-title" className="text-lg font-semibold text-slate-900">
                  Transferir conversación
                </h2>
                <p className="mt-0.5 text-xs text-slate-500">
                  Elegí cola y/o agente. Los números reflejan chats abiertos asignados al agente.
                </p>
              </div>
              <button
                type="button"
                className="rounded-lg border border-slate-200 px-2.5 py-1 text-sm text-slate-600 hover:bg-slate-50 shrink-0"
                onClick={() => setTransferModalOpen(false)}
                aria-label="Cerrar"
              >
                ✕
              </button>
            </div>

            <div className="px-5 py-4 space-y-5 overflow-y-auto overscroll-contain flex-1 min-h-0">
              <div>
                <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wide mb-2">
                  Colas
                </label>
                <div className="flex flex-wrap gap-2">
                  <select
                    disabled={opsBusy}
                    className="flex-1 min-w-[12rem] border border-slate-200 rounded-xl px-3 py-2.5 text-sm bg-white"
                    value={transferQueueTarget}
                    onChange={(e) => setTransferQueueTarget(e.target.value)}
                    aria-label="Cola destino y filtro de agentes"
                  >
                    <option value="">Todas las colas (tu alcance)</option>
                    {opsQueues
                      .filter((q) => q.is_active)
                      .map((q) => (
                        <option key={q.id} value={q.id}>
                          {q.nombre}
                        </option>
                      ))}
                  </select>
                  <button
                    type="button"
                    disabled={opsBusy || !transferQueueTarget}
                    onClick={() =>
                      void runConversationOp(async () => {
                        await changeConversationQueue(selected.id, transferQueueTarget);
                        setTransferModalOpen(false);
                      })
                    }
                    className="shrink-0 rounded-xl bg-[#4FAEB2] px-5 py-2.5 text-sm font-semibold text-white shadow-sm shadow-[#4FAEB2]/20 hover:bg-[#3F8E91] disabled:opacity-50 disabled:pointer-events-none"
                  >
                    Transferir
                  </button>
                </div>
              </div>

              <div>
                <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                  <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wide">
                    Agentes
                  </label>
                  <input
                    type="search"
                    value={transferAgentSearch}
                    onChange={(e) => setTransferAgentSearch(e.target.value)}
                    placeholder="Buscar"
                    className="w-full max-w-[14rem] border border-slate-200 rounded-xl px-3 py-2 text-sm bg-white placeholder:text-slate-400 outline-none focus:ring-2 focus:ring-[#4FAEB2]/20 focus:border-[#4FAEB2]"
                    aria-label="Buscar agente"
                  />
                </div>
                {transferLoadsRefreshing ? (
                  <p className="text-sm text-slate-500 py-6 text-center">Actualizando agentes…</p>
                ) : (
                  <div className="rounded-xl border border-slate-200 divide-y divide-slate-100 max-h-[min(42vh,320px)] overflow-y-auto overscroll-contain bg-slate-50/40">
                    {filteredTransferAgents.length === 0 ? (
                      <p className="text-sm text-slate-500 px-4 py-6 text-center">
                        No hay agentes para mostrar con estos filtros.
                      </p>
                    ) : (
                      filteredTransferAgents.map((a) => {
                        const roleLabel = omnicanalRoleShortLabel(a.omnicanal_role);
                        const isCurrent = a.id === selected.assigned_agent_id;
                        return (
                          <button
                            key={a.id}
                            type="button"
                            disabled={opsBusy || isCurrent}
                            onClick={() =>
                              void runConversationOp(async () => {
                                await assignConversationToAgent(selected.id, a.id);
                                setTransferModalOpen(false);
                              })
                            }
                            className={`w-full text-left px-4 py-3 transition-colors hover:bg-white disabled:opacity-50 disabled:pointer-events-none ${
                              isCurrent ? "bg-emerald-50/80" : ""
                            }`}
                          >
                            <div className="flex items-start justify-between gap-2">
                              <span className="font-semibold text-slate-900 text-sm leading-snug">{a.nombre}</span>
                              {roleLabel ? (
                                <span
                                  className={`text-[10px] font-semibold px-2 py-0.5 rounded-md border shrink-0 ${omnicanalRoleBadgeClass(a.omnicanal_role)}`}
                                >
                                  {roleLabel}
                                </span>
                              ) : null}
                            </div>
                            <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                              <span className="text-[10px] px-2 py-0.5 rounded-full bg-white text-slate-700 border border-slate-200">
                                {a.queue_nombre}
                              </span>
                              <span className="text-[11px] text-slate-500">
                                {a.operational_status === "offline" ? "En pausa" : "Disponible"}
                                {!a.is_online ? " · sin sesión" : ""}
                              </span>
                            </div>
                            <div className="flex justify-end mt-2">
                              <span className="text-[11px] text-slate-600 tabular-nums">
                                <span className="inline-flex items-center rounded border border-slate-200 bg-white px-1.5 py-0.5 font-semibold text-slate-800">
                                  {a.active_conversations}
                                </span>{" "}
                                Activos
                              </span>
                            </div>
                          </button>
                        );
                      })
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* Toggle "Ocultar / Mostrar barra" — siempre visible. Persiste en
          localStorage. Permite maximizar el espacio del chat. */}
      <div className="flex shrink-0 items-center justify-end">
        <button
          type="button"
          onClick={() => setHeaderCollapsed((v) => !v)}
          className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-[11px] font-semibold text-slate-600 shadow-sm transition-colors hover:border-[#4FAEB2]/60 hover:bg-[#4FAEB2]/5 hover:text-[#3F8E91]"
          title={headerCollapsed ? "Mostrar barra superior" : "Ocultar barra superior"}
          aria-pressed={headerCollapsed}
        >
          {headerCollapsed ? (
            <>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-3.5 w-3.5"
                aria-hidden="true"
              >
                <polyline points="6 9 12 15 18 9" />
              </svg>
              Mostrar barra
            </>
          ) : (
            <>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-3.5 w-3.5"
                aria-hidden="true"
              >
                <polyline points="18 15 12 9 6 15" />
              </svg>
              Ocultar barra
            </>
          )}
        </button>
      </div>

      {!headerCollapsed ? (
      <>
      <div className="flex flex-wrap items-center justify-between gap-3 shrink-0">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="inline-block h-2 w-2 shrink-0 rounded-full bg-[#4FAEB2] shadow-[0_0_0_3px_rgba(79,174,178,0.18)]"
            />
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#4FAEB2]">
              Omnicanal
            </p>
          </div>
          <h1 className="mt-1 text-xl sm:text-2xl font-semibold tracking-tight text-slate-900 leading-tight truncate">
            {agentDisplayName}
          </h1>
          <p className="text-xs text-slate-500 leading-snug mt-1">
            {mode === "historial"
              ? "Historial omnicanal"
              : vista === "inbox"
                ? "Inbox"
                : "Bot"}
            {mode === "historial" ? (
              <>
                {" · "}
                <Link href="/dashboard/conversaciones" className="text-[#4FAEB2] hover:underline font-medium">
                  Inbox
                </Link>
              </>
            ) : null}
          </p>
        </div>
        {mode === "inbox" && opPresenceLoaded && !opInQueues ? (
          initialCabeceraInsignia === "admin" ? (
            <div className="flex flex-col items-end gap-1 shrink-0 max-w-[20rem] text-right">
              <span className="inline-flex items-center rounded-full bg-slate-800 px-3 py-1 text-[10px] font-bold uppercase tracking-wide text-white">
                Administrador
              </span>
              <span className="text-[10px] text-slate-600 leading-snug">
                Sin puesto en colas ·{" "}
                <Link href="/configuracion/colas" className="font-semibold text-[#4FAEB2] hover:underline">
                  Colas
                </Link>
              </span>
            </div>
          ) : initialCabeceraInsignia === "supervisor" ? (
            <div className="flex flex-col items-end gap-1 shrink-0 max-w-[20rem] text-right">
              <span className="inline-flex items-center rounded-full bg-indigo-800 px-3 py-1 text-[10px] font-bold uppercase tracking-wide text-white">
                Supervisor
              </span>
              <span className="text-[10px] text-slate-600 leading-snug">
                Sin fila de agente en colas ·{" "}
                <Link href="/configuracion/colas" className="font-semibold text-[#4FAEB2] hover:underline">
                  Colas
                </Link>
              </span>
            </div>
          ) : (
            <div className="text-[10px] text-amber-900 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1.5 max-w-[18rem] text-right leading-snug shrink-0">
              No figurás como agente en ninguna cola: no se muestra el turno Disponible/Pausa. Pedí asignación en{" "}
              <Link href="/configuracion/colas" className="font-semibold text-amber-950 underline-offset-2 hover:underline">
                Configuración → Colas
              </Link>
              .
            </div>
          )
        ) : null}
        {mode === "inbox" && opPresenceLoaded && opInQueues && opStatus !== null ? (
          <div
            className="flex flex-col items-end gap-1 shrink-0"
            role="group"
            aria-label="Disponible u en pausa para recibir chats nuevos por autoasignación"
          >
            <div className="flex flex-col items-end gap-0.5">
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Tu turno</span>
                {opPresenceBusy ? (
                  <span className="text-[10px] font-medium text-[#4FAEB2] animate-pulse">Guardando…</span>
                ) : null}
              </div>
              <p className="text-[11px] font-bold text-slate-800 tabular-nums">
                Estado actual:{" "}
                <span className={opStatus === "ready" ? "text-emerald-700" : "text-slate-600"}>
                  {opStatus === "ready" ? "Disponible" : "En pausa"}
                </span>
              </p>
            </div>
            <div className="flex items-center gap-0.5 rounded-lg border border-slate-300 bg-slate-100 p-0.5 shadow-inner">
              <button
                type="button"
                disabled={opPresenceBusy}
                className={opPresenceToggleClass(opStatus === "ready", "ready")}
                aria-pressed={opStatus === "ready"}
                aria-label="Marcar disponible para autoasignación (ready)"
                onClick={() => void applyOperationalStatus("ready")}
              >
                Disponible
              </button>
              <button
                type="button"
                disabled={opPresenceBusy}
                className={opPresenceToggleClass(opStatus === "offline", "offline")}
                aria-pressed={opStatus === "offline"}
                aria-label="Pausar recepción de chats nuevos por autoasignación (offline)"
                onClick={() => void applyOperationalStatus("offline")}
              >
                En pausa
              </button>
            </div>
            <span className="text-[10px] text-slate-500 max-w-[15rem] text-right leading-tight hidden sm:block">
              Disponible = entrás en la rotación de nuevos chats. En pausa = no recibís asignaciones automáticas.
            </span>
            <div className="text-[10px] text-slate-700 text-right leading-tight w-full">
              <span className="text-slate-500">
                {opStatus === "ready" ? "Tiempo en Disponible" : "Tiempo en pausa"}:{" "}
              </span>
              {opSince ? (
                <LiveElapsedLabel sinceIso={opSince} />
              ) : (
                <span className="text-slate-400 italic">sin marca de tiempo en DB</span>
              )}
            </div>
            {sessionSinceIso ? (
              <div className="text-[10px] text-slate-600 text-right leading-tight w-full border-t border-slate-200/80 pt-1 mt-0.5">
                <span className="text-slate-500">Sesión en inbox:</span>{" "}
                <LiveElapsedLabel sinceIso={sessionSinceIso} />
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      {mode === "inbox" && sessionSinceIso && !opInQueues ? (
        <div className="flex justify-end w-full shrink-0 -mt-1">
          <p className="text-[10px] text-slate-500 tabular-nums">
            Sesión en inbox: <LiveElapsedLabel sinceIso={sessionSinceIso} />
          </p>
        </div>
      ) : null}
      {mode === "inbox" && opPresenceErr ? (
        <div className="bg-amber-50 border border-amber-200 text-amber-900 text-xs rounded-lg px-2 py-1.5 shrink-0">
          {opPresenceErr}
        </div>
      ) : null}
      {mode === "inbox" && opPresenceOkMsg ? (
        <div className="bg-emerald-50 border border-emerald-200 text-emerald-900 text-xs rounded-lg px-2 py-1.5 shrink-0 font-medium">
          {opPresenceOkMsg}
        </div>
      ) : null}

      {mode === "inbox" ? (
        <div className="flex flex-wrap items-stretch gap-2 shrink-0 min-w-0">
          <div className="flex flex-wrap gap-1 rounded-lg border border-slate-200 bg-slate-100/80 p-1 w-fit shrink-0 self-center">
            <button type="button" className={tabClass(vista === "inbox")} onClick={() => setVista("inbox")}>
              Inbox
            </button>
            {hasActiveBotFlows ? (
              <button type="button" className={tabClass(vista === "bot")} onClick={() => setVista("bot")}>
                Bot
              </button>
            ) : null}
          </div>
          <div className="flex items-stretch gap-2 flex-1 min-w-[12rem]">
            <input
              type="search"
              value={listSearch}
              onChange={(e) => setListSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  runSearchNow();
                }
              }}
              placeholder="Buscar por nombre o número"
              className="flex-1 min-w-0 border border-slate-200 rounded-lg px-3 py-2 text-xs text-slate-800 bg-white placeholder:text-slate-400 outline-none focus:ring-2 focus:ring-[#4FAEB2]/20 focus:border-[#4FAEB2]"
              aria-label="Buscar por nombre o número"
            />
            <button
              type="button"
              onClick={runSearchNow}
              disabled={isSearchPending}
              className="shrink-0 inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-xs font-semibold text-white bg-[#4FAEB2] hover:bg-[#3F8E91] disabled:opacity-70 disabled:cursor-not-allowed transition-colors"
              aria-label="Buscar"
            >
              {isSearchPending ? (
                <>
                  <span className="h-3 w-3 rounded-full border-2 border-white/40 border-t-white animate-spin" aria-hidden="true" />
                  Buscando…
                </>
              ) : (
                "Buscar"
              )}
            </button>
          </div>
        </div>
      ) : null}

      {mode === "historial" ? (
        <div className="flex flex-wrap items-stretch gap-2 shrink-0 min-w-0">
          <div className="flex items-stretch gap-2 flex-1 min-w-[12rem]">
            <input
              type="search"
              value={listSearch}
              onChange={(e) => setListSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  runSearchNow();
                }
              }}
              placeholder="Buscar por nombre o número"
              className="flex-1 min-w-0 border border-slate-200 rounded-lg px-3 py-2 text-xs text-slate-800 bg-white placeholder:text-slate-400 outline-none focus:ring-2 focus:ring-[#4FAEB2]/20 focus:border-[#4FAEB2]"
              aria-label="Buscar en historial"
            />
            <button
              type="button"
              onClick={runSearchNow}
              disabled={isSearchPending}
              className="shrink-0 inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-xs font-semibold text-white bg-[#4FAEB2] hover:bg-[#3F8E91] disabled:opacity-70 disabled:cursor-not-allowed transition-colors"
              aria-label="Buscar"
            >
              {isSearchPending ? (
                <>
                  <span className="h-3 w-3 rounded-full border-2 border-white/40 border-t-white animate-spin" aria-hidden="true" />
                  Buscando…
                </>
              ) : (
                "Buscar"
              )}
            </button>
          </div>
        </div>
      ) : null}

      {(mode === "historial" || vista === "inbox") && showRoutingFilters ? (
        <div className="flex flex-wrap items-end gap-3 shrink-0 rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
          <label className="flex flex-col gap-1.5 min-w-[12rem]">
            <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">
              Canal
            </span>
            <select
              className="appearance-none rounded-xl border border-slate-200 bg-white bg-[length:14px_14px] bg-[right_0.7rem_center] bg-no-repeat px-3 py-2 pr-8 text-xs font-medium text-slate-700 shadow-sm outline-none transition-colors hover:border-[#4FAEB2]/60 focus:border-[#4FAEB2] focus:ring-2 focus:ring-[#4FAEB2]/20 min-w-[12rem] max-w-[min(22rem,90vw)]"
              style={{
                backgroundImage:
                  "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke='%234FAEB2' stroke-width='2.5'><path stroke-linecap='round' stroke-linejoin='round' d='M6 9l6 6 6-6'/></svg>\")",
              }}
              value={displayCanal}
              onChange={(e) => {
                const v = e.target.value.trim();
                setPendingCanal(v.length > 0 ? v : "");
                patchInboxQuery({ canal: v.length > 0 ? v : null });
              }}
              aria-label="Filtrar por canal"
            >
              <option value="">Todos los canales</option>
              {inboxChannels.map((c) => (
                <option key={c.id} value={c.id}>
                  {formatChannelOptionLabel(c)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1.5 min-w-[11rem]">
            <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">
              Cola
            </span>
            <select
              className="appearance-none rounded-xl border border-slate-200 bg-white bg-[length:14px_14px] bg-[right_0.7rem_center] bg-no-repeat px-3 py-2 pr-8 text-xs font-medium text-slate-700 shadow-sm outline-none transition-colors hover:border-[#4FAEB2]/60 focus:border-[#4FAEB2] focus:ring-2 focus:ring-[#4FAEB2]/20 min-w-[11rem]"
              style={{
                backgroundImage:
                  "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke='%234FAEB2' stroke-width='2.5'><path stroke-linecap='round' stroke-linejoin='round' d='M6 9l6 6 6-6'/></svg>\")",
              }}
              value={displayCola}
              onChange={(e) => {
                const v = e.target.value.trim();
                setPendingCola(v.length > 0 ? v : "");
                patchInboxQuery({ cola: v.length > 0 ? v : null });
              }}
              aria-label="Filtrar por cola"
            >
              <option value="">Todas (según tu alcance)</option>
              {opsQueues
                .filter((q) => q.is_active)
                .map((q) => (
                  <option key={q.id} value={q.id}>
                    {q.nombre}
                  </option>
                ))}
            </select>
          </label>
          <label className="flex flex-col gap-1.5 min-w-[11rem]">
            <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">
              Asignación
            </span>
            <select
              className="appearance-none rounded-xl border border-slate-200 bg-white bg-[length:14px_14px] bg-[right_0.7rem_center] bg-no-repeat px-3 py-2 pr-8 text-xs font-medium text-slate-700 shadow-sm outline-none transition-colors hover:border-[#4FAEB2]/60 focus:border-[#4FAEB2] focus:ring-2 focus:ring-[#4FAEB2]/20 min-w-[11rem]"
              style={{
                backgroundImage:
                  "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke='%234FAEB2' stroke-width='2.5'><path stroke-linecap='round' stroke-linejoin='round' d='M6 9l6 6 6-6'/></svg>\")",
              }}
              value={displayAsignacion}
              onChange={(e) => {
                const v = e.target.value;
                setPendingAsignacion(v === "" ? "" : v);
                patchInboxQuery({ asignacion: v === "" ? null : v });
              }}
              aria-label="Filtrar por asignación"
            >
              <option value="">Todas</option>
              {opInQueues ? <option value="mios">Asignadas a mí</option> : null}
              <option value="sin_asignar">Sin asignar</option>
            </select>
          </label>
          {initialOmnicanalRole === "supervisor" ? (
            <p className="text-[11px] text-slate-500 max-w-[18rem] leading-snug pb-0.5">
              Colas y vistas acotadas a tu equipo supervisado (mismo criterio que inbox y monitoreo).
            </p>
          ) : null}
        </div>
      ) : null}
      </>
      ) : null}

      {hasActiveChannel === false && (
        <div className="bg-amber-50 border border-amber-200 text-amber-900 text-xs rounded-lg px-2 py-2 shrink-0">
          No hay un canal de conversación activo para tu empresa. Los mensajes no se registrarán hasta configurarlo.
        </div>
      )}

      {listError && (
        <div className="bg-red-50 border border-red-200 text-red-800 text-xs rounded-lg px-2 py-1.5 shrink-0">
          {listError}
        </div>
      )}
      {messagesError && (
        <div className="bg-amber-50 border border-amber-200 text-amber-950 text-xs rounded-lg px-2 py-1.5 shrink-0">
          {messagesError}
        </div>
      )}
      {resendFlowNotice && (
        <div
          className={`text-xs rounded-lg px-2 py-1.5 shrink-0 border ${
            resendFlowNotice.kind === "ok"
              ? "bg-emerald-50 border-emerald-200 text-emerald-900"
              : "bg-red-50 border-red-200 text-red-900"
          }`}
          role="status"
        >
          {resendFlowNotice.text}
        </div>
      )}

      <div className="flex flex-1 min-h-0 border border-slate-200 rounded-lg overflow-hidden bg-white shadow-sm">
        {/* Lista */}
        {!listColumnHidden ? (
        <div
          className={`w-full shrink-0 border-r border-slate-200 flex-col min-h-0 bg-slate-50/80 lg:w-[300px] lg:max-w-[320px] xl:w-[340px] xl:max-w-[360px] lg:flex ${
            selectedId ? "hidden" : "flex"
          }`}
        >
          <div className="px-2 py-1.5 border-b border-slate-200 flex items-center justify-between gap-2 shrink-0">
            <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide">Chats</span>
            <button
              type="button"
              onClick={() => setListColumnHidden(true)}
              className="text-[10px] font-medium text-slate-500 hover:text-slate-800 px-1.5 py-0.5 rounded border border-transparent hover:border-slate-200 hover:bg-white"
              title="Ocultar lista de chats"
            >
              Ocultar
            </button>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
            {loadingList ? (
              <div className="p-4 text-xs text-slate-400 text-center animate-pulse">Cargando…</div>
            ) : isSearchPending ? (
              <div className="p-4 text-xs text-slate-500 text-center space-y-2">
                <span
                  className="mx-auto block h-4 w-4 rounded-full border-2 border-[#4FAEB2]/30 border-t-[#4FAEB2] animate-spin"
                  aria-hidden="true"
                />
                <p className="animate-pulse">Buscando en todas las conversaciones…</p>
              </div>
            ) : conversations.length === 0 ? (
              <div className="p-4 text-xs text-slate-500 text-center space-y-1">
                <p>{hasSearchTerm ? `No encontramos chats con “${listSearch.trim()}”` : "No hay conversaciones aún"}</p>
              </div>
            ) : visibleConversations.length === 0 ? (
              <div className="p-4 text-xs text-slate-500 text-center space-y-1">
                <p>Ningún chat coincide con la búsqueda</p>
              </div>
            ) : (
              visibleConversations.map((c) => {
                const hasNameInCard = isHumanContactName(c.contact.name, c.contact.phone_number);
                const cardName = hasNameInCard ? c.contact.name!.trim() : "Sin nombre";
                const cardInitial = (() => {
                  const cleaned = cardName.replace(/^[^A-Za-z0-9]+/, "");
                  const m = cleaned.match(/[A-Za-z0-9]/);
                  return (m?.[0] ?? "?").toUpperCase();
                })();
                const isSelected = selectedId === c.id;
                return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => handleSelect(c.id)}
                  className={`w-full text-left px-3 py-3 border-b border-slate-100 transition-colors ${
                    isSelected ? "bg-white border-l-[3px] border-l-[#4FAEB2]" : "hover:bg-white"
                  }`}
                >
                  <div className="flex items-start gap-2.5">
                    <span
                      aria-hidden="true"
                      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold ${
                        hasNameInCard
                          ? "bg-[#4FAEB2]/12 text-[#3F8E91] border border-[#4FAEB2]/30"
                          : "bg-slate-100 text-slate-500 border border-slate-200"
                      }`}
                    >
                      {cardInitial}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="text-sm font-semibold text-slate-900 truncate">
                            {cardName}
                          </div>
                          <div className="text-[11px] text-slate-500 font-mono truncate tabular-nums">
                            {contactPhoneFallback(c.contact.phone_number, c.contact.name)}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          {vista === "bot" ? (
                            <span className="text-[10px] font-semibold uppercase tracking-wide text-violet-700 bg-violet-50 border border-violet-200 px-1.5 py-0.5 rounded">
                              Bot
                            </span>
                          ) : c.human_taken_over || c.flow_status === "human" ? (
                            <span className="text-[10px] font-semibold uppercase tracking-wide text-emerald-700 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded">
                              Humano
                            </span>
                          ) : null}
                          {c.unread_count > 0 && (
                            <span className="inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-[#4FAEB2] px-1.5 py-0.5 text-[11px] font-bold text-white">
                              {c.unread_count}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <ChannelBadge type={c.channel.type} nombre={c.channel.nombre} />
                      </div>
                      <p className="mt-1.5 text-[12px] text-slate-500 truncate leading-snug">
                        {c.last_message_preview || "—"}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    <span
                      className={`text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded border ${badgeEstadoClass(c.status)}`}
                    >
                      {labelEstado(c.status)}
                    </span>
                    {c.queue_name ? (
                      <span
                        className="text-[9px] font-medium text-indigo-800 bg-indigo-50 border border-indigo-200 px-1.5 py-0.5 rounded truncate max-w-full"
                        title={`Cola: ${c.queue_name}`}
                      >
                        Cola · {c.queue_name}
                      </span>
                    ) : null}
                    {vista !== "bot" ? <InboxReplyTurnBadges c={c} dense /> : null}
                    {c.assigned_agent_name ? (
                      <span
                        className="text-[9px] font-semibold text-emerald-900 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded truncate max-w-full"
                        title={`Agente asignado: ${c.assigned_agent_name}`}
                      >
                        Agente · {c.assigned_agent_name}
                      </span>
                    ) : (
                      (() => {
                        const w = assignmentWaitBadge(c.assignment_wait_code, Boolean(c.queue_id));
                        return (
                          <span
                            className={`text-[9px] font-semibold px-1.5 py-0.5 rounded border truncate max-w-full ${assignmentWaitBadgeClass(w.tone)}`}
                            title="Sin agente asignado"
                          >
                            {w.label}
                          </span>
                        );
                      })()
                    )}
                  </div>
                </button>
                );
              })
            )}
          </div>
        </div>
        ) : null}

        {/* Panel mensajes */}
        <div
          className={`flex-1 flex-col min-w-0 min-h-0 overflow-hidden lg:flex ${
            selectedId || listColumnHidden ? "flex" : "hidden"
          }`}
        >
          {!selectedId ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-2 text-slate-400 text-sm min-h-0 px-2">
              <span>Seleccioná una conversación</span>
              {listColumnHidden ? (
                <button
                  type="button"
                  onClick={() => setListColumnHidden(false)}
                  className="text-xs font-medium text-[#4FAEB2] hover:underline"
                >
                  Mostrar lista de chats
                </button>
              ) : null}
            </div>
          ) : (
            <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-200 bg-white shrink-0">
                {selected ? (
                  (() => {
                    const hasName = isHumanContactName(selected.contact.name, selected.contact.phone_number);
                    const contactDisplayName = hasName ? selected.contact.name!.trim() : "Sin nombre";
                    const contactInitial = (() => {
                      const n = contactDisplayName.replace(/^[^A-Za-z0-9]+/, "");
                      const first = n.match(/[A-Za-z0-9]/);
                      return (first?.[0] ?? "?").toUpperCase();
                    })();
                    return (
                      <div className="flex flex-col gap-2.5 min-w-0 w-full">
                        {/* Row 1: identidad + acciones primarias */}
                        <div className="flex flex-wrap items-center justify-between gap-3 min-w-0">
                          <div className="flex min-w-0 items-center gap-2.5">
                            {/* Back-to-list visible solo en mobile cuando la lista no esta oculta manualmente */}
                            {!listColumnHidden ? (
                              <button
                                type="button"
                                onClick={() => {
                                  setSelectedId(null);
                                  setMessages([]);
                                }}
                                aria-label="Volver a la lista de chats"
                                title="Volver a la lista"
                                className="lg:hidden inline-flex shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-white p-1.5 text-slate-600 shadow-sm transition-colors hover:border-[#4FAEB2]/60 hover:text-[#4FAEB2]"
                              >
                                <svg
                                  xmlns="http://www.w3.org/2000/svg"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2.2"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  className="h-4 w-4"
                                  aria-hidden="true"
                                >
                                  <polyline points="15 18 9 12 15 6" />
                                </svg>
                              </button>
                            ) : null}
                            <span
                              aria-hidden="true"
                              className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold ring-2 ring-white shadow-sm ${
                                hasName
                                  ? "bg-[#4FAEB2]/12 text-[#3F8E91] border border-[#4FAEB2]/30"
                                  : "bg-slate-100 text-slate-500 border border-slate-200"
                              }`}
                            >
                              {contactInitial}
                            </span>
                            <div className="min-w-0 leading-tight">
                              <p className="truncate text-sm font-semibold text-slate-900 max-w-[min(100%,18rem)]">
                                {contactDisplayName}
                              </p>
                              <p className="mt-0.5 truncate font-mono text-[11px] tabular-nums text-slate-500">
                                {contactPhoneFallback(selected.contact.phone_number, selected.contact.name)}
                              </p>
                            </div>
                          </div>

                          <div className="flex flex-wrap items-center justify-end gap-1.5">
                            {vista !== "bot" ? (
                              <button
                                type="button"
                                disabled={opsBusy}
                                onClick={() => {
                                  setTransferAgentSearch("");
                                  setTransferQueueTarget(selected.queue_id?.trim() ? selected.queue_id : "");
                                  setTransferModalOpen(true);
                                }}
                                className="inline-flex items-center gap-1.5 rounded-xl bg-[#4FAEB2] px-3 py-1.5 text-[11px] font-semibold text-white shadow-sm shadow-[#4FAEB2]/25 transition-colors hover:bg-[#3F8E91] disabled:opacity-50"
                              >
                                <ArrowLeftRight className="h-3.5 w-3.5 shrink-0" aria-hidden />
                                Transferir
                              </button>
                            ) : null}
                            {selected.status !== "closed" && mode === "inbox" ? (
                              <button
                                type="button"
                                disabled={opsBusy || finalizeSaving}
                                onClick={() => void openFinalizeModal()}
                                className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-[11px] font-semibold text-slate-700 shadow-sm transition-colors hover:border-[#4FAEB2]/60 hover:bg-[#4FAEB2]/5 hover:text-[#3F8E91] disabled:opacity-50"
                              >
                                <svg
                                  xmlns="http://www.w3.org/2000/svg"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  className="h-3.5 w-3.5 shrink-0"
                                  aria-hidden="true"
                                >
                                  <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                                  <polyline points="22 4 12 14.01 9 11.01" />
                                </svg>
                                Finalizar
                              </button>
                            ) : selected.status === "closed" ? (
                              <button
                                type="button"
                                disabled={opsBusy}
                                onClick={() =>
                                  void runConversationOp(() =>
                                    changeConversationStatus(selected.id, "open")
                                  )
                                }
                                className="inline-flex items-center rounded-xl border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-[11px] font-semibold text-emerald-800 shadow-sm transition-colors hover:bg-emerald-100 disabled:opacity-50"
                              >
                                Reabrir
                              </button>
                            ) : null}
                            {isHumanActive ? (
                              <button
                                type="button"
                                disabled={releasingBot}
                                onClick={() => void handleReleaseToBot()}
                                className="inline-flex items-center rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-[11px] font-semibold text-slate-700 shadow-sm transition-colors hover:border-[#4FAEB2]/60 hover:text-[#3F8E91] disabled:opacity-50"
                              >
                                {releasingBot ? "…" : "Modo bot"}
                              </button>
                            ) : null}
                            {canResendCurrentFlowStep ? (
                              <button
                                type="button"
                                disabled={resendFlowStepLoading || opsBusy}
                                onClick={() => void handleResendCurrentFlowStep()}
                                title='Vuelve a enviar la pregunta o mensaje del nodo actual sin avanzar el flujo. Útil si el bot quedó trabado o el cliente no recibió el último paso.'
                                className="inline-flex items-center gap-1.5 rounded-xl border border-violet-200 bg-violet-50 px-3 py-1.5 text-[11px] font-semibold text-violet-800 shadow-sm transition-colors hover:bg-violet-100 disabled:opacity-50"
                              >
                                <RefreshCw
                                  className={`h-3.5 w-3.5 shrink-0 ${resendFlowStepLoading ? "animate-spin" : ""}`}
                                  aria-hidden
                                />
                                {resendFlowStepLoading ? "Enviando…" : "Reenviar paso"}
                              </button>
                            ) : null}
                            {listColumnHidden ? (
                              <button
                                type="button"
                                onClick={() => setListColumnHidden(false)}
                                title="Mostrar lista de chats"
                                className="inline-flex items-center gap-1 rounded-xl border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-slate-600 shadow-sm transition-colors hover:border-[#4FAEB2]/60 hover:text-[#3F8E91]"
                              >
                                <svg
                                  xmlns="http://www.w3.org/2000/svg"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  className="h-3.5 w-3.5"
                                  aria-hidden="true"
                                >
                                  <line x1="8" y1="6" x2="21" y2="6" />
                                  <line x1="8" y1="12" x2="21" y2="12" />
                                  <line x1="8" y1="18" x2="21" y2="18" />
                                  <line x1="3" y1="6" x2="3.01" y2="6" />
                                  <line x1="3" y1="12" x2="3.01" y2="12" />
                                  <line x1="3" y1="18" x2="3.01" y2="18" />
                                </svg>
                                Chats
                              </button>
                            ) : null}
                          </div>
                        </div>

                        {/* Row 2: meta chips uniformes */}
                        <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                          <ChannelBadge type={selected.channel.type} nombre={selected.channel.nombre} />
                          {vista === "bot" ? (
                            <span className="inline-flex items-center gap-1 rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-[10px] font-semibold text-violet-800">
                              <span aria-hidden="true" className="h-1 w-1 rounded-full bg-violet-500" />
                              Bot
                            </span>
                          ) : isHumanActive ? (
                            <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
                              <span aria-hidden="true" className="h-1 w-1 rounded-full bg-emerald-500" />
                              Humano
                            </span>
                          ) : null}
                          <span
                            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${badgeEstadoClass(selected.status)}`}
                          >
                            {labelEstado(selected.status)}
                          </span>

                          {vista !== "bot" ? (
                            <>
                              <span aria-hidden="true" className="mx-0.5 h-3.5 w-px bg-slate-200" />
                              {selected.queue_name ? (
                                <span
                                  className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] font-medium text-slate-700 truncate max-w-[12rem]"
                                  title="Cola de enrutamiento"
                                >
                                  <svg
                                    xmlns="http://www.w3.org/2000/svg"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    className="h-3 w-3 shrink-0 text-slate-400"
                                    aria-hidden="true"
                                  >
                                    <rect x="3" y="6" width="18" height="12" rx="2" />
                                    <path d="M7 10h10M7 14h6" />
                                  </svg>
                                  {selected.queue_name}
                                </span>
                              ) : mode === "inbox" ? (
                                <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] font-medium text-slate-500">
                                  Sin cola
                                </span>
                              ) : null}
                              <InboxReplyTurnBadges c={selected} dense />
                              {selected.assigned_agent_name ? (
                                <span
                                  className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-800 truncate max-w-[11rem]"
                                  title="Agente asignado"
                                >
                                  <svg
                                    xmlns="http://www.w3.org/2000/svg"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    className="h-3 w-3 shrink-0"
                                    aria-hidden="true"
                                  >
                                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                                    <circle cx="12" cy="7" r="4" />
                                  </svg>
                                  {selected.assigned_agent_name}
                                </span>
                              ) : mode === "inbox" ? (
                                (() => {
                                  const w = assignmentWaitBadge(
                                    selected.assignment_wait_code,
                                    Boolean(selected.queue_id)
                                  );
                                  return (
                                    <span
                                      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${assignmentWaitBadgeClass(w.tone)}`}
                                      title="Aún sin agente asignado"
                                    >
                                      <UserRound className="h-3 w-3 shrink-0" aria-hidden />
                                      Sin agente · {w.label}
                                    </span>
                                  );
                                })()
                              ) : null}
                            </>
                          ) : null}

                          {selected.contact.cliente_id || selected.contact.crm_prospecto_id ? (
                            <>
                              <span aria-hidden="true" className="mx-0.5 h-3.5 w-px bg-slate-200" />
                              {selected.contact.cliente_id ? (
                                <Link
                                  href={`/clientes/${selected.contact.cliente_id}`}
                                  className="inline-flex items-center gap-1 rounded-full border border-[#4FAEB2]/30 bg-[#4FAEB2]/8 px-2 py-0.5 text-[10px] font-semibold text-[#3F8E91] transition-colors hover:bg-[#4FAEB2]/12"
                                >
                                  Cliente →
                                </Link>
                              ) : null}
                              {selected.contact.crm_prospecto_id ? (
                                <Link
                                  href={`/crm/${selected.contact.crm_prospecto_id}`}
                                  className="inline-flex items-center gap-1 rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-[10px] font-semibold text-violet-700 transition-colors hover:bg-violet-100"
                                >
                                  CRM →
                                </Link>
                              ) : null}
                            </>
                          ) : null}
                        </div>
                      </div>
                    );
                  })()
                ) : null}
              </div>

              {selected?.channel.comprobante_validation_enabled ? (
                <div className="border-b border-amber-100/90 bg-amber-50/30 shrink-0">
                  <button
                    type="button"
                    onClick={() => setCompValidacionesOpen((o) => !o)}
                    aria-expanded={compValidacionesOpen}
                    className="w-full text-left px-2 py-1 text-xs font-medium text-amber-900 flex items-center justify-between gap-2 hover:bg-amber-50/80"
                  >
                    <span>
                      ⚠️ Validaciones ({compLoading ? "…" : compVals.length})
                    </span>
                    <span className="text-slate-500 tabular-nums shrink-0" aria-hidden>
                      {compValidacionesOpen ? "▲" : "▼"}
                    </span>
                  </button>
                  {compValidacionesOpen ? (
                    <div className="px-2 pb-2 max-h-48 overflow-y-auto overscroll-contain border-t border-amber-100/80">
                      {compApprovalInfo ? (
                        <p className="text-[11px] text-emerald-800 bg-emerald-50 border border-emerald-100 rounded px-1.5 py-1 mb-1">
                          {compApprovalInfo}
                        </p>
                      ) : null}
                      {compLoading ? (
                        <p className="text-xs text-slate-500 pt-1">Cargando…</p>
                      ) : compVals.length === 0 ? (
                        <p className="text-xs text-slate-500 pt-1">
                          No hay comprobantes registrados en esta conversación.
                        </p>
                      ) : (
                        <ul className="space-y-1.5 pt-1">
                          {compVals.map((v) => (
                            <li
                              key={v.id}
                              className="flex flex-wrap items-center gap-1.5 text-[11px] bg-white border border-slate-200 rounded-md px-1.5 py-1"
                            >
                              <span className="font-mono text-slate-600">{v.estado_validacion}</span>
                              {v.monto_validacion_status != null && v.monto_validacion_status !== "" ? (
                                <span
                                  className="text-[10px] text-slate-500 max-w-[200px] truncate"
                                  title={v.motivo_validacion ?? ""}
                                >
                                  monto: {v.monto_validacion_status}
                                  {v.monto_validacion_esperado_gs != null
                                    ? ` · esp ${v.monto_validacion_esperado_gs}`
                                    : ""}
                                  {v.monto_validacion_ocr_gs != null ? ` · ocr ${v.monto_validacion_ocr_gs}` : ""}
                                  {v.monto_validacion_diferencia_gs != null
                                    ? ` · Δ ${v.monto_validacion_diferencia_gs}`
                                    : ""}
                                </span>
                              ) : null}
                              {v.bank_val_status != null && v.bank_val_status !== "" ? (
                                <span
                                  className="text-[10px] text-slate-500 max-w-[220px] truncate"
                                  title={v.motivo_validacion ?? ""}
                                >
                                  banco: {v.bank_val_status}
                                  {v.bank_val_coincidencias != null && v.bank_val_min_requeridas != null
                                    ? ` · ${v.bank_val_coincidencias}/${v.bank_val_min_requeridas}`
                                    : ""}
                                </span>
                              ) : null}
                              {v.comprobante_url ? (
                                <a
                                  href={v.comprobante_url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="text-[#4FAEB2] hover:underline"
                                >
                                  Ver archivo
                                </a>
                              ) : null}
                              {v.estado_validacion === "aprobado_manual" ? (
                                <span className="text-emerald-700 font-medium">
                                  Aprobado manualmente · Compra cerrada
                                  {v.sorteo_entrada_id ? " ✓" : ""}
                                </span>
                              ) : null}
                              {v.sorteo_entrada_id && v.estado_validacion !== "aprobado_manual" ? (
                                <span className="text-sky-700 font-medium">Compra cerrada (entrada existente)</span>
                              ) : null}
                              {!v.sorteo_entrada_id && v.estado_validacion !== "aprobado_manual" ? (
                                <button
                                  type="button"
                                  disabled={compActionId === v.id}
                                  onClick={() => {
                                    setCompApproveConfirmId(v.id);
                                    setCompApprovalInfo(null);
                                  }}
                                  className="text-emerald-700 font-medium hover:underline disabled:opacity-50"
                                >
                                  Aprobar (cerrar compra)
                                </button>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ) : null}
                </div>
              ) : null}

              <div
                ref={messagesScrollRef}
                onScroll={onMessagesScroll}
                className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-2 py-1 space-y-0 bg-gradient-to-b from-slate-100/90 to-slate-50/40"
              >
                {loadingMsg ? (
                  <div className="text-center text-slate-400 text-sm py-8">Cargando mensajes…</div>
                ) : messages.length === 0 ? (
                  <div className="text-center text-slate-500 text-sm py-8 px-3">
                    {messagesError
                      ? "No se pudieron cargar los mensajes. Reintentá o revisá la barra de avisos arriba."
                      : "No hay mensajes para esta conversación."}
                  </div>
                ) : (
                  messages.map((m, idx) => {
                    const attachUrl = resolveAttachmentUrl(m);
                    const metaDocName = getMetaInboundDocumentFilename(m.raw_payload);
                    const erpName = getErpAttachmentFilename(m.raw_payload);
                    const showAsImage =
                      m.message_type === "image" ||
                      m.message_type === "sticker" ||
                      (m.message_type === "document" && isImageMimeHint(m.raw_payload, m.message_type));

                    return (
                      <div
                        key={m.id}
                        className={`flex ${m.from_me ? "justify-end" : "justify-start"} py-1.5 ${
                          idx > 0 ? "border-t border-slate-200/55" : ""
                        }`}
                      >
                        <div
                          className={`max-w-[92%] sm:max-w-[88%] md:max-w-[78%] lg:max-w-[72%] rounded-2xl px-3 py-2 text-[13px] sm:text-sm leading-relaxed ${
                            m.from_me
                              ? "bg-[#4FAEB2] text-white rounded-br-md shadow-md shadow-[#4FAEB2]/25 ring-1 ring-white/15"
                              : "bg-white text-slate-800 rounded-bl-md border border-slate-200 shadow-sm border-l-[3px] border-l-[#4FAEB2]/55"
                          }`}
                        >
                          {showAsImage && attachUrl ? (
                            <div className="space-y-2">
                              <div
                                className={`text-xs font-medium ${m.from_me ? "text-white/85" : "text-slate-500"}`}
                              >
                                Imagen
                              </div>
                              <button
                                type="button"
                                className="p-0 border-0 bg-transparent cursor-zoom-in text-left"
                                onClick={() => setLightboxUrl(attachUrl)}
                              >
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img
                                  src={attachUrl}
                                  alt="Imagen del chat"
                                  className="max-h-52 rounded-lg border border-white/30 bg-white object-contain"
                                />
                              </button>
                              {m.content && m.content !== "[imagen]" ? (
                                <p className="whitespace-pre-wrap break-words text-sm opacity-95">{m.content}</p>
                              ) : null}
                            </div>
                          ) : m.message_type === "audio" ? (
                            <div className="space-y-2">
                              <div
                                className={`text-xs font-medium ${m.from_me ? "text-white/85" : "text-slate-500"}`}
                              >
                                Audio
                              </div>
                              {attachUrl ? (
                                <audio
                                  controls
                                  src={attachUrl}
                                  className="w-full max-w-[280px] h-9"
                                  preload="metadata"
                                />
                              ) : (
                                <p className="whitespace-pre-wrap break-words text-sm opacity-90">
                                  {m.content ?? "[audio]"}
                                </p>
                              )}
                            </div>
                          ) : m.message_type === "document" || m.message_type === "video" ? (
                            <div className="space-y-2">
                              {attachUrl ? (
                                <a
                                  href={attachUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  className={`flex items-start gap-3 rounded-xl border px-3 py-2.5 no-underline transition-colors ${
                                    m.from_me
                                      ? "border-white/30 bg-white/20 hover:bg-white/30 text-white"
                                      : "border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-900"
                                  }`}
                                >
                                  <span className="text-2xl leading-none shrink-0 select-none" aria-hidden>
                                    {m.message_type === "video" ? "▶️" : "📎"}
                                  </span>
                                  <span className="min-w-0 flex-1">
                                    <span
                                      className={`block text-[10px] font-bold uppercase tracking-wide ${
                                        m.from_me ? "text-sky-100" : "text-slate-500"
                                      }`}
                                    >
                                      {m.message_type === "video" ? "Video" : "Documento"}
                                    </span>
                                    <span className="block text-sm font-semibold break-words mt-0.5">
                                      {displayFilenameForAttachment(m)}
                                    </span>
                                    <span
                                      className={`block text-[11px] mt-1 ${
                                        m.from_me ? "text-sky-100" : "text-slate-500"
                                      }`}
                                    >
                                      Tocá para abrir o descargar
                                    </span>
                                  </span>
                                </a>
                              ) : (
                                <div>
                                  <div
                                    className={`text-xs font-medium ${m.from_me ? "text-white/85" : "text-slate-500"}`}
                                  >
                                    {m.message_type === "video" ? "Video" : "Documento"}
                                  </div>
                                  <p className="whitespace-pre-wrap break-words mt-1">
                                    {erpName || metaDocName ? (
                                      <>
                                        <span className="font-medium">{erpName || metaDocName}</span>
                                        {m.content ? (
                                          <>
                                            <br />
                                            {m.content}
                                          </>
                                        ) : null}
                                      </>
                                    ) : (
                                      m.content
                                    )}
                                  </p>
                                </div>
                              )}
                            </div>
                          ) : m.message_type === "image" ? (
                            (() => {
                              const parsed = parseOutgoingImageMessage(m);
                              return (
                                <div className="space-y-2">
                                  <div
                                    className={`text-xs font-medium ${m.from_me ? "text-white/85" : "text-slate-500"}`}
                                  >
                                    Mensaje con imagen
                                  </div>
                                  {parsed.url ? (
                                    <button
                                      type="button"
                                      className="p-0 border-0 bg-transparent cursor-zoom-in text-left"
                                      onClick={() => setLightboxUrl(parsed.url!)}
                                    >
                                      {/* eslint-disable-next-line @next/next/no-img-element */}
                                      <img
                                        src={parsed.url}
                                        alt="Imagen enviada"
                                        className="max-h-52 rounded-lg border border-white/30 bg-white object-contain"
                                      />
                                    </button>
                                  ) : null}
                                  {parsed.caption ? (
                                    <p className="whitespace-pre-wrap break-words">{parsed.caption}</p>
                                  ) : null}
                                  {!parsed.url && !parsed.caption ? (
                                    <p className="whitespace-pre-wrap break-words">{m.content}</p>
                                  ) : null}
                                </div>
                              );
                            })()
                          ) : (
                            (() => {
                              const ni = getNeuraInteractiveItems(m);
                              return (
                                <div className="space-y-1.5">
                                  <p className="whitespace-pre-wrap break-words">{m.content}</p>
                                  {ni ? (
                                    <div
                                      className={`flex flex-col gap-1 border-t pt-1.5 ${m.from_me ? "border-white/25" : "border-slate-200"}`}
                                    >
                                      {ni.items.map((title, i) => (
                                        <span
                                          key={`${m.id}-opt-${i}`}
                                          className={`inline-flex items-center justify-center rounded-lg border px-2.5 py-1 text-xs font-medium ${
                                            m.from_me
                                              ? "border-white/40 bg-white/10 text-white"
                                              : "border-slate-200 bg-slate-50 text-slate-700"
                                          }`}
                                        >
                                          {title}
                                        </span>
                                      ))}
                                    </div>
                                  ) : null}
                                </div>
                              );
                            })()
                          )}
                          <p
                            className={`text-[10px] mt-1 ${m.from_me ? "text-sky-100" : "text-slate-400"}`}
                          >
                            {formatTime(m.created_at)}
                            {m.message_type !== "text" && ` · ${m.message_type}`}
                          </p>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>

              <form
                onSubmit={handleSend}
                className="p-1.5 border-t border-slate-200 bg-white flex flex-col gap-1 shrink-0 min-h-0"
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  className="hidden"
                  accept="image/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt"
                  onChange={(e) => void handleSendFile(e)}
                />
                {sendError && (
                  <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-md px-2 py-1">
                    {sendError}
                  </div>
                )}
                <div className="flex gap-1 items-end">
                  <div ref={quickReplyPanelRef} className="relative flex shrink-0 gap-0.5 items-center">
                    <button
                      type="button"
                      disabled={uploadingFile || !selectedId || recordingVoice}
                      onClick={() => fileInputRef.current?.click()}
                      className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                      title="Adjuntar imagen, audio o documento"
                      aria-label="Adjuntar archivo"
                    >
                      {uploadingFile ? (
                        <span className="text-xs font-bold">…</span>
                      ) : (
                        <Paperclip className="w-[18px] h-[18px]" aria-hidden />
                      )}
                    </button>
                    <button
                      type="button"
                      disabled={uploadingFile || !selectedId}
                      onClick={() => void toggleVoiceNote()}
                      className={`inline-flex h-9 w-9 items-center justify-center rounded-lg border text-slate-600 disabled:opacity-50 ${
                        recordingVoice
                          ? "border-red-300 bg-red-50 text-red-700 hover:bg-red-100"
                          : "border-slate-200 hover:bg-slate-50"
                      }`}
                      title={
                        recordingVoice
                          ? "Detener y enviar nota de voz"
                          : "Grabar nota de voz"
                      }
                      aria-label={recordingVoice ? "Detener grabación y enviar" : "Grabar nota de voz"}
                    >
                      {recordingVoice ? (
                        <Square className="w-[16px] h-[16px] fill-current" aria-hidden />
                      ) : (
                        <Mic className="w-[18px] h-[18px]" aria-hidden />
                      )}
                    </button>
                    {vista !== "bot" && selected?.channel.quick_replies_inbox_enabled !== false ? (
                      <>
                        <button
                          type="button"
                          disabled={!selectedId || quickRepliesLoading}
                          onClick={() => {
                            setQuickReplyOpen((o) => !o);
                            setQuickReplySearch("");
                          }}
                          className={`inline-flex h-9 w-9 items-center justify-center rounded-lg border disabled:opacity-50 ${
                            quickReplyOpen
                              ? "border-[#4FAEB2]/50 bg-[#4FAEB2]/10 text-[#3F8E91]"
                              : "border-slate-200 text-slate-600 hover:bg-slate-50"
                          }`}
                          title="Respuestas rápidas"
                          aria-label="Insertar respuesta rápida"
                          aria-expanded={quickReplyOpen}
                        >
                          <Zap className="w-[18px] h-[18px]" aria-hidden />
                        </button>
                        {quickReplyOpen ? (
                          <div className="absolute bottom-full left-0 z-30 mb-1 flex w-[min(calc(100vw-2rem),20rem)] max-h-72 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl">
                            <div className="border-b border-slate-100 px-2 py-1.5">
                              <input
                                type="search"
                                className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs outline-none focus:border-[#4FAEB2] focus:ring-2 focus:ring-[#4FAEB2]/20"
                                placeholder="Buscar…"
                                value={quickReplySearch}
                                onChange={(e) => setQuickReplySearch(e.target.value)}
                                aria-label="Buscar respuesta rápida"
                                autoFocus
                              />
                            </div>
                            <div className="max-h-56 overflow-y-auto overscroll-contain p-1">
                              {quickRepliesLoading ? (
                                <p className="px-2 py-4 text-center text-xs text-slate-400">Cargando…</p>
                              ) : filteredQuickReplies.length === 0 ? (
                                <p className="px-2 py-4 text-center text-xs text-slate-500">
                                  {channelQuickReplies.length === 0
                                    ? "No hay respuestas configuradas para este canal."
                                    : "Sin coincidencias."}
                                </p>
                              ) : (
                                <ul className="space-y-0.5">
                                  {filteredQuickReplies.map((r) => (
                                    <li key={r.id}>
                                      <button
                                        type="button"
                                        className="w-full rounded-lg px-2 py-2 text-left text-xs hover:bg-slate-50"
                                        onClick={() => insertQuickReplyBody(r.body)}
                                      >
                                        <span className="block font-semibold text-slate-900">{r.title}</span>
                                        <span className="mt-0.5 line-clamp-2 text-[11px] text-slate-500">
                                          {r.body}
                                        </span>
                                      </button>
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </div>
                          </div>
                        ) : null}
                      </>
                    ) : null}
                  </div>
                  <input
                    className="flex-1 min-w-0 rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-sm text-slate-900 shadow-sm transition-colors placeholder:text-slate-400 hover:border-[#4FAEB2]/60 focus:border-[#4FAEB2] focus:ring-2 focus:ring-[#4FAEB2]/20 outline-none min-h-[2.25rem]"
                    placeholder="Escribí un mensaje…"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    disabled={sending}
                  />
                  <button
                    type="submit"
                    disabled={sending || !input.trim()}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-[#4FAEB2] px-4 py-2 text-sm font-semibold text-white shadow-sm shadow-[#4FAEB2]/20 transition-colors hover:bg-[#3F8E91] disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400 disabled:shadow-none min-h-[2.25rem]"
                  >
                    {sending ? (
                      "…"
                    ) : (
                      <>
                        <span>Enviar</span>
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          className="h-3.5 w-3.5"
                          aria-hidden="true"
                        >
                          <line x1="22" y1="2" x2="11" y2="13" />
                          <polygon points="22 2 15 22 11 13 2 9 22 2" />
                        </svg>
                      </>
                    )}
                  </button>
                </div>
              </form>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
