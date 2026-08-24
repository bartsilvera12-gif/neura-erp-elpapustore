import { downloadMetaMediaBytes } from "@/lib/chat/meta-media-download";
import { flowTrace, summarizeFlowDataForTrace } from "@/lib/chat/flow-trace-log";
import {
  COMPROBANTE_BUTTON_IDS,
  FLOW_SORTEO_PENDIENTE_DATOS_PARTICIPANTE_FIELD,
  parseComprobanteValidationConfig,
  SORTEO_COMPROBANTE_ESTADO_VALIDACION_FIELD,
  SORTEO_COMPROBANTE_MOTIVO_VALIDACION_FIELD,
  SORTEO_COMPROBANTE_VALIDACION_ID_FIELD,
} from "@/lib/chat/comprobante-validation-types";
import {
  mensajeClienteComprobanteNoValido,
  runComprobanteValidationPipeline,
} from "@/lib/chat/comprobante-validation-service";
import {
  buttonQuickReplyGroupsEnabled,
  partitionQuickReplyButtonGroups,
  validateQuickReplyGroupsMaxThree,
} from "@/lib/chat/flow-button-groups";
import {
  sendWhatsAppChoiceMessage,
  sendWhatsAppImage,
  sendWhatsAppInteractiveButtons,
  WA_META_LIST_ROW_TITLE_MAX,
  WA_META_REPLY_TITLE_MAX,
} from "@/lib/chat/whatsapp-send-service";
import {
  resolveOutboundTextContextFromIds,
  sendOutboundTextMessage,
  ycloudOutboundUnsupportedMessage,
} from "@/lib/chat/outbound-send-dispatch";
import type { SupabaseAdmin } from "@/lib/chat/types";
import {
  ensureActiveFlowSessionForConversation,
  markConversationActiveSessionsEnded,
} from "@/lib/chat/flow-session-service";
import {
  applyCantidadFallbackOneIfMissing,
  applySorteoInteractiveCommercialContract,
  buildChatFlowDataUpsertsForSorteoOrder,
  buildSorteoOrderFlowVarOverrides,
  explainParseSorteoParticipantFailure,
  CHAT_FLOW_SORTEO_CONTEXT_FIELDS,
  finalizeSorteoOrderFromConfirmedFlowData,
  getSorteoDatosIncompletosMessage,
  getSorteoIdForChatFlow,
  optionPayloadFinalizesSorteoOrder,
  parseSorteoParticipantFromFlowData,
  prepareFlowDataForSorteoOrder,
  resolveComprobanteUrlFromFlowData,
  SORTEO_COMPROBANTE_MEDIA_ID_FIELD,
  SORTEO_COMPROBANTE_URL_FIELD,
  type EnsureSorteoOrderCreatedData,
} from "@/lib/sorteos/sorteo-order-from-chat";
import { buildOrderResultFromEntradaId } from "@/lib/sorteos/sorteo-ticket-admin";
import { parseMoneyPy } from "@/lib/sorteos/parse-money-py";
import {
  getSorteoTicketDeliveryModeForSorteo,
  runSorteoTicketAfterFinalNodeMessage,
  shouldSuppressSorteoFinalTextAfterImageOnlyTicket,
} from "@/lib/sorteos/sorteo-ticket-delivery";
import { readSorteoCantidadNumericFromMap } from "@/lib/sorteos/sorteo-cantidad-fields";
import { SORTEO_TICKET_DEFAULT_STUB, type SorteoTicketDeliveryMode } from "@/lib/sorteos/sorteo-ticket-types";
import { isSorteoFinalTicketNode } from "@/lib/chat/sorteo-final-ticket-node";
import { matchesPurchaseIntent } from "@/lib/chat/purchase-intent";
import {
  canCloseSorteoPurchase,
  getFlowClosePurchasePolicy,
} from "@/lib/chat/sorteo-close-eligibility";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import {
  describeFlowCaptureCompletenessForLogs,
  isIdentityCaptureField,
  resolveEffectiveNodeCodeForFlowCompleteness,
} from "@/lib/sorteos/sorteo-flow-capture-order";

type ConversationFlowState = {
  id: string;
  empresa_id: string;
  channel_id: string;
  contact_id: string;
  flow_code: string | null;
  flow_current_node: string | null;
  flow_status: string | null;
  human_taken_over: boolean;
  /** Run activo: lecturas/escrituras de `chat_flow_data` solo bajo este id. */
  active_flow_session_id?: string | null;
};

/** `flow_status` null/vacío se trata como modo bot (filas legacy); solo `human` y takeover desactivan. */
function isConversationInBotAutomationMode(
  state: Pick<ConversationFlowState, "flow_status" | "human_taken_over">
): boolean {
  if (state.human_taken_over) return false;
  return String(state.flow_status ?? "bot").trim().toLowerCase() !== "human";
}

export type ProcessInteractiveReplyParams = {
  conversationId: string;
  empresaId: string;
  metaButtonId: string;
  rawPayload: Record<string, unknown>;
};

export type AdvanceConversationParams = {
  conversationId: string;
  empresaId: string;
  flowCode: string;
  nextNodeCode: string;
};

export type SendCurrentNodeParams = {
  conversationId: string;
  __autoHop?: number;
  /** Se fusiona encima de chat_flow_data (útil tras crear orden sorteo sin esperar réplica). */
  mergeFlowVars?: Record<string, string>;
  /** Sorteo image_only: ticket ya enviado; no reenviar el cuerpo largo del nodo (solo rama legacy sin bloques). */
  suppressPlainTextBody?: boolean;
};

type FlowOption = {
  id: string;
  label: string;
  option_value: string;
  meta_button_id: string;
  next_node_code: string | null;
  sort_order: number;
  option_payload: Record<string, unknown> | null;
  /** Modo grupos: cuerpo de cada burbuja interactiva (WhatsApp). Null/ vacío = legacy sin grupos. */
  group_title?: string | null;
  group_order?: number | null;
};

/**
 * Texto visible en WhatsApp (reply o fila de lista).
 * Fuente de verdad **primaria**: columna `chat_flow_options.label` (campo «Texto del botón» en el ERP).
 */
function whatsAppInteractiveTitleFromOption(o: FlowOption): string {
  const labelCol = (o.label ?? "").trim();
  if (labelCol) return labelCol;
  const pl = o.option_payload;
  if (pl && typeof pl === "object" && !Array.isArray(pl)) {
    const ol = (pl as Record<string, unknown>).opcion_label;
    if (typeof ol === "string" && ol.trim()) return ol.trim();
    const pn = (pl as Record<string, unknown>).promo_nombre;
    if (typeof pn === "string" && pn.trim()) return pn.trim();
    const prod = (pl as Record<string, unknown>).producto;
    const monto = (pl as Record<string, unknown>).monto;
    if (typeof prod === "string" && prod.trim() && typeof monto === "number" && monto > 0) {
      return `${prod.trim()} ${monto}`.trim();
    }
  }
  return "Opción";
}

type FlowNode = {
  id: string;
  empresa_id: string;
  flow_code: string;
  node_code: string;
  message_text: string | null;
  save_as_field: string | null;
  next_node_code: string | null;
  node_type: "buttons" | "list" | "text" | "media" | "image_input" | "human" | "end";
  is_active: boolean;
};

type FlowNodeBlock = {
  id: string;
  node_id: string;
  block_type: "text" | "image" | "buttons";
  content_text: string | null;
  media_url: string | null;
  sort_order: number;
};

export type ProcessTextReplyParams = {
  conversationId: string;
  empresaId: string;
  textValue: string;
  rawPayload: Record<string, unknown>;
};

export type ProcessImageReplyParams = {
  conversationId: string;
  empresaId: string;
  mediaId: string;
  mimeType?: string | null;
  caption?: string | null;
  rawPayload: Record<string, unknown>;
  /** URL ya subida por attachInboundMessageMedia (Graph alternativo si falla descarga por media_id). */
  fallbackPublicUrl?: string | null;
  fallbackMimeType?: string | null;
  /** Idempotencia / auditoría en chat_flow_events.image_received */
  waMessageId?: string | null;
};

export type EnsureInboundPresentParams = {
  conversationId: string;
  empresaId: string;
};

export type EnsureInboundPresentResult = {
  ok: boolean;
  status: string;
  /** Si true, acabamos de enviar la UI del nodo actual; no interpretar el mismo mensaje de texto como captura */
  presentedNow: boolean;
  /**
   * Si true junto con `presentedNow`, el nodo recién enviado es captura de texto: el mismo mensaje
   * entrante debe pasarse a `processTextReply` (evita perder nombre/cédula en el primer reply).
   */
  acceptsInboundTextAsCapture: boolean;
  error?: string;
};

export type FlowEngineContext = {
  supabase: SupabaseAdmin;
};

const CHAT_MEDIA_BUCKET = "chat-media";
let chatMediaBucketChecked = false;

function extensionFromMime(mimeType: string | null | undefined): string {
  if (!mimeType) return "jpg";
  const v = mimeType.toLowerCase();
  if (v.includes("pdf")) return "pdf";
  if (v.includes("png")) return "png";
  if (v.includes("webp")) return "webp";
  if (v.includes("gif")) return "gif";
  if (v.includes("jpeg") || v.includes("jpg")) return "jpg";
  return "jpg";
}

/** Imagen o PDF (comprobante bancario frecuente como archivo). */
function isComprobanteMimeAccepted(mimeType: string | null | undefined): boolean {
  const m = (mimeType ?? "").toLowerCase();
  if (m.startsWith("image/")) return true;
  if (m.includes("pdf")) return true;
  return false;
}

const FLOW_SORTEO_LOG = "[flow-sorteo]" as const;

/** Mensaje operativo si falta contexto comercial tras hidratar (reenvío de comprobante); no pedir "Confirmar" sin botón. */
const SORTEO_IMAGE_ORDER_INCOMPLETE_MESSAGE =
  "Necesitamos confirmar nuevamente la cantidad de números para registrar tu participación.";

function dedupeChatFlowFieldEntries(entries: [string, string][]): [string, string][] {
  const m = new Map<string, string>();
  for (const [k, v] of entries) {
    const key = k.trim();
    if (!key) continue;
    m.set(key, v);
  }
  return [...m.entries()];
}

/**
 * Tras elegir botón/lista: si no hay clave de cantidad en `chat_flow_data`, inferir desde
 * option_payload, option_value o texto del label (p. ej. "3 boletos", "1 boleta").
 */
function augmentCantidadFromInteractiveOption(
  entries: [string, string][],
  selected: FlowOption
): [string, string][] {
  const lowerKeys = new Set(entries.map(([k]) => k.trim().toLowerCase()));
  const qtyNames = [
    "cantidad",
    "cantidad_boletos",
    "cantidad_boletas",
    "cantidad_numeros",
    "cantidad_entradas",
    "boletos",
    "boletas",
    "numeros",
    "entradas",
    "qty",
    "quantity",
  ];
  const withCantidadSnapshot = (list: [string, string][], qty: string): [string, string][] => {
    const lk = new Set(list.map(([k]) => k.trim().toLowerCase()));
    if (lk.has("sorteo_cantidad_opcion")) return list;
    return [...list, ["sorteo_cantidad_opcion", qty]];
  };
  if (qtyNames.some((k) => lowerKeys.has(k))) {
    const entry = entries.find(([k]) => qtyNames.includes(k.trim().toLowerCase()));
    const v = entry?.[1]?.trim() ?? "";
    if (!v) return entries;
    return withCantidadSnapshot(entries, v);
  }

  const tryQty = (raw: unknown): number | null => {
    if (raw == null) return null;
    const n = Number(String(raw).trim().replace(",", "."));
    if (!Number.isFinite(n) || n < 1) return null;
    return Math.trunc(n);
  };

  const payload =
    selected.option_payload && typeof selected.option_payload === "object"
      ? (selected.option_payload as Record<string, unknown>)
      : null;

  if (payload) {
    for (const k of qtyNames) {
      const n = tryQty(payload[k]);
      if (n != null) {
        const rest = entries.filter((e) => e[0].trim().toLowerCase() !== "cantidad");
        return withCantidadSnapshot([...rest, ["cantidad", String(n)]], String(n));
      }
    }
  }

  const ov = selected.option_value?.trim() ?? "";
  if (ov) {
    const direct = tryQty(ov);
    if (direct != null) {
      return withCantidadSnapshot([...entries, ["cantidad", String(direct)]], String(direct));
    }
    const lead = ov.match(/^(\d+)/);
    if (lead) {
      const n = tryQty(lead[1]);
      if (n != null) {
        return withCantidadSnapshot([...entries, ["cantidad", String(n)]], String(n));
      }
    }
  }

  const label = selected.label?.trim() ?? "";
  const labelPatterns = [
    /^(\d+)\s*bolet/i,
    /^(\d+)\s*boleta/i,
    /^(\d+)\s*entrada/i,
    /^(\d+)\s*ticket/i,
    /(\d+)\s*bolet/i,
    /^(\d+)\b/,
  ];
  for (const re of labelPatterns) {
    const m = label.match(re);
    if (m) {
      const n = tryQty(m[1]);
      if (n != null) {
        return withCantidadSnapshot([...entries, ["cantidad", String(n)]], String(n));
      }
    }
  }

  console.warn(FLOW_SORTEO_LOG, "interactive_cantidad_no_inferida", {
    optionId: selected.id,
    label: selected.label,
    option_value: selected.option_value,
    meta_button_id: selected.meta_button_id,
  });
  return entries;
}

/**
 * Normaliza montos del option_payload y marca precio_fuente=promo cuando hay monto estructurado
 * (sin depender del texto visible del botón).
 */
function augmentSorteoPricingFromInteractiveOption(
  entries: [string, string][]
): [string, string][] {
  const lower = (k: string) => k.trim().toLowerCase();
  const montoKeys = new Set(["monto", "monto_compra", "monto_promocional", "sorteo_monto_opcion"]);
  let rawMonto: string | null = null;
  for (const [k, v] of entries) {
    if (montoKeys.has(lower(k))) {
      rawMonto = v;
      break;
    }
  }
  if (!rawMonto) return entries;
  const parsed = parseMoneyPy(rawMonto);
  if (parsed == null || parsed <= 0) return entries;
  const normalized = String(Math.round(parsed));
  const filtered = entries.filter(([k]) => !montoKeys.has(lower(k)));
  const pfEntry = filtered.find(([k]) => lower(k) === "precio_fuente");
  const pfVal = pfEntry ? String(pfEntry[1]).toLowerCase().trim() : "";
  const withMonto: [string, string][] = [...filtered, ["monto", normalized]];
  let out: [string, string][];
  if (!pfEntry) {
    out = [...withMonto, ["precio_fuente", "promo"]];
  } else {
    out = withMonto;
  }
  if (!pfEntry || pfVal === "promo") {
    out = [
      ...out,
      ["monto_compra", normalized],
      ["monto_promocional", normalized],
      ["sorteo_monto_opcion", normalized],
    ];
  }
  return out;
}

/** Título visible de una respuesta interactiva (botón/lista) de WhatsApp. */
function whatsappInteractiveReplyTitle(rawPayload: Record<string, unknown>): string {
  const intr = (rawPayload?.interactive ?? null) as
    | { button_reply?: { title?: string }; list_reply?: { title?: string } }
    | null;
  return (intr?.button_reply?.title ?? intr?.list_reply?.title ?? "").trim();
}

/**
 * ¿El título de un botón interactivo expresa intención de comprar de nuevo?
 * Usa el matcher compartido (raíces + typos). Solo se evalúa cuando el botón NO matchea una
 * opción del nodo actual (caso invalid_button), así nunca interfiere con la selección de combos.
 */
function interactiveReplyMatchesPurchaseIntent(rawPayload: Record<string, unknown>): boolean {
  return matchesPurchaseIntent(whatsappInteractiveReplyTitle(rawPayload));
}

export function createFlowEngine(ctx: FlowEngineContext) {
  const supabase = ctx.supabase;

  async function getConversationFlowState(
    conversationId: string
  ): Promise<ConversationFlowState | null> {
    const { data, error } = await supabase
      .from("chat_conversations")
      .select(
        "id, empresa_id, channel_id, contact_id, flow_code, flow_current_node, flow_status, human_taken_over, active_flow_session_id"
      )
      .eq("id", conversationId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    const state = data as ConversationFlowState;
    if (state.flow_code?.trim()) {
      const sid = await ensureActiveFlowSessionForConversation(
        supabase,
        state.empresa_id,
        conversationId,
        state.flow_code
      );
      if (sid) state.active_flow_session_id = sid;
    }
    return state;
  }

  async function insertFlowEvent(input: {
    empresaId: string;
    conversationId: string;
    flowCode?: string | null;
    nodeCode?: string | null;
    eventType: string;
    selectedOptionId?: string | null;
    metaButtonId?: string | null;
    payload?: Record<string, unknown>;
    flowSessionId?: string | null;
  }) {
    let sid = input.flowSessionId?.trim() || null;
    if (!sid) {
      const { data: crow } = await supabase
        .from("chat_conversations")
        .select("active_flow_session_id")
        .eq("id", input.conversationId)
        .eq("empresa_id", input.empresaId)
        .maybeSingle();
      sid = (crow as { active_flow_session_id?: string | null } | null)?.active_flow_session_id?.trim() || null;
    }
    const row = {
      empresa_id: input.empresaId,
      conversation_id: input.conversationId,
      flow_code: input.flowCode ?? null,
      node_code: input.nodeCode ?? null,
      event_type: input.eventType,
      selected_option_id: input.selectedOptionId ?? null,
      meta_button_id: input.metaButtonId ?? null,
      payload: input.payload ?? {},
      flow_session_id: sid,
    };
    const firstIns = await supabase.from("chat_flow_events").insert(row);
    const error = firstIns.error;
    const errCode = (error as { code?: string } | null)?.code;
    const errMsg = (error?.message ?? "").toLowerCase();
    if (
      error &&
      input.selectedOptionId &&
      (errCode === "23503" ||
        errMsg.includes("chat_flow_events_selected_option_id_fkey") ||
        (errMsg.includes("foreign key") && errMsg.includes("selected_option")))
    ) {
      let schemaHint: string | null = null;
      let optionFoundById = false;
      try {
        schemaHint = await fetchDataSchemaForEmpresaId(input.empresaId);
        const probe = await supabase
          .from("chat_flow_options")
          .select("id")
          .eq("id", input.selectedOptionId)
          .maybeSingle();
        optionFoundById = Boolean(probe.data);
      } catch {
        schemaHint = null;
      }
      const reason = optionFoundById
        ? "fk_violation_option_exists_locally_migrate_tenant_selected_option_fk"
        : "option_uuid_not_in_chat_flow_options";
      console.info("[flow-engine][selected-option-resolution]", {
        schema: schemaHint,
        empresa_id: input.empresaId,
        conversation_id: input.conversationId,
        session_id: sid,
        flow_code: input.flowCode ?? null,
        current_node_code: input.nodeCode ?? null,
        received_option_id: input.selectedOptionId,
        option_found_by_id: optionFoundById,
        option_found_by_payload: null,
        option_found_in_current_node: null,
        fallback_option_id_used: null,
        reason,
      });
      const { error: e2 } = await supabase.from("chat_flow_events").insert({
        ...row,
        selected_option_id: null,
        payload: {
          ...(row.payload as Record<string, unknown>),
          selected_option_id_omitted: true,
          selected_option_id_omission_reason: reason,
        },
      });
      if (e2) {
        console.error("[flow-engine] event insert retry:", e2.message);
      } else {
        console.warn("[flow-engine] chat_flow_events: omitió selected_option_id (FK inválida)", {
          conversationId: input.conversationId,
          optionId: input.selectedOptionId,
          schema: schemaHint,
          diagnosticReason: reason,
        });
      }
    } else if (error) {
      console.error("[flow-engine] event insert:", error.message);
    }
  }

  type FlowSendContext =
    | {
        conversation: ConversationFlowState;
        provider: "meta";
        toDigits: string;
        phoneNumberId: string;
        token: string;
      }
    | {
        conversation: ConversationFlowState;
        provider: "ycloud";
        toDigits: string;
        ycloudApiKey: string;
        ycloudFromE164: string;
      };

  async function getConversationSendContext(conversationId: string): Promise<FlowSendContext> {
    const conversation = await getConversationFlowState(conversationId);
    if (!conversation) throw new Error("Conversación no encontrada");

    const ds = await fetchDataSchemaForEmpresaId(conversation.empresa_id);
    const outbound = await resolveOutboundTextContextFromIds(
      supabase,
      {
        contactId: conversation.contact_id,
        channelId: conversation.channel_id,
      },
      { dataSchema: ds }
    );

    if (outbound.provider === "meta") {
      return {
        conversation,
        provider: "meta",
        toDigits: outbound.toDigits,
        phoneNumberId: outbound.phoneNumberId,
        token: outbound.accessToken,
      };
    }
    return {
      conversation,
      provider: "ycloud",
      toDigits: outbound.toDigits,
      ycloudApiKey: outbound.apiKey,
      ycloudFromE164: outbound.fromE164,
    };
  }

  async function flowSendText(ctx: FlowSendContext, text: string) {
    const slice =
      ctx.provider === "meta"
        ? {
            provider: "meta" as const,
            toDigits: ctx.toDigits,
            phoneNumberId: ctx.phoneNumberId,
            accessToken: ctx.token,
          }
        : {
            provider: "ycloud" as const,
            toDigits: ctx.toDigits,
            apiKey: ctx.ycloudApiKey,
            fromE164: ctx.ycloudFromE164,
          };
    return sendOutboundTextMessage(slice, text);
  }

  /**
   * Construye la definición aditiva `neura_interactive` (solo para la UI del inbox).
   * NO altera lo que se envía a WhatsApp/Meta; solo se persiste para poder renderizar
   * los botones/opciones como chips read-only en el chat del ERP.
   */
  function buildNeuraInteractiveFromOptions(
    groupTitle: string,
    opts: ReadonlyArray<{ meta_button_id: string; option_value?: string | null }>
  ): Record<string, unknown> {
    return {
      kind: "buttons",
      groupTitle,
      items: opts.map((o) => ({
        id: o.meta_button_id,
        title: whatsAppInteractiveTitleFromOption(o as unknown as FlowOption),
        payload: o.option_value ?? null,
      })),
    };
  }

  async function persistOutgoingMessage(input: {
    conversation: ConversationFlowState;
    content: string;
    messageType: string;
    waMessageId: string | null;
    raw: unknown;
    senderType: "system" | "human" | "ai";
    automationSource: string;
    /** Definición aditiva de botones para la UI (read-only). No afecta el envío a Meta. */
    neuraInteractive?: Record<string, unknown> | null;
  }) {
    const ts = new Date().toISOString();
    await supabase.from("chat_messages").insert({
      empresa_id: input.conversation.empresa_id,
      conversation_id: input.conversation.id,
      wa_message_id: input.waMessageId,
      from_me: true,
      sender_type: input.senderType,
      automation_source: input.automationSource,
      message_type: input.messageType,
      content: input.content,
      raw_payload: {
        ...((input.raw ?? {}) as Record<string, unknown>),
        ...(input.neuraInteractive ? { neura_interactive: input.neuraInteractive } : {}),
      } as Record<string, unknown>,
    });
    await supabase
      .from("chat_conversations")
      .update({
        last_message_at: ts,
        last_message_preview: input.content.slice(0, 280),
        updated_at: ts,
      })
      .eq("id", input.conversation.id);
  }

  async function ensureChatMediaBucket() {
    if (chatMediaBucketChecked) return;
    const { data: buckets, error: listErr } = await supabase.storage.listBuckets();
    if (listErr) throw new Error(listErr.message);
    const exists = (buckets ?? []).some((b) => b.name === CHAT_MEDIA_BUCKET);
    if (!exists) {
      const { error: createErr } = await supabase.storage.createBucket(CHAT_MEDIA_BUCKET, {
        public: true,
        fileSizeLimit: "10MB",
      });
      if (createErr && !createErr.message.toLowerCase().includes("already exists")) {
        throw new Error(createErr.message);
      }
    }
    chatMediaBucketChecked = true;
  }

  async function downloadMetaMedia(params: {
    mediaId: string;
    accessToken: string;
    mimeTypeHint?: string | null;
  }): Promise<{ bytes: Uint8Array; mimeType: string }> {
    return downloadMetaMediaBytes(params);
  }

  async function isFlowDefinitionActive(empresaId: string, flowCode: string): Promise<boolean> {
    const { data, error } = await supabase
      .from("chat_flows")
      .select("activo")
      .eq("empresa_id", empresaId)
      .eq("flow_code", flowCode)
      .maybeSingle();
    if (error) {
      console.warn("[flow-engine] isFlowDefinitionActive:", error.message);
      return true;
    }
    if (!data) return true;
    return (data as { activo?: boolean }).activo !== false;
  }

  async function wasNodeSentForCurrentStep(
    conversationId: string,
    flowCode: string,
    nodeCode: string,
    flowSessionId: string | null | undefined
  ): Promise<boolean> {
    const sid = flowSessionId?.trim();
    if (!sid) {
      console.warn("[flow-engine] wasNodeSentForCurrentStep: no flow_session_id, assume not sent", {
        conversationId,
        flowCode,
        nodeCode,
      });
      return false;
    }
    const { data, error } = await supabase
      .from("chat_flow_events")
      .select("id")
      .eq("conversation_id", conversationId)
      .eq("flow_code", flowCode)
      .eq("flow_session_id", sid)
      .eq("node_code", nodeCode)
      .eq("event_type", "node_sent")
      .limit(1)
      .maybeSingle();
    if (error) {
      console.error("[flow-engine] wasNodeSentForCurrentStep:", error.message);
      return false;
    }
    return Boolean((data as { id?: string } | null)?.id);
  }

  /**
   * Tras un mensaje entrante del cliente: si el nodo actual aún no se envió (botones/texto/media, etc.),
   * ejecuta sendCurrentFlowNode. Sin esto, processTextReply ignora textos cuando el nodo no es captura.
   */
  async function ensureCurrentNodePresentedAfterInbound(
    params: EnsureInboundPresentParams
  ): Promise<EnsureInboundPresentResult> {
    const logPrefix = "[flow-engine][inbound-present]";
    try {
      const state = await getConversationFlowState(params.conversationId);
      if (!state || state.empresa_id !== params.empresaId) {
        console.info(logPrefix, "skip: conversation_not_found", {
          conversationId: params.conversationId,
        });
        return {
          ok: true,
          status: "conversation_not_found",
          presentedNow: false,
          acceptsInboundTextAsCapture: false,
        };
      }
      if (!isConversationInBotAutomationMode(state)) {
        console.info(logPrefix, "skip: not_bot_mode", {
          conversationId: state.id,
          flow_status: state.flow_status,
          human_taken_over: state.human_taken_over,
        });
        return {
          ok: true,
          status: "skipped_not_bot_mode",
          presentedNow: false,
          acceptsInboundTextAsCapture: false,
        };
      }
      if (!state.flow_code?.trim() || !state.flow_current_node?.trim()) {
        console.info(logPrefix, "skip: missing_flow_pointer", {
          conversationId: state.id,
          flow_code: state.flow_code,
          flow_current_node: state.flow_current_node,
        });
        return {
          ok: true,
          status: "missing_flow_state",
          presentedNow: false,
          acceptsInboundTextAsCapture: false,
        };
      }

      flowTrace("inbound_present_engine_state", {
        conversation_id: state.id,
        empresa_id: state.empresa_id,
        active_flow_session_id: state.active_flow_session_id ?? null,
        flow_current_node: state.flow_current_node,
        flow_code: state.flow_code,
        event: "ensure_current_node_presented",
      });

      const flowCode = state.flow_code as string;
      const nodeCode = state.flow_current_node as string;

      const flowActive = await isFlowDefinitionActive(state.empresa_id, flowCode);
      if (!flowActive) {
        console.warn(logPrefix, "skip: flow_inactive_in_catalog", { flowCode, conversationId: state.id });
        await insertFlowEvent({
          empresaId: state.empresa_id,
          conversationId: state.id,
          flowCode,
          nodeCode,
          flowSessionId: state.active_flow_session_id,
          eventType: "automation_skipped_flow_inactive",
          payload: {},
        });
        return {
          ok: true,
          status: "flow_inactive",
          presentedNow: false,
          acceptsInboundTextAsCapture: false,
        };
      }

      const already = await wasNodeSentForCurrentStep(
        state.id,
        flowCode,
        nodeCode,
        state.active_flow_session_id
      );
      if (already) {
        const nodeForCapture = await getNode(state.empresa_id, flowCode, nodeCode);
        const acceptsAlreadyPresented = Boolean(
          nodeForCapture?.node_type === "text" && nodeForCapture.save_as_field?.trim()
        );
        console.info(logPrefix, "skip: node_already_sent", {
          conversationId: state.id,
          flowCode,
          nodeCode,
          acceptsInboundTextAsCapture: acceptsAlreadyPresented,
        });
        return {
          ok: true,
          status: "already_presented",
          presentedNow: false,
          acceptsInboundTextAsCapture: acceptsAlreadyPresented,
        };
      }

      console.info(logPrefix, "trigger: sending_current_node", {
        conversationId: state.id,
        empresaId: state.empresa_id,
        flowCode,
        nodeCode,
      });

      const sent = await sendCurrentFlowNode({ conversationId: state.id });
      if (!sent.ok) {
        console.error(logPrefix, "send_failed", { conversationId: state.id, error: sent.error });
        await insertFlowEvent({
          empresaId: state.empresa_id,
          conversationId: state.id,
          flowCode,
          nodeCode,
          flowSessionId: state.active_flow_session_id,
          eventType: "present_failed",
          payload: { error: sent.error ?? "unknown" },
        });
        return {
          ok: false,
          status: "send_failed",
          presentedNow: false,
          acceptsInboundTextAsCapture: false,
          error: sent.error,
        };
      }

      const presentedNodeCode = sent.nodeCode ?? nodeCode;
      const presentedNode = await getNode(state.empresa_id, flowCode.trim(), presentedNodeCode);
      const acceptsInboundTextAsCapture = Boolean(
        presentedNode?.node_type === "text" && presentedNode.save_as_field?.trim()
      );

      console.info(logPrefix, "ok: node_presented", {
        conversationId: state.id,
        nodeCode: presentedNodeCode,
        acceptsInboundTextAsCapture,
      });
      return {
        ok: true,
        status: "presented",
        presentedNow: true,
        acceptsInboundTextAsCapture,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(logPrefix, "exception", msg);
      return {
        ok: false,
        status: "exception",
        presentedNow: false,
        acceptsInboundTextAsCapture: false,
        error: msg,
      };
    }
  }

  async function getNode(
    empresaId: string,
    flowCode: string,
    nodeCode: string
  ): Promise<FlowNode | null> {
    const { data, error } = await supabase
      .from("chat_flow_nodes")
      .select(
        "id, empresa_id, flow_code, node_code, message_text, save_as_field, next_node_code, node_type, is_active"
      )
      .eq("empresa_id", empresaId)
      .eq("flow_code", flowCode)
      .eq("node_code", nodeCode)
      .eq("is_active", true)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return (data as FlowNode | null) ?? null;
  }

  async function getNodeOptions(nodeId: string): Promise<FlowOption[]> {
    const { data, error } = await supabase
      .from("chat_flow_options")
      .select(
        "id, label, option_value, meta_button_id, next_node_code, sort_order, option_payload, group_title, group_order"
      )
      .eq("node_id", nodeId)
      .order("sort_order", { ascending: true });
    if (error) throw new Error(error.message);
    return (data ?? []) as FlowOption[];
  }

  /**
   * Coincidencia WhatsApp → opción BD: Meta devuelve `interactive.*.id`; debe alinear con `meta_button_id`
   * u `option_value`. Fallback por título visible si hay un único match (listas / IDs desfasados tras ediciones).
   */
  function resolveSelectedFlowOption(
    options: FlowOption[],
    metaButtonId: string,
    rawPayload: Record<string, unknown>
  ): FlowOption | undefined {
    const idIn = metaButtonId.trim();
    if (!idIn || options.length === 0) return undefined;

    /** WhatsApp puede devolver el UUID de fila `chat_flow_options.id` (reply id = id guardado al enviar). */
    let picked = options.find((o) => String(o.id ?? "").trim() === idIn);
    if (picked) return picked;

    picked = options.find((o) => String(o.meta_button_id ?? "").trim() === idIn);
    if (picked) return picked;

    picked = options.find((o) => String(o.option_value ?? "").trim() === idIn);
    if (picked) {
      console.info("[flow-runtime]", "option_match_by_option_value", { idIn });
      return picked;
    }

    const low = idIn.toLowerCase();
    picked =
      options.find((o) => String(o.meta_button_id ?? "").trim().toLowerCase() === low) ??
      options.find((o) => String(o.option_value ?? "").trim().toLowerCase() === low);
    if (picked) {
      console.info("[flow-runtime]", "option_match_case_insensitive", { idIn });
      return picked;
    }

    const intr = rawPayload?.interactive as
      | { list_reply?: { id?: string; title?: string }; button_reply?: { id?: string; title?: string } }
      | undefined;
    const listTitle = intr?.list_reply?.title?.trim();
    if (listTitle) {
      const metaTitle = (o: FlowOption) =>
        whatsAppInteractiveTitleFromOption(o).trim().slice(0, WA_META_LIST_ROW_TITLE_MAX);
      const matches = options.filter((o) => metaTitle(o) === listTitle);
      if (matches.length === 1) {
        console.info("[flow-runtime]", "option_match_unique_list_title", { listTitle });
        return matches[0];
      }
    }
    const btnTitle = intr?.button_reply?.title?.trim();
    if (btnTitle) {
      /** Meta trunca reply buttons al enviar; el id devuelto debe matchear primero; si no, igual que envío saliente. */
      const metaTitle = (o: FlowOption) =>
        whatsAppInteractiveTitleFromOption(o).trim().slice(0, WA_META_REPLY_TITLE_MAX);
      const matches = options.filter((o) => metaTitle(o) === btnTitle);
      if (matches.length === 1) {
        console.info("[flow-runtime]", "option_match_unique_button_title", { btnTitle });
        return matches[0];
      }
    }

    /** Legado / flujo editado: id guardado en payload de la opción (no es la PK actual). */
    for (const o of options) {
      const pl = o.option_payload;
      if (!pl || typeof pl !== "object" || Array.isArray(pl)) continue;
      const p = pl as Record<string, unknown>;
      for (const k of ["opcion_id", "legacy_option_id", "button_id", "value"]) {
        const v = p[k];
        if (v != null && String(v).trim() === idIn) {
          console.info("[flow-runtime]", "option_match_by_payload_field", { idIn, field: k });
          return o;
        }
      }
    }

    return undefined;
  }

  async function getConversationFlowDataMap(input: {
    empresaId: string;
    conversationId: string;
    flowCode: string | null;
    flowSessionId: string | null | undefined;
    traceReadContext?: string;
  }): Promise<Record<string, string>> {
    const fc = input.flowCode?.trim();
    const sid = input.flowSessionId?.trim();
    if (!fc || !sid) {
      flowTrace("flow_data_read", {
        conversation_id: input.conversationId,
        empresa_id: input.empresaId,
        flow_code: fc ?? null,
        flow_session_id_read: sid ?? null,
        read_context: input.traceReadContext ?? "unspecified",
        empty_reason: !fc ? "missing_flow_code" : "missing_flow_session_id",
        field_count: 0,
      });
      return {};
    }
    const { data, error } = await supabase
      .from("chat_flow_data")
      .select("field_name, field_value")
      .eq("empresa_id", input.empresaId)
      .eq("conversation_id", input.conversationId)
      .eq("flow_code", fc)
      .eq("flow_session_id", sid);
    if (error) throw new Error(error.message);
    const out: Record<string, string> = {};
    for (const row of data ?? []) {
      const key = String((row as { field_name?: unknown }).field_name ?? "").trim();
      if (!key) continue;
      out[key] = String((row as { field_value?: unknown }).field_value ?? "");
    }
    const sum = summarizeFlowDataForTrace(out);
    flowTrace("flow_data_read", {
      conversation_id: input.conversationId,
      empresa_id: input.empresaId,
      flow_code: fc,
      flow_session_id_read: sid,
      read_context: input.traceReadContext ?? "unspecified",
      field_count: Object.keys(out).length,
      flow_data_keys: sum.keys,
      flow_data_samples: sum.samples ?? null,
    });
    return out;
  }

  function opcionTitleFromRawMeta(payload: Record<string, unknown>): string | null {
    const raw = payload.raw;
    if (!raw || typeof raw !== "object") return null;
    const interactive = (raw as Record<string, unknown>).interactive;
    if (!interactive || typeof interactive !== "object") return null;
    const br = (interactive as Record<string, unknown>).button_reply;
    const lr = (interactive as Record<string, unknown>).list_reply;
    const fromBr =
      br && typeof br === "object" && typeof (br as Record<string, unknown>).title === "string"
        ? String((br as Record<string, unknown>).title).trim()
        : "";
    const fromLr =
      lr && typeof lr === "object" && typeof (lr as Record<string, unknown>).title === "string"
        ? String((lr as Record<string, unknown>).title).trim()
        : "";
    const title = fromBr || fromLr;
    return title || null;
  }

  /**
   * Reconstruye variables del flujo desde `chat_flow_events` tras un reinicio o si `chat_flow_data`
   * quedó vacío: textos capturados y payloads de botones/listas quedan auditados ahí.
   */
  async function hydrateFlowDataFromSessionEvents(
    conversationId: string,
    flowCode: string,
    base: Record<string, string>,
    flowSessionId: string | null | undefined
  ): Promise<Record<string, string>> {
    const fc = flowCode.trim();
    const sid = flowSessionId?.trim();
    if (!fc || !sid) return base;

    const { data: rows, error } = await supabase
      .from("chat_flow_events")
      .select("event_type, payload, created_at")
      .eq("conversation_id", conversationId)
      .eq("flow_code", fc)
      .eq("flow_session_id", sid)
      .in("event_type", ["text_captured", "button_selected"])
      .order("created_at", { ascending: true });
    if (error) {
      console.warn(FLOW_SORTEO_LOG, "hydrate_events_failed", { message: error.message });
      return base;
    }

    const merged: Record<string, string> = { ...base };
    const slotEmpty = (key: string) => !String(merged[key] ?? "").trim();
    for (const row of rows ?? []) {
      const et = String((row as { event_type?: string }).event_type ?? "");
      const payload = ((row as { payload?: Record<string, unknown> }).payload ?? {}) as Record<
        string,
        unknown
      >;
      if (et === "text_captured") {
        const field = typeof payload.save_as_field === "string" ? payload.save_as_field.trim() : "";
        const tv = typeof payload.text_value === "string" ? payload.text_value.trim() : "";
        if (field && tv && slotEmpty(field)) merged[field] = tv;
      } else if (et === "button_selected") {
        const op = payload.option_payload;
        if (op && typeof op === "object" && !Array.isArray(op)) {
          for (const [k, v] of Object.entries(op as Record<string, unknown>)) {
            const kn = k.trim();
            if (!kn) continue;
            const sv =
              typeof v === "string" || typeof v === "number" || typeof v === "boolean"
                ? String(v)
                : "";
            if (sv && slotEmpty(kn)) merged[kn] = sv;
          }
        }
        const ov = typeof payload.option_value === "string" ? payload.option_value.trim() : "";
        if (ov && slotEmpty("option_value")) merged["option_value"] = ov;
        const ol =
          (typeof payload.option_label === "string" ? payload.option_label.trim() : "") ||
          opcionTitleFromRawMeta(payload) ||
          "";
        if (ol && slotEmpty("opcion_label")) merged["opcion_label"] = ol;
      }
    }
    if ((rows?.length ?? 0) > 0) {
      console.info(FLOW_SORTEO_LOG, "hydrate_flow_data_applied", {
        conversationId,
        flowCode: fc,
        flowSessionId: sid,
        eventCount: rows?.length ?? 0,
        keysAfter: Object.keys(merged).length,
      });
    }
    const sumM = summarizeFlowDataForTrace(merged);
    flowTrace("flow_data_after_event_hydrate", {
      conversation_id: conversationId,
      flow_code: fc,
      flow_session_id: sid,
      event: "resumen_vars_from_events",
      event_count: rows?.length ?? 0,
      flow_data_keys: sumM.keys,
      flow_data_samples: sumM.samples ?? null,
    });
    return merged;
  }

  async function buildHydratedFlowDataForCompletenessGate(input: {
    empresaId: string;
    conversationId: string;
    flowCode: string;
    flowSessionId: string;
    mergeFlowVars?: Record<string, string>;
  }): Promise<Record<string, string>> {
    const rawFd = await getConversationFlowDataMap({
      empresaId: input.empresaId,
      conversationId: input.conversationId,
      flowCode: input.flowCode,
      flowSessionId: input.flowSessionId,
      traceReadContext: "flow_completeness_gate",
    });
    let hyd = await hydrateFlowDataFromSessionEvents(
      input.conversationId,
      input.flowCode,
      rawFd,
      input.flowSessionId
    );
    if (input.mergeFlowVars && Object.keys(input.mergeFlowVars).length > 0) {
      hyd = { ...hyd, ...input.mergeFlowVars };
    }
    return hyd;
  }

  async function resolveProposedNextWithCompletenessGate(input: {
    empresaId: string;
    conversationId: string;
    flowCode: string;
    flowSessionId: string;
    proposedNextCode: string;
    mergeFlowVars?: Record<string, string>;
    gateReason: string;
  }): Promise<{ effectiveNext: string; redirected: boolean }> {
    const hydFd = await buildHydratedFlowDataForCompletenessGate({
      empresaId: input.empresaId,
      conversationId: input.conversationId,
      flowCode: input.flowCode,
      flowSessionId: input.flowSessionId,
      mergeFlowVars: input.mergeFlowVars,
    });
    const resolved = await resolveEffectiveNodeCodeForFlowCompleteness(
      supabase,
      input.empresaId,
      input.flowCode,
      hydFd,
      input.proposedNextCode
    );
    if (resolved.redirected) {
      const desc = await describeFlowCaptureCompletenessForLogs(
        supabase,
        input.empresaId,
        input.flowCode,
        hydFd
      );
      console.info("[sorteo-close][required-fields-check]", {
        conversation_id: input.conversationId,
        flow_session_id: input.flowSessionId,
        required_fields: desc?.required_fields ?? [],
        missing_fields: desc?.missing_fields ?? [],
        blocked_node_code: input.proposedNextCode.trim(),
        redirected_to: resolved.effectiveNodeCode,
        gate_reason: input.gateReason,
      });
    }
    return { effectiveNext: resolved.effectiveNodeCode, redirected: resolved.redirected };
  }

  /**
   * Último valor no vacío por `field_name` en toda la conversación+mismo flujo (todas las sesiones).
   * Recorre filas por `created_at` descendente: la primera fila no vacía por clave gana (más reciente).
   */
  async function mergeConversationFlowDataFromOlderSessions(input: {
    empresaId: string;
    conversationId: string;
    flowCode: string;
    base: Record<string, string>;
  }): Promise<{ merged: Record<string, string>; filledKeys: string[] }> {
    const fc = input.flowCode.trim();
    const { data, error } = await supabase
      .from("chat_flow_data")
      .select("field_name, field_value, flow_session_id, created_at")
      .eq("empresa_id", input.empresaId)
      .eq("conversation_id", input.conversationId)
      .eq("flow_code", fc)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    const merged: Record<string, string> = { ...input.base };
    const filledKeys: string[] = [];
    const slotEmpty = (k: string) => !String(merged[k] ?? "").trim();
    for (const row of data ?? []) {
      const key = String((row as { field_name?: string }).field_name ?? "").trim();
      if (!key) continue;
      // No mezclar metadatos del comprobante de otro envío; el pipeline actual los define.
      if (key.startsWith("sorteo_comprobante_")) continue;
      // No heredar la IDENTIDAD del participante (cedula/nombre/apellido/ciudad) de una compra
      // ANTERIOR: en una recompra la sesión actual la vuelve a capturar, y heredarla hacía que la
      // orden se creara temprano (paso del comprobante) con los datos viejos. Excluyéndola, el
      // recomprador sigue el mismo camino del primer comprador (orden recién en la confirmación,
      // con datos frescos). Mismo clasificador que el gate de completitud, para no divergir.
      if (isIdentityCaptureField(key)) continue;
      const val = String((row as { field_value?: string }).field_value ?? "").trim();
      if (!val || !slotEmpty(key)) continue;
      merged[key] = val;
      filledKeys.push(key);
    }
    return { merged, filledKeys };
  }

  /** Si el flujo no tiene nombre guardado, usar nombre del contacto WhatsApp (chat_contacts). */
  async function hydrateSorteoFlowDataFromChatContact(
    empresaId: string,
    contactId: string | null | undefined,
    base: Record<string, string>
  ): Promise<Record<string, string>> {
    const cid = contactId?.trim();
    if (!cid) return base;
    const hasNombre =
      String(base.nombre ?? "").trim() ||
      String(base.apellido ?? "").trim() ||
      String(base.nombre_completo ?? "").trim() ||
      String(base.nombre_y_apellido ?? "").trim();
    if (hasNombre) return base;
    const { data, error } = await supabase
      .from("chat_contacts")
      .select("name")
      .eq("empresa_id", empresaId)
      .eq("id", cid)
      .maybeSingle();
    if (error || !data) return base;
    const nm = String((data as { name?: string | null }).name ?? "").trim();
    if (!nm) return base;
    const out: Record<string, string> = { ...base };
    const parts = nm.split(/\s+/).filter(Boolean);
    if (!String(out.nombre_completo ?? "").trim()) out.nombre_completo = nm;
    if (!String(out.nombre ?? "").trim()) {
      out.nombre = parts.length >= 2 ? parts[0] : nm;
    }
    if (parts.length >= 2 && !String(out.apellido ?? "").trim()) {
      out.apellido = parts.slice(1).join(" ");
    }
    return out;
  }

  function interpolateTemplate(
    input: string,
    vars: Record<string, string | number | boolean | null | undefined>
  ): string {
    return input.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_full, name: string) => {
      const raw = vars[name];
      if (raw === null || raw === undefined) return "";
      return String(raw);
    });
  }

  async function buildImageInputReminderText(
    node: FlowNode,
    conversationId: string,
    reason: "expected_image_got_text" | "expected_image_got_non_image"
  ): Promise<string> {
    const st = await getConversationFlowState(conversationId);
    const flowVars = await getConversationFlowDataMap({
      empresaId: node.empresa_id,
      conversationId,
      flowCode: node.flow_code,
      flowSessionId: st?.active_flow_session_id ?? null,
      traceReadContext: "image_input_reminder_text",
    });
    const base = interpolateTemplate(node.message_text?.trim() || "", flowVars).trim();
    const tail =
      reason === "expected_image_got_text"
        ? "Por favor enviá el comprobante como imagen (foto o captura), no como mensaje de texto."
        : "Ese formato no sirve como comprobante. Enviá foto (JPG/PNG), imagen como archivo o PDF del comprobante.";
    if (base) return `${base}\n\n${tail}`;
    return tail;
  }

  async function getNodeBlocks(node: FlowNode): Promise<FlowNodeBlock[]> {
    const { data, error } = await supabase
      .from("chat_flow_node_blocks")
      .select("id, node_id, block_type, content_text, media_url, sort_order")
      .eq("empresa_id", node.empresa_id)
      .eq("node_id", node.id)
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true });
    if (error) throw new Error(error.message);
    return (data ?? []) as FlowNodeBlock[];
  }

  async function advanceConversationToNode(
    params: AdvanceConversationParams
  ): Promise<{ ok: boolean; error?: string }> {
    const { error } = await supabase
      .from("chat_conversations")
      .update({
        flow_code: params.flowCode,
        flow_current_node: params.nextNodeCode,
        flow_status: "bot",
        human_taken_over: false,
        updated_at: new Date().toISOString(),
      })
      .eq("id", params.conversationId)
      .eq("empresa_id", params.empresaId);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  }

  /**
   * Cierra la sesión de flujo cuando se acaba de enviar el nodo FINAL de compra de sorteo
   * (p. ej. `compra_realizada`, sin next_node_code). Sin esto, la conversación queda "pegada"
   * en el nodo final con sesión `active`, y un mensaje/botón posterior del cliente recurrente
   * reejecuta/reenvía la confirmación o ticket de la orden vieja (bug auditado).
   * Deja el puntero en null para que el próximo mensaje entre como compra nueva (reinicio limpio
   * vía webhook), sin tocar numero_orden/cupones/ticket previos. No reenvía nada por sí mismo.
   */
  async function maybeCompleteSorteoFinalSession(
    state: ConversationFlowState,
    node: FlowNode
  ): Promise<void> {
    const isFinal =
      !node.next_node_code?.trim() &&
      isSorteoFinalTicketNode(node.node_code, { nodeMessageTemplate: node.message_text });
    if (!isFinal) return;
    try {
      await markConversationActiveSessionsEnded(
        supabase,
        state.empresa_id,
        state.id,
        "completed",
        `final_node:${node.node_code}`
      );
      await supabase
        .from("chat_conversations")
        .update({
          active_flow_session_id: null,
          flow_current_node: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", state.id)
        .eq("empresa_id", state.empresa_id);
      await insertFlowEvent({
        empresaId: state.empresa_id,
        conversationId: state.id,
        flowCode: state.flow_code,
        nodeCode: node.node_code,
        flowSessionId: state.active_flow_session_id,
        eventType: "flow_session_completed_final_node",
        payload: { node_code: node.node_code, reason: "sorteo_final_node_sent" },
      });
      console.info("[flow-engine] sorteo_final_session_completed", {
        conversationId: state.id,
        nodeCode: node.node_code,
        prevSessionId: state.active_flow_session_id ?? null,
      });
    } catch (e) {
      console.warn(
        "[flow-engine] maybeCompleteSorteoFinalSession_failed",
        e instanceof Error ? e.message : String(e)
      );
    }
  }

  /**
   * Tras enviar un nodo saliente: si hay siguiente paso y el nodo no espera input del cliente,
   * avanza la conversación y ejecuta sendCurrentFlowNode recursivamente (máx. __autoHop).
   * Importante: la rama legacy (sin bloques) debe usar la misma lógica que la rama con bloques.
   */
  async function autoChainOutboundIfApplicable(
    state: ConversationFlowState,
    node: FlowNode,
    currentHop: number,
    mergeFlowVars?: Record<string, string>
  ): Promise<{ ok: boolean; nodeCode?: string; error?: string } | null> {
    const canAutoAdvance =
      Boolean(node.next_node_code) &&
      !["buttons", "list", "image_input", "human", "end"].includes(node.node_type) &&
      !(node.node_type === "text" && Boolean(node.save_as_field?.trim()));
    if (!canAutoAdvance || !node.next_node_code || !state.flow_code) return null;

    console.info("[flow-engine] auto_chain_after_outbound", {
      conversationId: state.id,
      fromNode: node.node_code,
      nextNodeCode: node.next_node_code,
      node_type: node.node_type,
      save_as_field: node.save_as_field ?? null,
      carriesMergeFlowVars: Boolean(mergeFlowVars && Object.keys(mergeFlowVars).length),
    });

    const sidChain = state.active_flow_session_id?.trim();
    if (!sidChain) return null;
    const chainResolved = await resolveProposedNextWithCompletenessGate({
      empresaId: state.empresa_id,
      conversationId: state.id,
      flowCode: state.flow_code,
      flowSessionId: sidChain,
      proposedNextCode: node.next_node_code.trim(),
      mergeFlowVars,
      gateReason: "auto_chain_after_outbound",
    });

    const adv = await advanceConversationToNode({
      conversationId: state.id,
      empresaId: state.empresa_id,
      flowCode: state.flow_code,
      nextNodeCode: chainResolved.effectiveNext,
    });
    if (!adv.ok) return { ok: false, error: adv.error ?? "No se pudo auto-avanzar nodo" };

    await insertFlowEvent({
      empresaId: state.empresa_id,
      conversationId: state.id,
      flowCode: state.flow_code,
      nodeCode: chainResolved.effectiveNext,
      flowSessionId: state.active_flow_session_id,
      eventType: "node_advanced",
      payload: {
        from_node: node.node_code,
        next_node_code: chainResolved.effectiveNext,
        reason: "auto_chain_after_outbound",
      },
    });
    return sendCurrentFlowNode({
      conversationId: state.id,
      __autoHop: currentHop + 1,
      mergeFlowVars,
    });
  }

  /** Varias burbujas reply-buttons (misma sesión / mismo node_code). Solo modo grupos. */
  async function emitGroupedQuickReplyButtonMessages(args: {
    ctxSend: FlowSendContext;
    conversation: ConversationFlowState;
    empresaId: string;
    flowCode: string;
    nodeCode: string;
    options: FlowOption[];
    defaultGroupTitle: string;
  }): Promise<{ ok: true } | { ok: false; error: string }> {
    if (args.ctxSend.provider !== "meta") {
      return {
        ok: false,
        error: ycloudOutboundUnsupportedMessage("botones interactivos agrupados"),
      };
    }
    const ctxSend = args.ctxSend;

    const schema = await fetchDataSchemaForEmpresaId(args.empresaId);
    const groups = partitionQuickReplyButtonGroups(args.options, args.defaultGroupTitle);
    const validationError = validateQuickReplyGroupsMaxThree(groups);
    if (validationError) {
      console.warn("[flow-buttons-groups][send-aborted]", {
        schema,
        empresa_id: args.empresaId,
        flow_code: args.flowCode,
        node_code: args.nodeCode,
        conversation_id: args.conversation.id,
        reason_preview: validationError.slice(0, 160),
      });
      return { ok: false, error: validationError };
    }

    console.info("[flow-buttons-groups][send-start]", {
      schema,
      empresa_id: args.empresaId,
      flow_code: args.flowCode,
      node_code: args.nodeCode,
      conversation_id: args.conversation.id,
      groups_count: groups.length,
    });

    for (const g of groups) {
      const send = await sendWhatsAppInteractiveButtons({
        toDigits: ctxSend.toDigits,
        phoneNumberId: ctxSend.phoneNumberId,
        accessToken: ctxSend.token,
        bodyText: g.groupTitle.slice(0, 1024),
        buttons: g.options.map((o) => ({
          id: o.meta_button_id,
          title: whatsAppInteractiveTitleFromOption(o as FlowOption),
        })),
      });
      if (!send.ok) {
        return { ok: false, error: send.error ?? "interactive_send_failed" };
      }

      await persistOutgoingMessage({
        conversation: args.conversation,
        content: g.groupTitle,
        messageType: "interactive",
        waMessageId: send.waMessageId,
        raw: send.raw,
        senderType: "system",
        automationSource: "flow_engine",
        neuraInteractive: buildNeuraInteractiveFromOptions(g.groupTitle, g.options),
      });

      console.info("[flow-buttons-groups][group-sent]", {
        schema,
        empresa_id: args.empresaId,
        flow_code: args.flowCode,
        node_code: args.nodeCode,
        conversation_id: args.conversation.id,
        group_title: g.groupTitle,
        group_order: g.groupOrder,
        options_count: g.options.length,
      });
    }

    return { ok: true };
  }

  /**
   * Audit wrapper: cualquier excepción no controlada o `ok:false` interno se persiste como
   * `flow_send_failed` en `chat_flow_events`, dejando el bot diagnosticable y permitiendo
   * el reintento manual del operador desde la inbox ("Reenviar paso"). El motor avanza el puntero
   * antes de enviar; si el envío falla aquí, sin este evento la conversación queda silenciosamente
   * bloqueada (P1 2026-05-23). Idempotente: no muta puntero ni datos del flujo.
   */
  async function sendCurrentFlowNode(
    params: SendCurrentNodeParams
  ): Promise<{ ok: boolean; nodeCode?: string; error?: string }> {
    let result: { ok: boolean; nodeCode?: string; error?: string };
    try {
      result = await sendCurrentFlowNodeImpl(params);
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      console.error("[flow-engine] sendCurrentFlowNode_exception", {
        conversationId: params.conversationId,
        error: errMsg,
      });
      await tryLogFlowSendFailed(params.conversationId, errMsg, "exception");
      return { ok: false, error: errMsg };
    }
    if (!result.ok) {
      await tryLogFlowSendFailed(
        params.conversationId,
        result.error ?? "send_failed",
        "ok_false"
      );
    }
    return result;
  }

  /** Best-effort audit del bot trabado. No re-lanza para no perder el ok:false original. */
  async function tryLogFlowSendFailed(
    conversationId: string,
    errorMessage: string,
    reason: "exception" | "ok_false"
  ): Promise<void> {
    try {
      const { data: conv } = await supabase
        .from("chat_conversations")
        .select("empresa_id, flow_code, flow_current_node, active_flow_session_id")
        .eq("id", conversationId)
        .maybeSingle();
      if (!conv) return;
      const c = conv as {
        empresa_id?: string | null;
        flow_code?: string | null;
        flow_current_node?: string | null;
        active_flow_session_id?: string | null;
      };
      if (!c.empresa_id || !c.flow_code) return;
      await insertFlowEvent({
        empresaId: c.empresa_id,
        conversationId,
        flowCode: c.flow_code,
        nodeCode: c.flow_current_node ?? null,
        flowSessionId: c.active_flow_session_id ?? null,
        eventType: "flow_send_failed",
        payload: {
          error_message: errorMessage.slice(0, 500),
          reason,
        },
      });
    } catch (auditErr) {
      console.warn("[flow-engine] flow_send_failed_audit_failed", {
        conversationId,
        message: auditErr instanceof Error ? auditErr.message : String(auditErr),
      });
    }
  }

  async function sendCurrentFlowNodeImpl(
    params: SendCurrentNodeParams
  ): Promise<{ ok: boolean; nodeCode?: string; error?: string }> {
    const currentHop = params.__autoHop ?? 0;
    if (currentHop > 10) {
      return { ok: false, error: "Se alcanzó el límite de auto-encadenamiento del flujo" };
    }
    const ctxSend = await getConversationSendContext(params.conversationId);
    const state = ctxSend.conversation;
    if (!state.flow_code || !state.flow_current_node) {
      return { ok: false, error: "Conversación sin flow_code o flow_current_node" };
    }
    if (!state.active_flow_session_id?.trim()) {
      return {
        ok: false,
        error: "Sesión de flujo no inicializada; escribí hola para reiniciar.",
      };
    }

    const node = await getNode(state.empresa_id, state.flow_code, state.flow_current_node);
    if (!node) return { ok: false, error: "Nodo actual no encontrado" };

    const sidGate = state.active_flow_session_id.trim();
    const hydFdPointer = await buildHydratedFlowDataForCompletenessGate({
      empresaId: state.empresa_id,
      conversationId: state.id,
      flowCode: state.flow_code,
      flowSessionId: sidGate,
      mergeFlowVars: params.mergeFlowVars,
    });
    const ptrResolved = await resolveEffectiveNodeCodeForFlowCompleteness(
      supabase,
      state.empresa_id,
      state.flow_code,
      hydFdPointer,
      state.flow_current_node
    );
    if (
      ptrResolved.redirected &&
      ptrResolved.effectiveNodeCode.trim() !== state.flow_current_node.trim()
    ) {
      const descPtr = await describeFlowCaptureCompletenessForLogs(
        supabase,
        state.empresa_id,
        state.flow_code,
        hydFdPointer
      );
      console.info("[sorteo-close][required-fields-check]", {
        conversation_id: state.id,
        flow_session_id: sidGate,
        required_fields: descPtr?.required_fields ?? [],
        missing_fields: descPtr?.missing_fields ?? [],
        blocked_node_code: state.flow_current_node.trim(),
        redirected_to: ptrResolved.effectiveNodeCode,
        gate_reason: "send_current_node_pointer_vs_flow_order",
      });
      const advPtr = await advanceConversationToNode({
        conversationId: state.id,
        empresaId: state.empresa_id,
        flowCode: state.flow_code,
        nextNodeCode: ptrResolved.effectiveNodeCode,
      });
      if (!advPtr.ok) return { ok: false, error: advPtr.error ?? "advance_failed" };
      await insertFlowEvent({
        empresaId: state.empresa_id,
        conversationId: state.id,
        flowCode: state.flow_code,
        nodeCode: ptrResolved.effectiveNodeCode,
        flowSessionId: sidGate,
        eventType: "flow_completeness_pointer_adjusted",
        payload: {
          from_node: state.flow_current_node,
          next_node_code: ptrResolved.effectiveNodeCode,
          reason: "missing_capture_before_current_step",
        },
      });
      return sendCurrentFlowNode({ ...params, __autoHop: currentHop });
    }

    const flowVarsBase = await getConversationFlowDataMap({
      empresaId: state.empresa_id,
      conversationId: state.id,
      flowCode: state.flow_code,
      flowSessionId: state.active_flow_session_id,
      traceReadContext: "send_current_node_confirmacion_resumen",
    });
    const flowVars = { ...flowVarsBase, ...(params.mergeFlowVars ?? {}) };
    const sumV = summarizeFlowDataForTrace(flowVars);
    flowTrace("send_node_interpolate", {
      conversation_id: state.id,
      empresa_id: state.empresa_id,
      flow_code: state.flow_code,
      flow_current_node: state.flow_current_node,
      active_flow_session_id: state.active_flow_session_id ?? null,
      flow_session_id_used_for_vars: state.active_flow_session_id ?? null,
      event: "confirmacion_o_resumen_mensaje",
      merge_flow_var_keys: params.mergeFlowVars ? Object.keys(params.mergeFlowVars).sort() : [],
      flow_data_keys: sumV.keys,
      flow_data_samples: sumV.samples ?? null,
    });
    const fallbackText = interpolateTemplate(
      node.message_text?.trim() || "Continuemos con el flujo.",
      flowVars
    );
    const basePayload = {
      flow_code: state.flow_code,
      node_code: node.node_code,
      node_type: node.node_type,
    };
    const blocks = await getNodeBlocks(node);

    // Compatibilidad: si el nodo aún no tiene bloques, mantiene comportamiento legacy.
    if (blocks.length === 0) {
      const bodyText =
        node.node_type === "buttons" || node.node_type === "list"
          ? params.suppressPlainTextBody
            ? SORTEO_TICKET_DEFAULT_STUB
            : fallbackText
          : fallbackText;
      if (node.node_type === "buttons" || node.node_type === "list") {
        if (ctxSend.provider !== "meta") {
          return {
            ok: false,
            error: ycloudOutboundUnsupportedMessage("botones interactivos"),
          };
        }
        const options = await getNodeOptions(node.id);
        console.info("[flow-options]", "choices_legacy_no_blocks", {
          conversation_id: state.id,
          node_code: node.node_code,
          node_type: node.node_type,
          option_count: options.length,
          resolved_titles: options.map((o) => ({
            meta_button_id: o.meta_button_id,
            title: whatsAppInteractiveTitleFromOption(o),
          })),
        });
        const useGroupedQuickReply =
          node.node_type === "buttons" && buttonQuickReplyGroupsEnabled(options);

        if (useGroupedQuickReply) {
          const defaultGt = params.suppressPlainTextBody
            ? SORTEO_TICKET_DEFAULT_STUB
            : fallbackText;
          const grouped = await emitGroupedQuickReplyButtonMessages({
            ctxSend,
            conversation: state,
            empresaId: state.empresa_id,
            flowCode: state.flow_code,
            nodeCode: node.node_code,
            options,
            defaultGroupTitle: defaultGt,
          });
          if (!grouped.ok) return { ok: false, error: grouped.error };
        } else {
          const send = await sendWhatsAppChoiceMessage({
            toDigits: ctxSend.toDigits,
            phoneNumberId: ctxSend.phoneNumberId,
            accessToken: ctxSend.token,
            bodyText,
            listMenuButtonText: "Ver opciones",
            buttons: options.map((o) => ({
              id: o.meta_button_id,
              title: whatsAppInteractiveTitleFromOption(o),
            })),
          });
          if (!send.ok) return { ok: false, error: send.error };

          await persistOutgoingMessage({
            conversation: state,
            content: bodyText,
            messageType: "interactive",
            waMessageId: send.waMessageId,
            raw: send.raw,
            senderType: "system",
            automationSource: "flow_engine",
            neuraInteractive: buildNeuraInteractiveFromOptions(bodyText, options),
          });
        }
      } else if (node.node_type === "media") {
        if (ctxSend.provider !== "meta") {
          return {
            ok: false,
            error: ycloudOutboundUnsupportedMessage("imagen"),
          };
        }
        const imageFromLegacyText = node.message_text?.trim() || "";
        if (!imageFromLegacyText) {
          return {
            ok: false,
            error: `Nodo media "${node.node_code}" sin imagen configurada en bloques ni mensaje legacy`,
          };
        }
        const send = await sendWhatsAppImage({
          toDigits: ctxSend.toDigits,
          phoneNumberId: ctxSend.phoneNumberId,
          accessToken: ctxSend.token,
          imageUrl: imageFromLegacyText,
        });
        if (!send.ok) {
          console.warn("[flow-send]", "whatsapp_image_failed_legacy_media_node", {
            conversationId: state.id,
            node_code: node.node_code,
            error: send.error,
          });
          return { ok: false, error: send.error };
        }

        await persistOutgoingMessage({
          conversation: state,
          content: `Imagen enviada\n${imageFromLegacyText}`,
          messageType: "image",
          waMessageId: send.waMessageId,
          raw: send.raw,
          senderType: "system",
          automationSource: "flow_engine",
        });
      } else {
        if (params.suppressPlainTextBody) {
          /* sorteo image_only: ticket enviado antes del nodo; sin texto largo */
        } else {
          const send = await flowSendText(ctxSend, bodyText);
          if (!send.ok) return { ok: false, error: send.error };

          await persistOutgoingMessage({
            conversation: state,
            content: bodyText,
            messageType: "text",
            waMessageId: send.waMessageId,
            raw: send.raw,
            senderType: "system",
            automationSource: "flow_engine",
          });
        }
      }

      if (node.node_type === "human") {
        console.info("[flow-engine] takeover activated", {
          conversationId: state.id,
          nodeCode: node.node_code,
        });
        await supabase
          .from("chat_conversations")
          .update({
            flow_status: "human",
            human_taken_over: true,
            updated_at: new Date().toISOString(),
          })
          .eq("id", state.id);
      }

      await insertFlowEvent({
        empresaId: state.empresa_id,
        conversationId: state.id,
        flowCode: state.flow_code,
        nodeCode: node.node_code,
        flowSessionId: state.active_flow_session_id,
        eventType: "node_sent",
        payload: { ...basePayload, legacy: true },
      });

      const chainedLegacy = await autoChainOutboundIfApplicable(
        state,
        node,
        currentHop,
        params.mergeFlowVars
      );
      if (chainedLegacy) return chainedLegacy;
      await maybeCompleteSorteoFinalSession(state, node);
      return { ok: true, nodeCode: node.node_code };
    }

    const options = await getNodeOptions(node.id);
    const groupsMode =
      node.node_type === "buttons" && buttonQuickReplyGroupsEnabled(options);
    const defaultGroupTitlePartition = params.suppressPlainTextBody
      ? SORTEO_TICKET_DEFAULT_STUB
      : fallbackText;
    let groupedButtonsEmitted = false;

    console.info("[flow-options]", "buttons_with_blocks_context", {
      conversation_id: state.id,
      node_code: node.node_code,
      block_count: blocks.length,
      resolved_titles: options.map((o) => ({
        meta_button_id: o.meta_button_id,
        title: whatsAppInteractiveTitleFromOption(o),
      })),
    });
    for (const block of blocks) {
      if (block.block_type === "text") {
        if (params.suppressPlainTextBody) {
          continue;
        }
        const textRaw = block.content_text?.trim();
        const text = textRaw ? interpolateTemplate(textRaw, flowVars) : "";
        if (!text) continue;
        const send = await flowSendText(ctxSend, text);
        if (!send.ok) return { ok: false, error: send.error };
        await persistOutgoingMessage({
          conversation: state,
          content: text,
          messageType: "text",
          waMessageId: send.waMessageId,
          raw: send.raw,
          senderType: "system",
          automationSource: "flow_engine",
        });
        continue;
      }
      if (block.block_type === "image") {
        if (ctxSend.provider !== "meta") {
          return { ok: false, error: ycloudOutboundUnsupportedMessage("imagen") };
        }
        const imageUrl = block.media_url?.trim();
        if (!imageUrl) continue;
        const captionRaw = block.content_text?.trim() || "";
        const caption = captionRaw ? interpolateTemplate(captionRaw, flowVars) : undefined;
        const send = await sendWhatsAppImage({
          toDigits: ctxSend.toDigits,
          phoneNumberId: ctxSend.phoneNumberId,
          accessToken: ctxSend.token,
          imageUrl,
          caption,
        });
        if (!send.ok) {
          console.warn("[flow-send]", "whatsapp_image_failed_block", {
            conversationId: state.id,
            node_code: node.node_code,
            error: send.error,
            imageUrlPreview: imageUrl.slice(0, 96),
          });
          return { ok: false, error: send.error };
        }
        const imageLabel = caption ? `Imagen enviada: ${caption}` : "Imagen enviada";
        await persistOutgoingMessage({
          conversation: state,
          content: `${imageLabel}\n${imageUrl}`,
          messageType: "image",
          waMessageId: send.waMessageId,
          raw: send.raw,
          senderType: "system",
          automationSource: "flow_engine",
        });
        continue;
      }
      if (block.block_type === "buttons") {
        if (ctxSend.provider !== "meta") {
          return { ok: false, error: ycloudOutboundUnsupportedMessage("botones interactivos") };
        }
        const bodyTextRaw = block.content_text?.trim() || fallbackText;
        const bodyText = params.suppressPlainTextBody
          ? SORTEO_TICKET_DEFAULT_STUB
          : interpolateTemplate(bodyTextRaw, flowVars);
        console.info("[flow-options]", "choices_block_buttons", {
          conversation_id: state.id,
          node_code: node.node_code,
          option_count: options.length,
          resolved_titles: options.map((o) => ({
            meta_button_id: o.meta_button_id,
            title: whatsAppInteractiveTitleFromOption(o),
          })),
        });

        if (groupsMode) {
          if (!groupedButtonsEmitted) {
            const grouped = await emitGroupedQuickReplyButtonMessages({
              ctxSend,
              conversation: state,
              empresaId: state.empresa_id,
              flowCode: state.flow_code,
              nodeCode: node.node_code,
              options,
              defaultGroupTitle: defaultGroupTitlePartition,
            });
            if (!grouped.ok) return { ok: false, error: grouped.error };
            groupedButtonsEmitted = true;
          }
          continue;
        }

        const send = await sendWhatsAppChoiceMessage({
          toDigits: ctxSend.toDigits,
          phoneNumberId: ctxSend.phoneNumberId,
          accessToken: ctxSend.token,
          bodyText,
          listMenuButtonText: "Ver opciones",
          buttons: options.map((o) => ({
            id: o.meta_button_id,
            title: whatsAppInteractiveTitleFromOption(o),
          })),
        });
        if (!send.ok) return { ok: false, error: send.error };
        await persistOutgoingMessage({
          conversation: state,
          content: bodyText,
          messageType: "interactive",
          waMessageId: send.waMessageId,
          raw: send.raw,
          senderType: "system",
          automationSource: "flow_engine",
          neuraInteractive: buildNeuraInteractiveFromOptions(bodyText, options),
        });
      }
    }

    if (groupsMode && !groupedButtonsEmitted) {
      if (ctxSend.provider !== "meta") {
        return { ok: false, error: ycloudOutboundUnsupportedMessage("botones interactivos") };
      }
      const groupedFallback = await emitGroupedQuickReplyButtonMessages({
        ctxSend,
        conversation: state,
        empresaId: state.empresa_id,
        flowCode: state.flow_code,
        nodeCode: node.node_code,
        options,
        defaultGroupTitle: defaultGroupTitlePartition,
      });
      if (!groupedFallback.ok) return { ok: false, error: groupedFallback.error };
    }

    if (node.node_type === "human") {
      console.info("[flow-engine] takeover activated", {
        conversationId: state.id,
        nodeCode: node.node_code,
      });
      await supabase
        .from("chat_conversations")
        .update({
          flow_status: "human",
          human_taken_over: true,
          updated_at: new Date().toISOString(),
        })
        .eq("id", state.id);
    }

    await insertFlowEvent({
      empresaId: state.empresa_id,
      conversationId: state.id,
      flowCode: state.flow_code,
      nodeCode: node.node_code,
      flowSessionId: state.active_flow_session_id,
      eventType: "node_sent",
      payload: { ...basePayload, blocks: blocks.length },
    });

    const chained = await autoChainOutboundIfApplicable(
      state,
      node,
      currentHop,
      params.mergeFlowVars
    );
    if (chained) return chained;
    await maybeCompleteSorteoFinalSession(state, node);
    return { ok: true, nodeCode: node.node_code };
  }

  async function processInteractiveReply(
    params: ProcessInteractiveReplyParams
  ): Promise<{ ok: boolean; status: string; nextNodeCode?: string; error?: string }> {
    console.info("[flow-engine] button received", {
      conversationId: params.conversationId,
      empresaId: params.empresaId,
      metaButtonId: params.metaButtonId,
    });
    const state = await getConversationFlowState(params.conversationId);
    if (!state || state.empresa_id !== params.empresaId) {
      return { ok: false, status: "conversation_not_found", error: "Conversación no encontrada" };
    }
    if (!isConversationInBotAutomationMode(state)) {
      await insertFlowEvent({
        empresaId: state.empresa_id,
        conversationId: state.id,
        flowCode: state.flow_code,
        nodeCode: state.flow_current_node,
        flowSessionId: state.active_flow_session_id,
        eventType: "ignored_interactive_reply",
        metaButtonId: params.metaButtonId,
        payload: { reason: "conversation_not_in_bot_mode", raw: params.rawPayload },
      });
      return { ok: true, status: "ignored_not_bot_mode" };
    }
    if (!state.flow_code || !state.flow_current_node) {
      await insertFlowEvent({
        empresaId: state.empresa_id,
        conversationId: state.id,
        flowSessionId: state.active_flow_session_id,
        eventType: "invalid_button",
        metaButtonId: params.metaButtonId,
        payload: { reason: "missing_flow_state", raw: params.rawPayload },
      });
      return { ok: true, status: "missing_flow_state" };
    }

    const currentNodePre = await getNode(
      state.empresa_id,
      state.flow_code,
      state.flow_current_node
    );
    if (
      currentNodePre?.node_type === "image_input" &&
      (params.metaButtonId === COMPROBANTE_BUTTON_IDS.enviar_otro ||
        params.metaButtonId === COMPROBANTE_BUTTON_IDS.hablar_asesor)
    ) {
      const sendCtxCv = await getConversationSendContext(state.id);
      const { data: chCfg } = await supabase
        .from("chat_channels")
        .select("config")
        .eq("id", state.channel_id)
        .maybeSingle();
      const cvMsgs = parseComprobanteValidationConfig(chCfg?.config).messages;
      if (params.metaButtonId === COMPROBANTE_BUTTON_IDS.enviar_otro) {
        const hint =
          "Podés enviar otro comprobante ahora como imagen o PDF en este mismo chat.";
        const send = await flowSendText(sendCtxCv, hint);
        if (send.ok) {
          await persistOutgoingMessage({
            conversation: state,
            content: hint,
            messageType: "text",
            waMessageId: send.waMessageId,
            raw: send.raw,
            senderType: "system",
            automationSource: "flow_engine",
          });
        }
        await insertFlowEvent({
          empresaId: state.empresa_id,
          conversationId: state.id,
          flowCode: state.flow_code,
          nodeCode: state.flow_current_node,
          flowSessionId: state.active_flow_session_id,
          eventType: "comprobante_validation_retry",
          metaButtonId: params.metaButtonId,
          payload: { raw: params.rawPayload },
        });
        return { ok: true, status: "comprobante_retry_hint" };
      }
      await supabase
        .from("chat_conversations")
        .update({
          flow_status: "human",
          human_taken_over: true,
          updated_at: new Date().toISOString(),
        })
        .eq("id", state.id);
      const handoff =
        "Te derivamos con un asesor humano. En breve te vamos a escribir desde este mismo número.";
      const sendH = await flowSendText(sendCtxCv, handoff);
      if (sendH.ok) {
        await persistOutgoingMessage({
          conversation: state,
          content: handoff,
          messageType: "text",
          waMessageId: sendH.waMessageId,
          raw: sendH.raw,
          senderType: "system",
          automationSource: "flow_engine",
        });
      }
      await insertFlowEvent({
        empresaId: state.empresa_id,
        conversationId: state.id,
        flowCode: state.flow_code,
        nodeCode: state.flow_current_node,
        flowSessionId: state.active_flow_session_id,
        eventType: "comprobante_validation_asesor",
        metaButtonId: params.metaButtonId,
        payload: { raw: params.rawPayload, message_template: cvMsgs.revision_manual },
      });
      return { ok: true, status: "comprobante_asesor_handoff" };
    }

    const currentNode = await getNode(
      state.empresa_id,
      state.flow_code,
      state.flow_current_node
    );
    console.info("[flow-engine] current node", {
      conversationId: state.id,
      flowCode: state.flow_code,
      nodeCode: state.flow_current_node,
    });
    if (!currentNode) {
      await insertFlowEvent({
        empresaId: state.empresa_id,
        conversationId: state.id,
        flowCode: state.flow_code,
        nodeCode: state.flow_current_node,
        flowSessionId: state.active_flow_session_id,
        eventType: "invalid_button",
        metaButtonId: params.metaButtonId,
        payload: { reason: "current_node_not_found", raw: params.rawPayload },
      });
      return { ok: true, status: "current_node_not_found" };
    }

    const options = await getNodeOptions(currentNode.id);
    const selected = resolveSelectedFlowOption(options, params.metaButtonId, params.rawPayload);
    if (!selected) {
      const purchaseIntent = interactiveReplyMatchesPurchaseIntent(params.rawPayload);
      await insertFlowEvent({
        empresaId: state.empresa_id,
        conversationId: state.id,
        flowCode: state.flow_code,
        nodeCode: currentNode.node_code,
        flowSessionId: state.active_flow_session_id,
        eventType: purchaseIntent ? "invalid_button_purchase_intent" : "invalid_button",
        metaButtonId: params.metaButtonId,
        payload: {
          reason: "option_not_found_in_node",
          purchase_intent: purchaseIntent,
          raw: params.rawPayload,
        },
      });
      // Botón de "comprar de nuevo" que NO es opción del nodo actual (p. ej. en compra_realizada):
      // señalamos al webhook que inicie una compra nueva en vez de quedar como botón inválido.
      return {
        ok: true,
        status: purchaseIntent ? "invalid_button_restart_intent" : "invalid_button",
      };
    }

    if (currentNode.node_type === "buttons" && buttonQuickReplyGroupsEnabled(options)) {
      const schemaGs = await fetchDataSchemaForEmpresaId(state.empresa_id);
      const gt = (selected.group_title ?? "").trim();
      console.info("[flow-buttons-groups][option-selected]", {
        schema: schemaGs,
        empresa_id: state.empresa_id,
        flow_code: state.flow_code,
        node_code: currentNode.node_code,
        conversation_id: state.id,
        group_title: gt || null,
        group_order: selected.group_order ?? 0,
        option_row_suffix: String(selected.id).replace(/-/g, "").slice(-8),
      });
    }

    const flowSidInteractive = state.active_flow_session_id?.trim();
    if (!flowSidInteractive) {
      return {
        ok: false,
        status: "missing_flow_session",
        error: "Sesión de flujo no inicializada; escribí hola para reiniciar.",
      };
    }

    {
      const schemaTag = await fetchDataSchemaForEmpresaId(state.empresa_id);
      const received = params.metaButtonId.trim();
      const foundByRowId = options.some((o) => String(o.id ?? "").trim() === received);
      const foundByMeta = options.some((o) => String(o.meta_button_id ?? "").trim() === received);
      const foundByVal = options.some((o) => String(o.option_value ?? "").trim() === received);
      let foundByPayload = false;
      for (const o of options) {
        const pl = o.option_payload;
        if (!pl || typeof pl !== "object" || Array.isArray(pl)) continue;
        const p = pl as Record<string, unknown>;
        for (const k of ["opcion_id", "legacy_option_id", "button_id", "value"]) {
          if (String(p[k] ?? "").trim() === received) {
            foundByPayload = true;
            break;
          }
        }
        if (foundByPayload) break;
      }
      const { data: optRowProbe } = await supabase
        .from("chat_flow_options")
        .select("id")
        .eq("id", selected.id)
        .maybeSingle();
      console.info("[flow-engine][selected-option-resolution]", {
        schema: schemaTag,
        empresa_id: state.empresa_id,
        conversation_id: state.id,
        session_id: flowSidInteractive,
        flow_code: state.flow_code,
        session_flow_code: state.flow_code,
        current_node_id: currentNode.id,
        current_node_code: currentNode.node_code,
        received_option_id: received,
        option_found_by_id: foundByRowId,
        option_found_by_meta_button_id: foundByMeta,
        option_found_by_option_value: foundByVal,
        option_found_by_payload: foundByPayload,
        option_found_in_current_node: options.some((o) => o.id === selected.id),
        resolved_selected_id: selected.id,
        option_row_visible_to_client: Boolean(optRowProbe),
        fallback_option_id_used: null,
        reason: "presubmit_interactive_resolve",
      });
    }

    await insertFlowEvent({
      empresaId: state.empresa_id,
      conversationId: state.id,
      flowCode: state.flow_code,
      nodeCode: currentNode.node_code,
      flowSessionId: flowSidInteractive,
      eventType: "button_selected",
      selectedOptionId: selected.id,
      metaButtonId: params.metaButtonId,
      payload: {
        option_value: selected.option_value,
        option_label: selected.label,
        option_payload: selected.option_payload ?? {},
        raw: params.rawPayload,
      },
    });

    const sorteoLinked = await getSorteoIdForChatFlow(
      supabase,
      state.empresa_id,
      state.flow_code as string
    );
    /** Cierre de compra sorteo: no escribir en chat_flow_data ni re-ejecutar contrato comercial (evita pisar snapshots con el label del botón, ej. "Confirmado"). */
    const isSorteoFinalizeClick =
      Boolean(sorteoLinked) && optionPayloadFinalizesSorteoOrder(selected.option_payload);

    const optionPayload =
      selected.option_payload && typeof selected.option_payload === "object"
        ? selected.option_payload
        : {};
    let payloadEntries: [string, string][] = [];

    if (!isSorteoFinalizeClick) {
      payloadEntries = Object.entries(optionPayload)
        .filter(([key]) => key.trim().length > 0)
        .map(([k, v]) => [
          k,
          typeof v === "string" || typeof v === "number" || typeof v === "boolean"
            ? String(v)
            : JSON.stringify(v ?? ""),
        ]);
      if (!payloadEntries.some(([k]) => k === "opcion_label")) {
        const rawPl =
          selected.option_payload && typeof selected.option_payload === "object"
            ? (selected.option_payload as Record<string, unknown>)
            : {};
        const fromPayload =
          typeof rawPl.opcion_label === "string" && rawPl.opcion_label.trim()
            ? rawPl.opcion_label.trim()
            : "";
        /** Legacy: sin `opcion_label` en payload, placeholders usan el texto visible (`label`). */
        const fallback = (selected.label ?? "").trim();
        payloadEntries.push(["opcion_label", fromPayload || fallback]);
      }
      payloadEntries = augmentCantidadFromInteractiveOption(payloadEntries, selected);
      payloadEntries = augmentSorteoPricingFromInteractiveOption(payloadEntries);
      payloadEntries = dedupeChatFlowFieldEntries(payloadEntries);
      payloadEntries = applySorteoInteractiveCommercialContract(payloadEntries, {
        label: selected.label,
        option_value: selected.option_value,
        option_payload: selected.option_payload,
      });
    }

    if (payloadEntries.length > 0 && state.flow_code) {
      const upserts = payloadEntries.map(([fieldName, fieldValue]) => ({
        empresa_id: state.empresa_id,
        conversation_id: state.id,
        flow_code: state.flow_code as string,
        flow_session_id: flowSidInteractive,
        field_name: fieldName.trim(),
        field_value:
          typeof fieldValue === "string" || typeof fieldValue === "number" || typeof fieldValue === "boolean"
            ? String(fieldValue)
            : JSON.stringify(fieldValue ?? ""),
      }));
      const { error: payloadSaveErr } = await supabase
        .from("chat_flow_data")
        .upsert(upserts, { onConflict: "flow_session_id,field_name" });
      if (payloadSaveErr) {
        return { ok: false, status: "save_option_payload_failed", error: payloadSaveErr.message };
      }
      const qtyFromSave = readSorteoCantidadNumericFromMap(
        Object.fromEntries(payloadEntries.map(([k, v]) => [k, String(v)]))
      );
      if (qtyFromSave != null) {
        console.info("[sorteo-quantity][saved-from-option]", {
          empresa_id: state.empresa_id,
          conversation_id: state.id,
          flow_session_id: flowSidInteractive,
          current_node_code: currentNode.node_code,
          selected_option_id: selected.id,
          option_label: String(selected.label ?? "").slice(0, 120),
          cantidad_detected: qtyFromSave,
          source: "option_payload",
        });
      }
      flowTrace("flow_data_write", {
        conversation_id: state.id,
        empresa_id: state.empresa_id,
        flow_code: state.flow_code,
        flow_session_id_write: flowSidInteractive,
        node_code: currentNode.node_code,
        event: "interactive_option_payload",
        field_names: payloadEntries.map(([k]) => k.trim()).filter(Boolean),
      });
    }

    let sorteoOrderMerge: Record<string, string> | undefined;
    let sorteoTicketPackage: {
      fin: EnsureSorteoOrderCreatedData;
      flowData: Record<string, string>;
    } | null = null;
    /** Paquete armado desde sorteo_entrada_id en flow_data (orden ya persistida; botón no es finalize). */
    let sorteoTicketFromExistingFlowData = false;
    const wantsSorteoFinalize = isSorteoFinalizeClick;

    if (wantsSorteoFinalize) {
      const rawFd = await getConversationFlowDataMap({
        empresaId: state.empresa_id,
        conversationId: state.id,
        flowCode: state.flow_code,
        flowSessionId: flowSidInteractive,
        traceReadContext: "before_finalize_sorteo_on_confirm",
      });
      const hydFd = await hydrateFlowDataFromSessionEvents(
        state.id,
        state.flow_code as string,
        rawFd,
        flowSidInteractive
      );
      const sendCtxFin = await getConversationSendContext(state.id);

      const notifyFinalizeError = async (text: string) => {
        const send = await flowSendText(sendCtxFin, text);
        if (send.ok) {
          await persistOutgoingMessage({
            conversation: state,
            content: text,
            messageType: "text",
            waMessageId: send.waMessageId,
            raw: send.raw,
            senderType: "system",
            automationSource: "flow_engine",
          });
        }
      };

      const closePolicyFin = await getFlowClosePurchasePolicy(
        supabase,
        state.empresa_id,
        state.flow_code as string
      );
      const schemaEligFin = await fetchDataSchemaForEmpresaId(state.empresa_id);
      const eligFin = await canCloseSorteoPurchase({
        supabase,
        empresaId: state.empresa_id,
        flowCode: state.flow_code as string,
        flowData: hydFd,
        currentNodeCode: currentNode.node_code,
        selectedOption: selected,
        closePurchaseOnlyOnFinalConfirmation: closePolicyFin.closePurchaseOnlyOnFinalConfirmation,
        interaction: { kind: "explicit_finalize" },
      });
      console.info("[sorteo-close][eligibility]", {
        schema: schemaEligFin,
        empresa_id: state.empresa_id,
        flow_code: state.flow_code,
        conversation_id: state.id,
        flow_session_id: flowSidInteractive,
        current_node_code: currentNode.node_code,
        canClose: eligFin.canClose,
        reason: eligFin.reason,
        hasValidation: eligFin.hasValidation,
        hasCantidad: eligFin.hasCantidad,
        participantComplete: eligFin.participantComplete,
        finalConfirmationDetected: eligFin.finalConfirmationDetected,
      });
      if (!eligFin.canClose) {
        let detailBlocked: string;
        if (eligFin.reason === "comprobante_no_valido") {
          detailBlocked = await mensajeClienteComprobanteNoValido(
            supabase,
            state.id,
            String((hydFd as Record<string, string>)[SORTEO_COMPROBANTE_ESTADO_VALIDACION_FIELD] ?? ""),
            String(
              (hydFd as Record<string, string>)[SORTEO_COMPROBANTE_MOTIVO_VALIDACION_FIELD] ?? ""
            ).trim() || undefined
          );
        } else if (eligFin.reason === "no_llego_a_confirmacion_final") {
          detailBlocked =
            "Para registrar tu compra, tocá Confirmado en el resumen cuando los datos estén correctos.";
        } else if (eligFin.reason === "flujo_no_es_sorteo") {
          detailBlocked = "Este flujo no está vinculado a un sorteo.";
        } else {
          detailBlocked = await getSorteoDatosIncompletosMessage(
            supabase,
            state.empresa_id,
            state.flow_code as string
          );
        }
        console.info("[sorteo-close][blocked-before-final-confirmation]", {
          schema: schemaEligFin,
          empresa_id: state.empresa_id,
          flow_code: state.flow_code,
          conversation_id: state.id,
          flow_session_id: flowSidInteractive,
          current_node_code: currentNode.node_code,
          reason: eligFin.reason,
        });
        await notifyFinalizeError(detailBlocked);
        return { ok: false, status: "sorteo_finalize_blocked", error: detailBlocked };
      }
      console.info("[sorteo-close][final-confirmation-ok]", {
        schema: schemaEligFin,
        empresa_id: state.empresa_id,
        flow_code: state.flow_code,
        conversation_id: state.id,
        flow_session_id: flowSidInteractive,
        current_node_code: currentNode.node_code,
      });

      const fin = await finalizeSorteoOrderFromConfirmedFlowData(supabase, {
        empresaId: state.empresa_id,
        conversationId: state.id,
        flowCode: state.flow_code as string,
        flowSessionId: flowSidInteractive,
        whatsappNumero: sendCtxFin.toDigits,
        flowData: hydFd,
      });

      if (!fin.ok) {
        await notifyFinalizeError(fin.message);
        return { ok: false, status: "sorteo_finalize_failed", error: fin.message };
      }
      if (fin.skipped) {
        let detail: string;
        if (fin.reason === "sin_comprobante_en_sesion") {
          detail =
            "No encontramos el comprobante de esta compra. Enviá la imagen del comprobante y volvé a confirmar.";
        } else if (fin.reason === "flow_sin_sorteo_id") {
          detail = "Este flujo no está vinculado a un sorteo.";
        } else if (fin.reason === "datos_flujo_incompletos") {
          detail = await getSorteoDatosIncompletosMessage(
            supabase,
            state.empresa_id,
            state.flow_code as string
          );
        } else if (fin.reason === "comprobante_no_validado") {
          detail = await mensajeClienteComprobanteNoValido(
            supabase,
            state.id,
            typeof fin.comprobanteEstado === "string" ? fin.comprobanteEstado : "",
            typeof fin.comprobanteMotivo === "string" ? fin.comprobanteMotivo : undefined
          );
        } else {
          detail = await getSorteoDatosIncompletosMessage(
            supabase,
            state.empresa_id,
            state.flow_code as string
          );
        }
        await notifyFinalizeError(detail);
        return { ok: false, status: "sorteo_finalize_skipped", error: detail };
      }

      sorteoOrderMerge = buildSorteoOrderFlowVarOverrides(fin);
      const ctxRows = buildChatFlowDataUpsertsForSorteoOrder(
        state.empresa_id,
        state.id,
        state.flow_code as string,
        flowSidInteractive,
        fin
      );
      const { error: ctxErr } = await supabase
        .from("chat_flow_data")
        .upsert(ctxRows, { onConflict: "flow_session_id,field_name" });
      if (ctxErr) {
        await notifyFinalizeError("No se pudo guardar el resultado de la compra. Intentá confirmar de nuevo.");
        return { ok: false, status: "sorteo_context_after_finalize_failed", error: ctxErr.message };
      }
      await insertFlowEvent({
        empresaId: state.empresa_id,
        conversationId: state.id,
        flowCode: state.flow_code,
        nodeCode: currentNode.node_code,
        flowSessionId: flowSidInteractive,
        eventType: "sorteo_order_ensured",
        selectedOptionId: selected.id,
        metaButtonId: params.metaButtonId,
        payload: {
          idempotent: fin.idempotent,
          entrada_id: fin.entradaId,
          numero_orden: fin.numeroOrden,
          cantidad_boletos: fin.cantidadBoletos,
          monto_total: fin.montoTotal,
          precio_fuente: fin.precioFuente,
          promo_nombre: fin.promoNombre,
          sorteo_id: fin.sorteoId,
          sorteo_nombre: fin.sorteoNombre,
          cupones: fin.cupones.map((c) => c.numero_cupon),
          trigger: "confirmacion_final",
        },
      });
      const hydFdRec = hydFd as Record<string, string>;
      const hadManualPending =
        (hydFdRec[FLOW_SORTEO_PENDIENTE_DATOS_PARTICIPANTE_FIELD] ?? "").trim() === "si";
      if (hadManualPending) {
        console.info("[sorteo-manual-approval][completed-after-data]", {
          conversation_id: state.id,
          flow_session_id: flowSidInteractive,
          entrada_id: fin.entradaId,
          numero_orden: fin.numeroOrden,
        });
        await insertFlowEvent({
          empresaId: state.empresa_id,
          conversationId: state.id,
          flowCode: state.flow_code,
          nodeCode: currentNode.node_code,
          flowSessionId: flowSidInteractive,
          eventType: "sorteo_manual_approval_completed_after_data",
          payload: {
            entrada_id: fin.entradaId,
            numero_orden: fin.numeroOrden,
            validation_id: (hydFdRec[SORTEO_COMPROBANTE_VALIDACION_ID_FIELD] ?? "").trim() || null,
          },
        });
        await supabase.from("chat_flow_data").upsert(
          {
            empresa_id: state.empresa_id,
            conversation_id: state.id,
            flow_code: state.flow_code as string,
            flow_session_id: flowSidInteractive,
            field_name: FLOW_SORTEO_PENDIENTE_DATOS_PARTICIPANTE_FIELD,
            field_value: "no",
          },
          { onConflict: "flow_session_id,field_name" }
        );
      }
      sorteoTicketPackage = { fin, flowData: hydFd };
    }

    /**
     * Orden ya creada en DB y variables en chat_flow_data, pero el botón actual no tiene
     * confirmar_orden_sorteo (solo avanza al nodo final). Misma lógica de ticket que finalize.
     */
    if (!wantsSorteoFinalize && sorteoLinked && flowSidInteractive && !sorteoTicketPackage) {
      try {
        const rawFdEx = await getConversationFlowDataMap({
          empresaId: state.empresa_id,
          conversationId: state.id,
          flowCode: state.flow_code,
          flowSessionId: flowSidInteractive,
          traceReadContext: "existing_order_ticket_hook",
        });
        const hydFdEx = await hydrateFlowDataFromSessionEvents(
          state.id,
          state.flow_code as string,
          rawFdEx,
          flowSidInteractive
        );
        const F = CHAT_FLOW_SORTEO_CONTEXT_FIELDS;
        const entradaRaw = (hydFdEx[F.sorteo_entrada_id] ?? hydFdEx.sorteo_entrada_id ?? "").trim();
        if (entradaRaw && /^[0-9a-f-]{36}$/i.test(entradaRaw)) {
          const orderFromDb = await buildOrderResultFromEntradaId(supabase, entradaRaw, state.empresa_id);
          if (orderFromDb && orderFromDb.sorteoId === sorteoLinked) {
            console.info("[sorteo-ticket] post_node_existing_order_detected", {
              conversationId: state.id,
              entradaId: `${entradaRaw.slice(0, 8)}…`,
              sorteoId: orderFromDb.sorteoId,
            });
            sorteoTicketPackage = { fin: orderFromDb, flowData: hydFdEx };
            sorteoTicketFromExistingFlowData = true;
          } else {
            console.info("[sorteo-ticket] post_node_existing_order_skipped", {
              reason: orderFromDb ? "sorteo_id_mismatch" : "entrada_not_found",
              conversationId: state.id,
            });
          }
        } else {
          console.info("[sorteo-ticket] post_node_existing_order_skipped", {
            reason: "no_sorteo_entrada_id_in_flow_data",
            conversationId: state.id,
          });
        }
      } catch (e) {
        console.error("[sorteo-ticket] post_node_existing_order_error", {
          conversationId: state.id,
          err: e instanceof Error ? e.message : String(e),
        });
      }
    }

    /**
     * Muchos flujos usan un botón "Confirmado" sin `confirmar_orden_sorteo` que solo avanza al nodo
     * `compra_realizada`. Sin ejecutar finalize aquí, el mensaje final sale con placeholders vacíos.
     */
    if (
      !wantsSorteoFinalize &&
      sorteoLinked &&
      flowSidInteractive &&
      selected.next_node_code?.trim() &&
      !sorteoTicketPackage
    ) {
      const nextCodeProbe = selected.next_node_code.trim();
      const nextNodeProbeLazy = await getNode(
        state.empresa_id,
        state.flow_code as string,
        nextCodeProbe
      );
      const isLazyFinalTarget = isSorteoFinalTicketNode(nextCodeProbe, {
        nodeMessageTemplate: nextNodeProbeLazy?.message_text ?? null,
      });
      const Flazy = CHAT_FLOW_SORTEO_CONTEXT_FIELDS;
      const rawFdLazy = await getConversationFlowDataMap({
        empresaId: state.empresa_id,
        conversationId: state.id,
        flowCode: state.flow_code,
        flowSessionId: flowSidInteractive,
        traceReadContext: "lazy_finalize_probe",
      });
      const hydFdLazy = await hydrateFlowDataFromSessionEvents(
        state.id,
        state.flow_code as string,
        rawFdLazy,
        flowSidInteractive
      );
      const hasEntradaLazy = Boolean(
        String((hydFdLazy as Record<string, string>)[Flazy.sorteo_entrada_id] ?? "").trim()
      );
      if (isLazyFinalTarget && !hasEntradaLazy) {
        const schemaClose = await fetchDataSchemaForEmpresaId(state.empresa_id);
        const sendCtxLazy = await getConversationSendContext(state.id);
        const notifyLazyErr = async (text: string) => {
          const send = await flowSendText(sendCtxLazy, text);
          if (send.ok) {
            await persistOutgoingMessage({
              conversation: state,
              content: text,
              messageType: "text",
              waMessageId: send.waMessageId,
              raw: send.raw,
              senderType: "system",
              automationSource: "flow_engine",
            });
          }
        };

        const lazyClosePolicy = await getFlowClosePurchasePolicy(
          supabase,
          state.empresa_id,
          state.flow_code as string
        );
        if (lazyClosePolicy.closePurchaseOnlyOnFinalConfirmation) {
          const eligLazy = await canCloseSorteoPurchase({
            supabase,
            empresaId: state.empresa_id,
            flowCode: state.flow_code as string,
            flowData: hydFdLazy as Record<string, string>,
            currentNodeCode: currentNode.node_code,
            selectedOption: selected,
            closePurchaseOnlyOnFinalConfirmation: true,
            interaction: {
              kind: "lazy_finalize",
              nextNodeCode: nextCodeProbe,
              nextNodeMessageTemplate: nextNodeProbeLazy?.message_text ?? null,
              selectedLabel: String(selected.label ?? ""),
            },
          });
          console.info("[sorteo-close][eligibility]", {
            schema: schemaClose,
            empresa_id: state.empresa_id,
            flow_code: state.flow_code,
            conversation_id: state.id,
            flow_session_id: flowSidInteractive,
            current_node_code: currentNode.node_code,
            canClose: eligLazy.canClose,
            reason: eligLazy.reason,
            hasValidation: eligLazy.hasValidation,
            hasCantidad: eligLazy.hasCantidad,
            participantComplete: eligLazy.participantComplete,
            finalConfirmationDetected: eligLazy.finalConfirmationDetected,
          });
          if (!eligLazy.canClose) {
            let detailElig: string;
            if (eligLazy.reason === "comprobante_no_valido") {
              detailElig = await mensajeClienteComprobanteNoValido(
                supabase,
                state.id,
                String(
                  (hydFdLazy as Record<string, string>)[SORTEO_COMPROBANTE_ESTADO_VALIDACION_FIELD] ??
                    ""
                ),
                String(
                  (hydFdLazy as Record<string, string>)[SORTEO_COMPROBANTE_MOTIVO_VALIDACION_FIELD] ?? ""
                ).trim() || undefined
              );
            } else if (eligLazy.reason === "no_llego_a_confirmacion_final") {
              detailElig =
                "Para registrar tu compra, tocá Confirmado en el resumen cuando los datos estén correctos.";
            } else if (eligLazy.reason === "flujo_no_es_sorteo") {
              detailElig = "Este flujo no está vinculado a un sorteo.";
            } else {
              detailElig = await getSorteoDatosIncompletosMessage(
                supabase,
                state.empresa_id,
                state.flow_code as string
              );
            }
            console.info("[sorteo-close][blocked-before-final-confirmation]", {
              schema: schemaClose,
              empresa_id: state.empresa_id,
              flow_code: state.flow_code,
              conversation_id: state.id,
              flow_session_id: flowSidInteractive,
              current_node_code: currentNode.node_code,
              reason: eligLazy.reason,
            });
            await notifyLazyErr(detailElig);
            return { ok: false, status: "sorteo_lazy_finalize_blocked", error: detailElig };
          }
          console.info("[sorteo-close][final-confirmation-ok]", {
            schema: schemaClose,
            empresa_id: state.empresa_id,
            flow_code: state.flow_code,
            conversation_id: state.id,
            flow_session_id: flowSidInteractive,
            current_node_code: currentNode.node_code,
          });
        }

        console.info("[sorteo-close][pre-finalize]", {
          schema: schemaClose,
          empresa_id: state.empresa_id,
          conversation_id: state.id,
          flow_session_id: flowSidInteractive,
          next_node_code: nextCodeProbe,
          trigger: "advance_to_final_without_finalize_payload",
        });
        const finLazy = await finalizeSorteoOrderFromConfirmedFlowData(supabase, {
          empresaId: state.empresa_id,
          conversationId: state.id,
          flowCode: state.flow_code as string,
          flowSessionId: flowSidInteractive,
          whatsappNumero: sendCtxLazy.toDigits,
          flowData: hydFdLazy as Record<string, string>,
        });
        const entradaSlice =
          finLazy.ok && !finLazy.skipped ? String(finLazy.entradaId).slice(0, 8) : "";
        console.info("[sorteo-close][order-result]", {
          schema: schemaClose,
          empresa_id: state.empresa_id,
          conversation_id: state.id,
          flow_session_id: flowSidInteractive,
          entrada_id_prefix: entradaSlice ? `${entradaSlice}…` : null,
          numero_orden_present: Boolean(
            finLazy.ok && !finLazy.skipped && finLazy.numeroOrden != null
          ),
          cupones_count:
            finLazy.ok && !finLazy.skipped ? (finLazy.cupones?.length ?? 0) : 0,
          skipped: finLazy.ok ? finLazy.skipped : undefined,
          reason: finLazy.ok && finLazy.skipped ? finLazy.reason : undefined,
        });
        if (!finLazy.ok) {
          console.info("[sorteo-close][prevent-empty-final-message]", {
            schema: schemaClose,
            conversation_id: state.id,
            phase: "finalize_failed",
          });
          await notifyLazyErr(finLazy.message);
          return { ok: false, status: "sorteo_lazy_finalize_failed", error: finLazy.message };
        }
        if (finLazy.skipped) {
          let detailLazy: string;
          if (finLazy.reason === "sin_comprobante_en_sesion") {
            detailLazy =
              "No encontramos el comprobante de esta compra. Enviá la imagen del comprobante y volvé a confirmar.";
          } else if (finLazy.reason === "flow_sin_sorteo_id") {
            detailLazy = "Este flujo no está vinculado a un sorteo.";
          } else if (finLazy.reason === "datos_flujo_incompletos") {
            detailLazy = await getSorteoDatosIncompletosMessage(
              supabase,
              state.empresa_id,
              state.flow_code as string
            );
          } else if (finLazy.reason === "comprobante_no_validado") {
            detailLazy = await mensajeClienteComprobanteNoValido(
              supabase,
              state.id,
              typeof finLazy.comprobanteEstado === "string" ? finLazy.comprobanteEstado : "",
              typeof finLazy.comprobanteMotivo === "string" ? finLazy.comprobanteMotivo : undefined
            );
          } else {
            detailLazy = await getSorteoDatosIncompletosMessage(
              supabase,
              state.empresa_id,
              state.flow_code as string
            );
          }
          console.info("[sorteo-close][prevent-empty-final-message]", {
            schema: schemaClose,
            conversation_id: state.id,
            phase: "finalize_skipped",
            reason: finLazy.reason,
          });
          await notifyLazyErr(detailLazy);
          return { ok: false, status: "sorteo_lazy_finalize_skipped", error: detailLazy };
        }

        sorteoOrderMerge = buildSorteoOrderFlowVarOverrides(finLazy);
        const ctxRowsLazy = buildChatFlowDataUpsertsForSorteoOrder(
          state.empresa_id,
          state.id,
          state.flow_code as string,
          flowSidInteractive,
          finLazy
        );
        const { error: ctxErrLazy } = await supabase
          .from("chat_flow_data")
          .upsert(ctxRowsLazy, { onConflict: "flow_session_id,field_name" });
        if (ctxErrLazy) {
          console.info("[sorteo-close][prevent-empty-final-message]", {
            schema: schemaClose,
            conversation_id: state.id,
            phase: "flow_data_upsert_failed",
          });
          await notifyLazyErr("No se pudo guardar el resultado de la compra. Intentá confirmar de nuevo.");
          return {
            ok: false,
            status: "sorteo_lazy_context_failed",
            error: ctxErrLazy.message,
          };
        }
        console.info("[sorteo-close][flow-data-upserted]", {
          schema: schemaClose,
          empresa_id: state.empresa_id,
          conversation_id: state.id,
          flow_session_id: flowSidInteractive,
        });
        await insertFlowEvent({
          empresaId: state.empresa_id,
          conversationId: state.id,
          flowCode: state.flow_code,
          nodeCode: currentNode.node_code,
          flowSessionId: flowSidInteractive,
          eventType: "sorteo_order_ensured",
          selectedOptionId: selected.id,
          metaButtonId: params.metaButtonId,
          payload: {
            idempotent: finLazy.idempotent,
            entrada_id: finLazy.entradaId,
            numero_orden: finLazy.numeroOrden,
            cantidad_boletos: finLazy.cantidadBoletos,
            monto_total: finLazy.montoTotal,
            precio_fuente: finLazy.precioFuente,
            promo_nombre: finLazy.promoNombre,
            sorteo_id: finLazy.sorteoId,
            sorteo_nombre: finLazy.sorteoNombre,
            cupones: finLazy.cupones.map((c) => c.numero_cupon),
            trigger: "lazy_before_final_template",
          },
        });
        const hydLazyRec = hydFdLazy as Record<string, string>;
        const hadManualPendingLazy =
          (hydLazyRec[FLOW_SORTEO_PENDIENTE_DATOS_PARTICIPANTE_FIELD] ?? "").trim() === "si";
        if (hadManualPendingLazy) {
          await insertFlowEvent({
            empresaId: state.empresa_id,
            conversationId: state.id,
            flowCode: state.flow_code,
            nodeCode: currentNode.node_code,
            flowSessionId: flowSidInteractive,
            eventType: "sorteo_manual_approval_completed_after_data",
            payload: {
              entrada_id: finLazy.entradaId,
              numero_orden: finLazy.numeroOrden,
              validation_id:
                (hydLazyRec[SORTEO_COMPROBANTE_VALIDACION_ID_FIELD] ?? "").trim() || null,
              trigger: "lazy_finalize",
            },
          });
          await supabase.from("chat_flow_data").upsert(
            {
              empresa_id: state.empresa_id,
              conversation_id: state.id,
              flow_code: state.flow_code as string,
              flow_session_id: flowSidInteractive,
              field_name: FLOW_SORTEO_PENDIENTE_DATOS_PARTICIPANTE_FIELD,
              field_value: "no",
            },
            { onConflict: "flow_session_id,field_name" }
          );
        }
        sorteoTicketPackage = { fin: finLazy, flowData: hydFdLazy as Record<string, string> };
        console.info("[sorteo-close][final-message-render]", {
          schema: schemaClose,
          conversation_id: state.id,
          flow_session_id: flowSidInteractive,
          merge_keys: Object.keys(sorteoOrderMerge ?? {}).slice(0, 12),
        });
      }
    }

    if (!selected.next_node_code) {
      await insertFlowEvent({
        empresaId: state.empresa_id,
        conversationId: state.id,
        flowCode: state.flow_code,
        nodeCode: currentNode.node_code,
        flowSessionId: flowSidInteractive,
        eventType: "node_advanced",
        selectedOptionId: selected.id,
        metaButtonId: params.metaButtonId,
        payload: { next_node_code: null },
      });
      if (sorteoOrderMerge && Object.keys(sorteoOrderMerge).length > 0) {
        const isFinalSummary = isSorteoFinalTicketNode(null, { flowEndedWithOrderSummary: true });
        let suppressSummary = false;
        let modeNoNext: SorteoTicketDeliveryMode = "text_only";

        if (sorteoTicketPackage && isFinalSummary) {
          modeNoNext = await getSorteoTicketDeliveryModeForSorteo({
            supabase,
            empresaId: state.empresa_id,
            sorteoId: sorteoTicketPackage.fin.sorteoId,
          });
          console.info("[sorteo-ticket] final_node_check", {
            conversationId: state.id,
            path: "no_next_node",
            isSorteoFinal: true,
            hasPackage: true,
            mode: modeNoNext,
          });
          console.info("[sorteo-ticket] final_node_existing_order_detected", {
            conversationId: state.id,
            sorteoId: sorteoTicketPackage.fin.sorteoId,
            entradaId: sorteoTicketPackage.fin.entradaId,
            path: "no_next_node",
          });
          if (modeNoNext === "text_only") {
            console.info("[sorteo-ticket] final_node_delivery_skipped", {
              reason: "text_only",
              path: "no_next_node",
            });
          } else if (modeNoNext === "image_only") {
            console.info("[sorteo-ticket] final_node_delivery_start", {
              conversationId: state.id,
              path: "no_next_node",
              phase: "before_summary_text",
              mode: modeNoNext,
            });
            const { delivery } = await runSorteoTicketAfterFinalNodeMessage({
              supabase,
              empresaId: state.empresa_id,
              conversationId: state.id,
              contactId: state.contact_id,
              channelId: state.channel_id,
              flowSessionId: flowSidInteractive,
              orderResult: sorteoTicketPackage.fin,
              flowData: sorteoTicketPackage.flowData,
            });
            suppressSummary = shouldSuppressSorteoFinalTextAfterImageOnlyTicket(delivery);
            if (delivery && !delivery.ok && !delivery.skipped) {
              console.error("[sorteo-ticket] final_node_delivery_error", {
                conversationId: state.id,
                path: "no_next_node",
                reason: delivery.reason ?? "unknown",
              });
            } else if (delivery?.skipped && delivery.reason && delivery.reason !== "already_sent") {
              console.info("[sorteo-ticket] final_node_delivery_skipped", {
                conversationId: state.id,
                path: "no_next_node",
                reason: delivery.reason,
              });
            } else if (delivery?.ok) {
              console.info("[sorteo-ticket] final_node_delivery_sent", {
                conversationId: state.id,
                path: "no_next_node",
                lastStatus: delivery.lastStatus,
                skipped: delivery.skipped,
              });
            }
          }
        } else if (sorteoTicketPackage) {
          console.info("[sorteo-ticket] final_node_check", {
            conversationId: state.id,
            path: "no_next_node",
            isSorteoFinal: false,
            hasPackage: true,
          });
          console.info("[sorteo-ticket] final_node_delivery_skipped", {
            reason: "not_final_node",
            path: "no_next_node",
          });
        }

        const sendCtxEnd = await getConversationSendContext(state.id);
        const no = sorteoOrderMerge.numero_orden ?? "";
        const cup = sorteoOrderMerge.numeros_cupon ?? "";
        const summary = `Listo. Tu orden Nº ${no}. Cupones: ${cup}.`;
        if (!suppressSummary) {
          const sendSum = await flowSendText(sendCtxEnd, summary);
          if (sendSum.ok) {
            await persistOutgoingMessage({
              conversation: state,
              content: summary,
              messageType: "text",
              waMessageId: sendSum.waMessageId,
              raw: sendSum.raw,
              senderType: "system",
              automationSource: "flow_engine",
            });
          }
        }
        if (sorteoTicketPackage && isFinalSummary && modeNoNext === "text_and_image") {
          console.info("[sorteo-ticket] final_node_delivery_start", {
            conversationId: state.id,
            path: "no_next_node",
            phase: "after_summary_text",
            mode: modeNoNext,
          });
          try {
            const { delivery } = await runSorteoTicketAfterFinalNodeMessage({
              supabase,
              empresaId: state.empresa_id,
              conversationId: state.id,
              contactId: state.contact_id,
              channelId: state.channel_id,
              flowSessionId: flowSidInteractive,
              orderResult: sorteoTicketPackage.fin,
              flowData: sorteoTicketPackage.flowData,
            });
            if (delivery && !delivery.ok && !delivery.skipped) {
              console.error("[sorteo-ticket] final_node_delivery_error", {
                conversationId: state.id,
                path: "no_next_node",
                reason: delivery.reason ?? "unknown",
              });
            } else if (delivery?.skipped && delivery.reason && delivery.reason !== "already_sent") {
              console.info("[sorteo-ticket] final_node_delivery_skipped", {
                conversationId: state.id,
                path: "no_next_node",
                reason: delivery.reason,
              });
            } else if (delivery?.ok) {
              console.info("[sorteo-ticket] final_node_delivery_sent", {
                conversationId: state.id,
                path: "no_next_node",
                phase: "after_summary_text",
                lastStatus: delivery.lastStatus,
                skipped: delivery.skipped,
              });
            }
          } catch (e) {
            console.error("[sorteo-ticket] final_node_delivery_error", {
              conversationId: state.id,
              path: "no_next_node",
              err: e instanceof Error ? e.message : String(e),
            });
          }
        }
      }
      return { ok: true, status: "no_next_node" };
    }
    const advInteractiveGate = await resolveProposedNextWithCompletenessGate({
      empresaId: state.empresa_id,
      conversationId: state.id,
      flowCode: state.flow_code as string,
      flowSessionId: flowSidInteractive,
      proposedNextCode: selected.next_node_code.trim(),
      mergeFlowVars: sorteoOrderMerge,
      gateReason: "interactive_reply",
    });
    const nextCodeEffective = advInteractiveGate.effectiveNext;

    console.info("[flow-engine] next node resolved", {
      conversationId: state.id,
      currentNode: currentNode.node_code,
      nextNodeCode: nextCodeEffective,
      proposedNextNodeCode: selected.next_node_code,
      metaButtonId: params.metaButtonId,
    });

    const adv = await advanceConversationToNode({
      conversationId: state.id,
      empresaId: state.empresa_id,
      flowCode: state.flow_code,
      nextNodeCode: nextCodeEffective,
    });
    if (!adv.ok) {
      return {
        ok: false,
        status: "advance_failed",
        error: adv.error ?? "No se pudo avanzar al siguiente nodo",
      };
    }

    await insertFlowEvent({
      empresaId: state.empresa_id,
      conversationId: state.id,
      flowCode: state.flow_code,
      nodeCode: nextCodeEffective,
      flowSessionId: flowSidInteractive,
      eventType: "node_advanced",
      selectedOptionId: selected.id,
      metaButtonId: params.metaButtonId,
      payload: { from_node: currentNode.node_code, next_node_code: nextCodeEffective },
    });

    const nextNodeForTicket = await getNode(
      state.empresa_id,
      state.flow_code,
      nextCodeEffective
    );
    const isSorteoFinal = isSorteoFinalTicketNode(nextCodeEffective, {
      nodeMessageTemplate: nextNodeForTicket?.message_text ?? null,
    });
    let sorteoSuppressPlain = false;
    let sorteoMode: SorteoTicketDeliveryMode = "text_only";

    if (sorteoTicketPackage && isSorteoFinal) {
      sorteoMode = await getSorteoTicketDeliveryModeForSorteo({
        supabase,
        empresaId: state.empresa_id,
        sorteoId: sorteoTicketPackage.fin.sorteoId,
      });
      console.info("[sorteo-ticket] final_node_check", {
        conversationId: state.id,
        nextNodeCode: nextCodeEffective,
        isSorteoFinal: true,
        hasPackage: true,
        mode: sorteoMode,
      });
      console.info("[sorteo-ticket] final_node_existing_order_detected", {
        conversationId: state.id,
        sorteoId: sorteoTicketPackage.fin.sorteoId,
        entradaId: sorteoTicketPackage.fin.entradaId,
        nextNodeCode: nextCodeEffective,
      });
      if (sorteoMode === "text_only") {
        console.info("[sorteo-ticket] final_node_delivery_skipped", { reason: "text_only" });
      } else if (sorteoMode === "image_only") {
        console.info("[sorteo-ticket] final_node_delivery_start", {
          conversationId: state.id,
          phase: "before_final_text",
          mode: sorteoMode,
        });
        const { delivery } = await runSorteoTicketAfterFinalNodeMessage({
          supabase,
          empresaId: state.empresa_id,
          conversationId: state.id,
          contactId: state.contact_id,
          channelId: state.channel_id,
          flowSessionId: flowSidInteractive,
          orderResult: sorteoTicketPackage.fin,
          flowData: sorteoTicketPackage.flowData,
        });
        sorteoSuppressPlain = shouldSuppressSorteoFinalTextAfterImageOnlyTicket(delivery);
        if (delivery && !delivery.ok && !delivery.skipped) {
          console.error("[sorteo-ticket] final_node_delivery_error", {
            conversationId: state.id,
            reason: delivery.reason ?? "unknown",
          });
        } else if (delivery?.skipped && delivery.reason && delivery.reason !== "already_sent") {
          console.info("[sorteo-ticket] final_node_delivery_skipped", {
            conversationId: state.id,
            reason: delivery.reason,
          });
        } else if (delivery?.ok) {
          console.info("[sorteo-ticket] final_node_delivery_sent", {
            conversationId: state.id,
            lastStatus: delivery.lastStatus,
            skipped: delivery.skipped,
          });
        }
      }
    } else if (sorteoTicketPackage) {
      console.info("[sorteo-ticket] final_node_check", {
        conversationId: state.id,
        nextNodeCode: nextCodeEffective,
        isSorteoFinal: false,
        hasPackage: true,
      });
      console.info("[sorteo-ticket] final_node_delivery_skipped", { reason: "not_final_node" });
    }

    const sent = await sendCurrentFlowNode({
      conversationId: state.id,
      ...(sorteoOrderMerge ? { mergeFlowVars: sorteoOrderMerge } : {}),
      ...(sorteoSuppressPlain ? { suppressPlainTextBody: true } : {}),
    });
    if (!sent.ok) {
      return { ok: false, status: "send_next_node_failed", error: sent.error };
    }
    console.info("[flow-engine] message sent for node", {
      conversationId: state.id,
      nodeCode: sent.nodeCode ?? nextCodeEffective,
    });
    if (sorteoTicketPackage && isSorteoFinal && sorteoMode === "text_and_image") {
      console.info("[sorteo-ticket] final_node_delivery_start", {
        conversationId: state.id,
        phase: "after_final_text",
        mode: sorteoMode,
      });
      try {
        const { delivery } = await runSorteoTicketAfterFinalNodeMessage({
          supabase,
          empresaId: state.empresa_id,
          conversationId: state.id,
          contactId: state.contact_id,
          channelId: state.channel_id,
          flowSessionId: flowSidInteractive,
          orderResult: sorteoTicketPackage.fin,
          flowData: sorteoTicketPackage.flowData,
        });
        if (delivery && !delivery.ok && !delivery.skipped) {
          console.error("[sorteo-ticket] final_node_delivery_error", {
            conversationId: state.id,
            reason: delivery.reason ?? "unknown",
          });
        } else if (delivery?.skipped && delivery.reason && delivery.reason !== "already_sent") {
          console.info("[sorteo-ticket] final_node_delivery_skipped", {
            conversationId: state.id,
            reason: delivery.reason,
          });
        } else if (delivery?.ok) {
          console.info("[sorteo-ticket] final_node_delivery_sent", {
            conversationId: state.id,
            lastStatus: delivery.lastStatus,
            skipped: delivery.skipped,
            fromExistingFlowData: sorteoTicketFromExistingFlowData,
          });
        }
      } catch (e) {
        console.error("[sorteo-ticket] final_node_delivery_error", {
          conversationId: state.id,
          err: e instanceof Error ? e.message : String(e),
        });
      }
    }

    return { ok: true, status: "advanced", nextNodeCode: nextCodeEffective };
  }

  async function processTextReply(
    params: ProcessTextReplyParams
  ): Promise<{ ok: boolean; status: string; nextNodeCode?: string; error?: string }> {
    const textValue = params.textValue.trim();
    if (!textValue) return { ok: true, status: "empty_text_ignored" };

    const state = await getConversationFlowState(params.conversationId);
    if (!state || state.empresa_id !== params.empresaId) {
      return { ok: false, status: "conversation_not_found", error: "Conversación no encontrada" };
    }
    if (!isConversationInBotAutomationMode(state)) {
      return { ok: true, status: "ignored_not_bot_mode" };
    }
    if (!state.flow_code || !state.flow_current_node) {
      return { ok: true, status: "missing_flow_state" };
    }

    const currentNode = await getNode(
      state.empresa_id,
      state.flow_code,
      state.flow_current_node
    );
    if (!currentNode) {
      return { ok: true, status: "ignored_node_not_found" };
    }
    if (currentNode.node_type === "image_input") {
      const sendCtx = await getConversationSendContext(state.id);
      const reminder = await buildImageInputReminderText(
        currentNode,
        state.id,
        "expected_image_got_text"
      );
      const send = await flowSendText(sendCtx, reminder);
      if (send.ok) {
        await persistOutgoingMessage({
          conversation: state,
          content: reminder,
          messageType: "text",
          waMessageId: send.waMessageId,
          raw: send.raw,
          senderType: "system",
          automationSource: "flow_engine",
        });
      }
      await insertFlowEvent({
        empresaId: state.empresa_id,
        conversationId: state.id,
        flowCode: state.flow_code,
        nodeCode: currentNode.node_code,
        flowSessionId: state.active_flow_session_id,
        eventType: "image_expected_text_received",
        payload: { text_value: textValue, raw: params.rawPayload },
      });
      return { ok: true, status: "image_expected_text_received" };
    }
    if (currentNode.node_type !== "text" || !currentNode.save_as_field?.trim()) {
      return { ok: true, status: "ignored_not_text_node" };
    }

    const textFlowSid = state.active_flow_session_id?.trim();
    if (!textFlowSid) {
      return {
        ok: false,
        status: "missing_flow_session",
        error: "Sesión de flujo no inicializada; reiniciá el chat o escribí hola.",
      };
    }

    if (currentNode.save_as_field) {
      const { error: dataErr } = await supabase
        .from("chat_flow_data")
        .upsert(
          {
            empresa_id: state.empresa_id,
            conversation_id: state.id,
            flow_code: state.flow_code,
            flow_session_id: textFlowSid,
            field_name: currentNode.save_as_field,
            field_value: textValue,
          },
          { onConflict: "flow_session_id,field_name" }
        );
      if (dataErr) {
        return { ok: false, status: "save_text_failed", error: dataErr.message };
      }
      flowTrace("flow_data_write", {
        conversation_id: state.id,
        empresa_id: state.empresa_id,
        flow_code: state.flow_code,
        flow_session_id_write: textFlowSid,
        node_code: currentNode.node_code,
        event: "text_captured",
        field_name: currentNode.save_as_field ?? null,
        field_value_len: textValue.length,
      });
      const sfLower = currentNode.save_as_field.trim().toLowerCase();
      if (["nombre", "apellido", "nombre_y_apellido"].includes(sfLower)) {
        const { error: clrErr } = await supabase.from("chat_flow_data").upsert(
          {
            empresa_id: state.empresa_id,
            conversation_id: state.id,
            flow_code: state.flow_code,
            flow_session_id: textFlowSid,
            field_name: "nombre_completo",
            field_value: "",
          },
          { onConflict: "flow_session_id,field_name" }
        );
        if (clrErr) {
          console.warn(FLOW_SORTEO_LOG, "clear_stale_nombre_completo_failed", {
            conversationId: state.id,
            message: clrErr.message,
          });
        }
      }
    }

    await insertFlowEvent({
      empresaId: state.empresa_id,
      conversationId: state.id,
      flowCode: state.flow_code,
      nodeCode: currentNode.node_code,
      flowSessionId: textFlowSid,
      eventType: "text_captured",
      payload: {
        save_as_field: currentNode.save_as_field ?? null,
        text_value: textValue,
        raw: params.rawPayload,
      },
    });

    try {
      const fdAudit = await getConversationFlowDataMap({
        empresaId: state.empresa_id,
        conversationId: state.id,
        flowCode: state.flow_code,
        flowSessionId: textFlowSid,
        traceReadContext: "sorteo_manual_next_inbound_audit",
      });
      if ((fdAudit[FLOW_SORTEO_PENDIENTE_DATOS_PARTICIPANTE_FIELD] ?? "").trim() === "si") {
        await insertFlowEvent({
          empresaId: state.empresa_id,
          conversationId: state.id,
          flowCode: state.flow_code,
          nodeCode: currentNode.node_code,
          flowSessionId: textFlowSid,
          eventType: "sorteo_manual_approval_next_inbound_processed",
          payload: {
            field_name: currentNode.save_as_field ?? null,
            next_node_code: currentNode.next_node_code ?? null,
            resultado: currentNode.next_node_code ? "capture_ok_will_advance" : "capture_ok_no_next",
          },
        });
      }
    } catch (e) {
      console.warn("[sorteo-manual-approval] next_inbound_audit_failed", {
        conversationId: state.id,
        message: e instanceof Error ? e.message : String(e),
      });
    }

    if (!currentNode.next_node_code) {
      return { ok: true, status: "captured_no_next_node" };
    }

    const txtGate = await resolveProposedNextWithCompletenessGate({
      empresaId: state.empresa_id,
      conversationId: state.id,
      flowCode: state.flow_code,
      flowSessionId: textFlowSid,
      proposedNextCode: currentNode.next_node_code.trim(),
      gateReason: "text_captured",
    });
    const nextTxt = txtGate.effectiveNext;

    console.info("[flow-engine] text captured advance", {
      conversationId: state.id,
      currentNode: currentNode.node_code,
      saveAsField: currentNode.save_as_field ?? null,
      nextNodeCode: nextTxt,
    });

    const adv = await advanceConversationToNode({
      conversationId: state.id,
      empresaId: state.empresa_id,
      flowCode: state.flow_code,
      nextNodeCode: nextTxt,
    });
    if (!adv.ok) {
      return {
        ok: false,
        status: "advance_failed",
        error: adv.error ?? "No se pudo avanzar al siguiente nodo",
      };
    }

    await insertFlowEvent({
      empresaId: state.empresa_id,
      conversationId: state.id,
      flowCode: state.flow_code,
      nodeCode: nextTxt,
      flowSessionId: textFlowSid,
      eventType: "node_advanced",
      payload: {
        from_node: currentNode.node_code,
        next_node_code: nextTxt,
        reason: "text_captured",
      },
    });

    const sent = await sendCurrentFlowNode({ conversationId: state.id });
    if (!sent.ok) {
      return { ok: false, status: "send_next_node_failed", error: sent.error };
    }

    return { ok: true, status: "advanced", nextNodeCode: nextTxt };
  }

  async function processImageReply(
    params: ProcessImageReplyParams
  ): Promise<{ ok: boolean; status: string; nextNodeCode?: string; error?: string }> {
    console.info(FLOW_SORTEO_LOG, "processImageReply_enter", {
      conversationId: params.conversationId,
      empresaId: params.empresaId,
      mediaId: params.mediaId,
    });
    const state = await getConversationFlowState(params.conversationId);
    if (!state || state.empresa_id !== params.empresaId) {
      console.warn(FLOW_SORTEO_LOG, "processImageReply_early_exit", {
        status: "conversation_not_found",
        archivo: "src/lib/chat/flow-engine-service.ts",
        lineApprox: 1154,
        condicion: "!state || state.empresa_id !== params.empresaId",
        conversationId: params.conversationId,
        ensureSorteoOrderFromChat: "no_llamado",
      });
      return { ok: false, status: "conversation_not_found", error: "Conversación no encontrada" };
    }
    if (!isConversationInBotAutomationMode(state)) {
      console.info(FLOW_SORTEO_LOG, "processImageReply_early_exit", {
        status: "ignored_not_bot_mode",
        archivo: "src/lib/chat/flow-engine-service.ts",
        lineApprox: 1167,
        condicion: "!isConversationInBotAutomationMode(state)",
        conversationId: state.id,
        flow_status: state.flow_status,
        human_taken_over: state.human_taken_over,
        ensureSorteoOrderFromChat: "no_llamado",
      });
      return { ok: true, status: "ignored_not_bot_mode" };
    }
    if (!state.flow_code || !state.flow_current_node) {
      console.info(FLOW_SORTEO_LOG, "processImageReply_early_exit", {
        status: "missing_flow_state",
        archivo: "src/lib/chat/flow-engine-service.ts",
        lineApprox: 1180,
        condicion: "!flow_code || !flow_current_node",
        conversationId: state.id,
        flow_code: state.flow_code,
        flow_current_node: state.flow_current_node,
        ensureSorteoOrderFromChat: "no_llamado",
      });
      return { ok: true, status: "missing_flow_state" };
    }

    const currentNode = await getNode(
      state.empresa_id,
      state.flow_code,
      state.flow_current_node
    );
    if (!currentNode || currentNode.node_type !== "image_input") {
      console.info(FLOW_SORTEO_LOG, "processImageReply_early_exit", {
        status: "ignored_not_image_node",
        archivo: "src/lib/chat/flow-engine-service.ts",
        lineApprox: 1200,
        condicion: "!currentNode || currentNode.node_type !== 'image_input'",
        conversationId: state.id,
        flowCode: state.flow_code,
        flow_current_node: state.flow_current_node,
        node_type: currentNode?.node_type ?? null,
        ensureSorteoOrderFromChat: "no_llamado",
      });
      return { ok: true, status: "ignored_not_image_node" };
    }

    const imgSidPeek = state.active_flow_session_id?.trim();
    if (imgSidPeek && state.flow_code && currentNode.next_node_code?.trim()) {
      const rawPeek = await getConversationFlowDataMap({
        empresaId: state.empresa_id,
        conversationId: state.id,
        flowCode: state.flow_code,
        flowSessionId: imgSidPeek,
        traceReadContext: "skip_comprobante_manual_ok_peek",
      });
      const hydPeek = await hydrateFlowDataFromSessionEvents(
        state.id,
        state.flow_code,
        rawPeek,
        imgSidPeek
      );
      const urlPeek = resolveComprobanteUrlFromFlowData(hydPeek as Record<string, string>);
      const estPeek = String(
        (hydPeek as Record<string, string>)[SORTEO_COMPROBANTE_ESTADO_VALIDACION_FIELD] ?? ""
      ).trim();
      if (urlPeek && estPeek === "aprobado_manual") {
        const advSkip = await advanceConversationToNode({
          conversationId: state.id,
          empresaId: state.empresa_id,
          flowCode: state.flow_code,
          nextNodeCode: currentNode.next_node_code.trim(),
        });
        if (advSkip.ok) {
          await insertFlowEvent({
            empresaId: state.empresa_id,
            conversationId: state.id,
            flowCode: state.flow_code,
            nodeCode: currentNode.node_code,
            flowSessionId: imgSidPeek,
            eventType: "image_input_skipped_manual_comprobante_ok",
            payload: { reason: "comprobante_aprobado_manual_sesion" },
          });
          await sendCurrentFlowNode({ conversationId: state.id });
          return { ok: true, status: "skipped_redundant_comprobante_manual_ok" };
        }
      }
    }

    const sendCtx = await getConversationSendContext(state.id);
    if (sendCtx.provider !== "meta") {
      console.warn("[flow-engine] processImageReply omitido: descarga de media usa Graph (Meta)", {
        conversationId: state.id,
      });
      return { ok: true, status: "ignored_ycloud_image_pipeline" };
    }

    let media: { bytes: Uint8Array; mimeType: string };
    try {
      media = await downloadMetaMedia({
        mediaId: params.mediaId,
        accessToken: sendCtx.token,
        mimeTypeHint: params.mimeType ?? null,
      });
    } catch (graphErr) {
      const fb = params.fallbackPublicUrl?.trim();
      const graphMsg = graphErr instanceof Error ? graphErr.message : String(graphErr);
      if (fb && /^https:\/\//i.test(fb)) {
        console.warn("[flow-image-input]", "[graph-fallback]", {
          conversationId: state.id,
          mediaId: params.mediaId,
          graphError: graphMsg.slice(0, 240),
        });
        try {
          const binRes = await fetch(fb);
          if (!binRes.ok) {
            return {
              ok: false,
              status: "graph_and_fallback_fetch_failed",
              error: `Graph: ${graphMsg.slice(0, 120)}; fallback HTTP ${binRes.status}`,
            };
          }
          const arr = new Uint8Array(await binRes.arrayBuffer());
          const ct = binRes.headers.get("content-type")?.split(";")[0]?.trim();
          media = {
            bytes: arr,
            mimeType:
              ct ||
              params.fallbackMimeType?.trim() ||
              params.mimeType?.trim() ||
              "image/jpeg",
          };
        } catch (fe) {
          const fm = fe instanceof Error ? fe.message : String(fe);
          return {
            ok: false,
            status: "fallback_fetch_failed",
            error: `${graphMsg.slice(0, 80)} | fallback: ${fm}`,
          };
        }
      } else {
        return {
          ok: false,
          status: "graph_download_failed",
          error: graphMsg,
        };
      }
    }
    const mimeNorm = (media.mimeType || "").toLowerCase();
    if (!isComprobanteMimeAccepted(media.mimeType)) {
      const reminder = await buildImageInputReminderText(
        currentNode,
        state.id,
        "expected_image_got_non_image"
      );
      const send = await flowSendText(sendCtx, reminder);
      if (send.ok) {
        await persistOutgoingMessage({
          conversation: state,
          content: reminder,
          messageType: "text",
          waMessageId: send.waMessageId,
          raw: send.raw,
          senderType: "system",
          automationSource: "flow_engine",
        });
      }
      await insertFlowEvent({
        empresaId: state.empresa_id,
        conversationId: state.id,
        flowCode: state.flow_code,
        nodeCode: currentNode.node_code,
        flowSessionId: state.active_flow_session_id,
        eventType: "image_expected_non_image_received",
        payload: {
          mime_type: media.mimeType,
          media_id: params.mediaId,
          raw: params.rawPayload,
        },
      });
      console.info(FLOW_SORTEO_LOG, "processImageReply_early_exit", {
        status: "ignored_non_image_mime",
        archivo: "src/lib/chat/flow-engine-service.ts",
        lineApprox: 1255,
        condicion: "!isComprobanteMimeAccepted (imagen o PDF)",
        conversationId: state.id,
        flowCode: state.flow_code,
        mimeNorm,
        ensureSorteoOrderFromChat: "no_llamado",
      });
      return { ok: true, status: "ignored_non_image_mime" };
    }

    await ensureChatMediaBucket();

    const ext = extensionFromMime(media.mimeType);
    const path = `${state.empresa_id}/${state.id}/${Date.now()}.${ext}`;
    const upload = await supabase.storage.from(CHAT_MEDIA_BUCKET).upload(path, media.bytes, {
      contentType: media.mimeType,
      upsert: true,
    });
    if (upload.error) {
      console.error(FLOW_SORTEO_LOG, "processImageReply_early_exit", {
        status: "upload_failed",
        archivo: "src/lib/chat/flow-engine-service.ts",
        lineApprox: 1277,
        condicion: "storage.upload.error",
        conversationId: state.id,
        flowCode: state.flow_code,
        error: upload.error.message,
        ensureSorteoOrderFromChat: "no_llamado",
      });
      return { ok: false, status: "upload_failed", error: upload.error.message };
    }
    const publicUrl = supabase.storage.from(CHAT_MEDIA_BUCKET).getPublicUrl(path).data.publicUrl;

    const imgFlowSid = state.active_flow_session_id?.trim();
    if (!imgFlowSid) {
      return {
        ok: false,
        status: "missing_flow_session",
        error: "Sesión de flujo no inicializada; escribí hola para reiniciar antes del comprobante.",
      };
    }

    const { data: convChannelSnap } = await supabase
      .from("chat_conversations")
      .select("channel_id")
      .eq("id", state.id)
      .eq("empresa_id", state.empresa_id)
      .maybeSingle();
    const channelIdFromConversation =
      typeof convChannelSnap?.channel_id === "string" && convChannelSnap.channel_id.trim()
        ? convChannelSnap.channel_id.trim()
        : state.channel_id?.trim() ?? "";
    if (
      channelIdFromConversation &&
      state.channel_id?.trim() &&
      channelIdFromConversation !== state.channel_id.trim()
    ) {
      console.warn("[flow-engine] processImageReply channel_id alineado desde chat_conversations", {
        conversationId: state.id,
        estado_flujo: state.channel_id,
        conversacion: channelIdFromConversation,
      });
    }

    flowTrace("process_image_reply_state", {
      conversation_id: state.id,
      empresa_id: state.empresa_id,
      active_flow_session_id: state.active_flow_session_id ?? null,
      flow_session_id_for_comprobante: imgFlowSid,
      flow_current_node: state.flow_current_node,
      flow_code: state.flow_code,
      event: "comprobante_image_input",
    });

    const { data: chCfgImg } = await supabase
      .from("chat_channels")
      .select("config")
      .eq("id", channelIdFromConversation)
      .maybeSingle();
    const valSettings = parseComprobanteValidationConfig(chCfgImg?.config);

    let comprobanteStagingRows: Array<{
      empresa_id: string;
      conversation_id: string;
      flow_code: string;
      flow_session_id: string;
      field_name: string;
      field_value: string;
    }> = [
      {
        empresa_id: state.empresa_id,
        conversation_id: state.id,
        flow_code: state.flow_code,
        flow_session_id: imgFlowSid,
        field_name: SORTEO_COMPROBANTE_MEDIA_ID_FIELD,
        field_value: params.mediaId,
      },
      {
        empresa_id: state.empresa_id,
        conversation_id: state.id,
        flow_code: state.flow_code,
        flow_session_id: imgFlowSid,
        field_name: SORTEO_COMPROBANTE_URL_FIELD,
        field_value: publicUrl,
      },
    ];

    const pipeline = await runComprobanteValidationPipeline({
      supabase,
      empresaId: state.empresa_id,
      conversationId: state.id,
      channelId: channelIdFromConversation,
      flowCode: state.flow_code,
      flowSessionId: imgFlowSid,
      mediaId: params.mediaId,
      publicUrl,
      bytes: Buffer.from(media.bytes),
      mimeType: media.mimeType,
      settings: valSettings,
    });

    if (pipeline.kind === "resolved") {
      comprobanteStagingRows = pipeline.flowUpserts;
    }

    if (currentNode.save_as_field?.trim()) {
      comprobanteStagingRows.push({
        empresa_id: state.empresa_id,
        conversation_id: state.id,
        flow_code: state.flow_code,
        flow_session_id: imgFlowSid,
        field_name: currentNode.save_as_field.trim(),
        field_value: publicUrl,
      });
    }
    const { error: upErr } = await supabase
      .from("chat_flow_data")
      .upsert(comprobanteStagingRows, { onConflict: "flow_session_id,field_name" });
    if (upErr) {
      console.error(FLOW_SORTEO_LOG, "processImageReply_early_exit", {
        status: "save_image_failed",
        archivo: "src/lib/chat/flow-engine-service.ts",
        condicion: "chat_flow_data comprobante staging upsert",
        conversationId: state.id,
        flowCode: state.flow_code,
        error: upErr.message,
      });
      return { ok: false, status: "save_image_failed", error: upErr.message };
    }
    flowTrace("flow_data_write", {
      conversation_id: state.id,
      empresa_id: state.empresa_id,
      flow_code: state.flow_code,
      flow_session_id_write: imgFlowSid,
      node_code: currentNode.node_code,
      event: "comprobante_staged_deferred_order",
      field_names: comprobanteStagingRows.map((r) => r.field_name),
    });

    await insertFlowEvent({
      empresaId: state.empresa_id,
      conversationId: state.id,
      flowCode: state.flow_code,
      nodeCode: currentNode.node_code,
      flowSessionId: imgFlowSid,
      eventType: "image_received",
      payload: {
        wa_message_id: params.waMessageId ?? null,
        media_id: params.mediaId,
        mime_type: media.mimeType,
        caption: params.caption ?? null,
        storage_url: publicUrl,
        save_as_field: currentNode.save_as_field ?? null,
        sorteo_order_deferred_until_confirm: true,
        comprobante_validacion:
          pipeline.kind === "resolved"
            ? {
                validation_id: pipeline.validationId,
                estado: pipeline.estado,
                advance: pipeline.advance,
              }
            : null,
      },
    });

    if (pipeline.kind === "resolved") {
      const sendCtxVal = await getConversationSendContext(state.id);
      if (pipeline.sendText?.trim()) {
        const st = await flowSendText(sendCtxVal, pipeline.sendText.trim());
        if (st.ok) {
          await persistOutgoingMessage({
            conversation: state,
            content: pipeline.sendText.trim(),
            messageType: "text",
            waMessageId: st.waMessageId,
            raw: st.raw,
            senderType: "system",
            automationSource: "flow_engine",
          });
        }
      }
      if (pipeline.humanTakeover) {
        await supabase
          .from("chat_conversations")
          .update({
            flow_status: "human",
            human_taken_over: true,
            updated_at: new Date().toISOString(),
          })
          .eq("id", state.id);
      }
      if (pipeline.sendInteractive && sendCtxVal.provider === "meta") {
        const ib = await sendWhatsAppInteractiveButtons({
          toDigits: sendCtxVal.toDigits,
          phoneNumberId: sendCtxVal.phoneNumberId,
          accessToken: sendCtxVal.token,
          bodyText: pipeline.sendInteractive.body,
          buttons: pipeline.sendInteractive.buttons,
        });
        if (ib.ok) {
          await persistOutgoingMessage({
            conversation: state,
            content: pipeline.sendInteractive.body,
            messageType: "interactive",
            waMessageId: ib.waMessageId,
            raw: ib.raw,
            senderType: "system",
            automationSource: "flow_engine",
            neuraInteractive: {
              kind: "buttons",
              groupTitle: pipeline.sendInteractive.body,
              items: pipeline.sendInteractive.buttons.map((b) => ({
                id: b.id,
                title: b.title,
                payload: null,
              })),
            },
          });
        }
      }
      if (!pipeline.advance) {
        console.info("[sorteo-ticket] image_path_skipped_pipeline_not_advance", {
          conversationId: state.id,
          flow_session_id: imgFlowSid,
        });
        return { ok: true, status: "comprobante_blocked_validation" };
      }
    }

    let sorteoOrderMerge: Record<string, string> | undefined;

    const sorteoImgGateOk =
      pipeline.kind === "resolved" &&
      (pipeline.kind === "resolved" ? pipeline.advance : false) &&
      Boolean(state.flow_code?.trim()) &&
      Boolean(imgFlowSid);
    if (!sorteoImgGateOk) {
      console.info("[sorteo-ticket] image_path_gate_skip", {
        conversationId: state.id,
        kindResolved: pipeline.kind === "resolved",
        pipelineAdvance: pipeline.kind === "resolved" ? pipeline.advance : null,
        hasFlowCode: Boolean(state.flow_code?.trim()),
        hasFlowSessionId: Boolean(imgFlowSid),
      });
    }

    if (sorteoImgGateOk) {
      const sendCtxOrd = await getConversationSendContext(state.id);
      const dataSchemaTag = await fetchDataSchemaForEmpresaId(state.empresa_id);

      const rawFdImg = await getConversationFlowDataMap({
        empresaId: state.empresa_id,
        conversationId: state.id,
        flowCode: state.flow_code,
        flowSessionId: imgFlowSid,
        traceReadContext: "before_finalize_sorteo_on_image",
      });
      let hydFdImg = await hydrateFlowDataFromSessionEvents(
        state.id,
        state.flow_code as string,
        rawFdImg,
        imgFlowSid
      );
      console.info(FLOW_SORTEO_LOG, "[order-create]", "[hydrate-active-session]", {
        conversation_id: state.id,
        flow_session_id: imgFlowSid,
        flow_code: state.flow_code,
        key_count: Object.keys(hydFdImg).length,
        keys: Object.keys(hydFdImg).sort(),
      });

      const histMerge = await mergeConversationFlowDataFromOlderSessions({
        empresaId: state.empresa_id,
        conversationId: state.id,
        flowCode: state.flow_code as string,
        base: hydFdImg,
      });
      hydFdImg = histMerge.merged;
      console.info(FLOW_SORTEO_LOG, "[order-create]", "[hydrate-conversation-fallback]", {
        conversation_id: state.id,
        flow_code: state.flow_code,
        filled_count: histMerge.filledKeys.length,
        filled_keys: histMerge.filledKeys.slice(0, 40),
      });

      hydFdImg = await hydrateSorteoFlowDataFromChatContact(
        state.empresa_id,
        state.contact_id,
        hydFdImg
      );

      const trimFd = (s: string | undefined) => (s ?? "").trim();
      if (!trimFd(hydFdImg[SORTEO_COMPROBANTE_URL_FIELD])) {
        hydFdImg[SORTEO_COMPROBANTE_URL_FIELD] = publicUrl;
      }
      if (!trimFd(hydFdImg[SORTEO_COMPROBANTE_MEDIA_ID_FIELD])) {
        hydFdImg[SORTEO_COMPROBANTE_MEDIA_ID_FIELD] = params.mediaId;
      }
      hydFdImg = applyCantidadFallbackOneIfMissing(hydFdImg);

      const preparedForCheck = prepareFlowDataForSorteoOrder(hydFdImg);
      const participantOk = parseSorteoParticipantFromFlowData(preparedForCheck);
      if (!participantOk) {
        console.warn(FLOW_SORTEO_LOG, "[order-create]", "[missing-after-hydration]", {
          conversation_id: state.id,
          flow_session_id: imgFlowSid,
          detail: explainParseSorteoParticipantFailure(preparedForCheck),
        });
      }
      console.info(FLOW_SORTEO_LOG, "[order-create]", "[final-context]", {
        schema: dataSchemaTag,
        conversation_id: state.id,
        flow_session_id: imgFlowSid,
        media_id: params.mediaId,
        has_participant: Boolean(participantOk),
        cantidad_hint:
          trimFd(hydFdImg.cantidad) ||
          trimFd(hydFdImg.sorteo_snap_cantidad) ||
          trimFd(hydFdImg.sorteo_cantidad_opcion) ||
          null,
        keys: Object.keys(hydFdImg).sort(),
      });

      const sorteoIdPre = await getSorteoIdForChatFlow(supabase, state.empresa_id, state.flow_code as string);

      console.info(FLOW_SORTEO_LOG, "[order-create]", "[start]", {
        conversation_id: state.id,
        flow_session_id: imgFlowSid,
        flow_code: state.flow_code,
        empresa_id: state.empresa_id,
        sorteo_id: sorteoIdPre,
      });

      const notifySorteoImageErr = async (text: string) => {
        const send = await flowSendText(sendCtxOrd, text);
        if (send.ok) {
          await persistOutgoingMessage({
            conversation: state,
            content: text,
            messageType: "text",
            waMessageId: send.waMessageId,
            raw: send.raw,
            senderType: "system",
            automationSource: "flow_engine",
          });
        }
      };

      if (!sorteoIdPre) {
        console.error(FLOW_SORTEO_LOG, "[order-create]", "[missing_sorteo_id]", {
          schema: dataSchemaTag,
          conversation_id: state.id,
          flow_session_id: imgFlowSid,
          flow_code: state.flow_code,
          empresa_id: state.empresa_id,
        });
        await notifySorteoImageErr(
          "Recibimos tu comprobante, pero este flujo no está vinculado a un sorteo en el sistema. Un operador te va a contactar."
        );
        return {
          ok: false,
          status: "missing_sorteo_id",
          error: "chat_flows.sorteo_id no configurado para este flujo",
        };
      }

      const imgClosePolicy = await getFlowClosePurchasePolicy(
        supabase,
        state.empresa_id,
        state.flow_code as string
      );

      if (!imgClosePolicy.closePurchaseOnlyOnFinalConfirmation) {
      const finImg = await finalizeSorteoOrderFromConfirmedFlowData(supabase, {
        empresaId: state.empresa_id,
        conversationId: state.id,
        flowCode: state.flow_code as string,
        flowSessionId: imgFlowSid,
        whatsappNumero: sendCtxOrd.toDigits,
        flowData: hydFdImg,
      });

      if (!finImg.ok) {
        console.error(FLOW_SORTEO_LOG, "[order-create]", "[error]", {
          schema: dataSchemaTag,
          conversation_id: state.id,
          flow_session_id: imgFlowSid,
          flow_code: state.flow_code,
          sorteo_id: sorteoIdPre,
          cantidad_hint:
            trimFd(hydFdImg.cantidad) ||
            trimFd(hydFdImg.sorteo_snap_cantidad) ||
            trimFd(hydFdImg.sorteo_cantidad_opcion) ||
            null,
          media_id: params.mediaId,
          message: finImg.message,
        });
        await notifySorteoImageErr(
          finImg.message?.trim() ||
            "No pudimos registrar tu compra en el sorteo. Intentá de nuevo en unos minutos o contactá soporte."
        );
        return { ok: false, status: "sorteo_order_failed", error: finImg.message };
      }

      if (finImg.ok && finImg.skipped) {
        let detail: string;
        if (finImg.reason === "sin_comprobante_en_sesion") {
          detail =
            "No encontramos el comprobante de esta compra. Enviá la imagen del comprobante y volvé a intentar.";
        } else if (finImg.reason === "flow_sin_sorteo_id") {
          detail = "Este flujo no está vinculado a un sorteo.";
        } else if (finImg.reason === "datos_flujo_incompletos") {
          const prepInc = prepareFlowDataForSorteoOrder(hydFdImg);
          const cantidadDetected = readSorteoCantidadNumericFromMap(prepInc);
          const descInc = await describeFlowCaptureCompletenessForLogs(
            supabase,
            state.empresa_id,
            state.flow_code as string,
            prepInc
          );
          const missingFields = descInc?.missing_fields ?? [];
          const incNode = descInc?.firstIncomplete;
          console.info("[sorteo-quantity][missing]", {
            schema: dataSchemaTag,
            empresa_id: state.empresa_id,
            conversation_id: state.id,
            flow_session_id: imgFlowSid,
            current_node_code: currentNode.node_code,
            missing_fields: missingFields,
            cantidad_detected: cantidadDetected,
            source: cantidadDetected != null ? "flow_data_alias" : "none",
          });
          if (incNode?.nodeCode && state.flow_code?.trim()) {
            console.info("[sorteo-quantity][resume-node-selected]", {
              schema: dataSchemaTag,
              empresa_id: state.empresa_id,
              conversation_id: state.id,
              flow_session_id: imgFlowSid,
              resume_node_code: incNode.nodeCode,
              missing_fields: missingFields,
            });
            if (missingFields.includes("cantidad")) {
              console.info("[sorteo-quantity][extracted]", {
                schema: dataSchemaTag,
                conversation_id: state.id,
                cantidad_detected: cantidadDetected,
              });
            }
            await insertFlowEvent({
              empresaId: state.empresa_id,
              conversationId: state.id,
              flowCode: state.flow_code,
              nodeCode: incNode.nodeCode,
              flowSessionId: imgFlowSid,
              eventType: "sorteo_incomplete_capture_resume",
              payload: {
                trigger: "image_finalize_skipped_datos_incompletos",
                resume_node_code: incNode.nodeCode,
                missing_fields: missingFields,
                sorteo_missing_quantity: missingFields.includes("cantidad"),
              },
            });
            const advIncomplete = await advanceConversationToNode({
              conversationId: state.id,
              empresaId: state.empresa_id,
              flowCode: state.flow_code,
              nextNodeCode: incNode.nodeCode.trim(),
            });
            if (advIncomplete.ok) {
              const sentIncomplete = await sendCurrentFlowNode({
                conversationId: state.id,
                mergeFlowVars: {
                  sorteo_comprobante_url: publicUrl,
                  comprobante_recibido: "sí",
                },
              });
              if (sentIncomplete.ok) {
                return {
                  ok: true,
                  status: "resumed_incomplete_capture_after_comprobante",
                  nextNodeCode: incNode.nodeCode.trim(),
                };
              }
            }
            console.warn("[sorteo-quantity][session-mismatch]", {
              schema: dataSchemaTag,
              empresa_id: state.empresa_id,
              conversation_id: state.id,
              flow_session_id: imgFlowSid,
              phase: "advance_or_send_failed_after_incomplete",
            });
          }
          detail = await getSorteoDatosIncompletosMessage(
            supabase,
            state.empresa_id,
            state.flow_code as string
          );
        } else if (finImg.reason === "comprobante_no_validado") {
          detail = await mensajeClienteComprobanteNoValido(
            supabase,
            state.id,
            typeof finImg.comprobanteEstado === "string" ? finImg.comprobanteEstado : "",
            typeof finImg.comprobanteMotivo === "string" ? finImg.comprobanteMotivo : undefined
          );
        } else {
          detail = SORTEO_IMAGE_ORDER_INCOMPLETE_MESSAGE;
        }
        console.warn(FLOW_SORTEO_LOG, "[order-create]", "[skipped]", {
          reason: finImg.reason,
          conversation_id: state.id,
          flow_session_id: imgFlowSid,
        });
        await notifySorteoImageErr(detail);
        return { ok: false, status: "sorteo_finalize_skipped", error: detail };
      }

      sorteoOrderMerge = buildSorteoOrderFlowVarOverrides(finImg);
      const ctxRowsImg = buildChatFlowDataUpsertsForSorteoOrder(
        state.empresa_id,
        state.id,
        state.flow_code as string,
        imgFlowSid,
        finImg
      );
      const { error: ctxErrImg } = await supabase
        .from("chat_flow_data")
        .upsert(ctxRowsImg, { onConflict: "flow_session_id,field_name" });
      if (ctxErrImg) {
        console.error(FLOW_SORTEO_LOG, "[order-create]", "[error]", {
          schema: dataSchemaTag,
          conversation_id: state.id,
          flow_session_id: imgFlowSid,
          phase: "chat_flow_data_upsert_after_order",
          message: ctxErrImg.message,
        });
        await notifySorteoImageErr(
          "Tu compra quedó registrada pero hubo un error al guardar el detalle en el chat. Si no ves tu número, escribí a soporte."
        );
      }

      console.info(FLOW_SORTEO_LOG, "[order-create]", "[success]", {
        entrada_id: finImg.entradaId,
        numero_orden: finImg.numeroOrden,
        cupones_count: finImg.cupones.length,
        sorteo_id: finImg.sorteoId,
      });
      console.info(FLOW_SORTEO_LOG, "[coupon-create]", "[success]", {
        count: finImg.cupones.length,
        entrada_id: finImg.entradaId,
      });

      await insertFlowEvent({
        empresaId: state.empresa_id,
        conversationId: state.id,
        flowCode: state.flow_code,
        nodeCode: currentNode.node_code,
        flowSessionId: imgFlowSid,
        eventType: "sorteo_order_ensured",
        payload: {
          idempotent: finImg.idempotent,
          entrada_id: finImg.entradaId,
          numero_orden: finImg.numeroOrden,
          cantidad_boletos: finImg.cantidadBoletos,
          monto_total: finImg.montoTotal,
          precio_fuente: finImg.precioFuente,
          promo_nombre: finImg.promoNombre,
          sorteo_id: finImg.sorteoId,
          sorteo_nombre: finImg.sorteoNombre,
          cupones: finImg.cupones.map((c) => c.numero_cupon),
          trigger: "comprobante_imagen",
        },
      });
      console.info("[sorteo-ticket] image_path_order_created_detected", {
        conversationId: state.id,
        flowSessionId: imgFlowSid,
        sorteoId: finImg.sorteoId,
        entradaId: finImg.entradaId,
        numeroOrden: finImg.numeroOrden,
        cuponesCount: finImg.cupones.length,
        trigger: "comprobante_imagen",
      });
      console.info("[sorteo-ticket] deferred_until_final_node", {
        conversationId: state.id,
        flowSessionId: imgFlowSid,
        entradaId: finImg.entradaId,
        sorteoId: finImg.sorteoId,
        trigger: "comprobante_imagen",
      });
      } else {
        console.info("[sorteo-close][image-validation-only]", {
          schema: dataSchemaTag,
          empresa_id: state.empresa_id,
          flow_code: state.flow_code,
          conversation_id: state.id,
          flow_session_id: imgFlowSid,
          current_node_code: currentNode.node_code,
          reason: "awaiting_final_confirmation",
        });
      }
    }

    if (!currentNode.next_node_code) {
      return { ok: true, status: "captured_no_next_node" };
    }

    const imgMergePreview = {
      sorteo_comprobante_url: publicUrl,
      comprobante_recibido: "sí",
      ...(sorteoOrderMerge ?? {}),
    };
    const imgGate = await resolveProposedNextWithCompletenessGate({
      empresaId: state.empresa_id,
      conversationId: state.id,
      flowCode: state.flow_code as string,
      flowSessionId: imgFlowSid,
      proposedNextCode: currentNode.next_node_code.trim(),
      mergeFlowVars: imgMergePreview,
      gateReason: "image_received",
    });
    const nextImg = imgGate.effectiveNext;

    const adv = await advanceConversationToNode({
      conversationId: state.id,
      empresaId: state.empresa_id,
      flowCode: state.flow_code,
      nextNodeCode: nextImg,
    });
    if (!adv.ok) {
      return { ok: false, status: "advance_failed", error: adv.error };
    }

    await insertFlowEvent({
      empresaId: state.empresa_id,
      conversationId: state.id,
      flowCode: state.flow_code,
      nodeCode: nextImg,
      flowSessionId: imgFlowSid,
      eventType: "node_advanced",
      payload: {
        from_node: currentNode.node_code,
        next_node_code: nextImg,
        reason: "image_received",
      },
    });

    const sent = await sendCurrentFlowNode({
      conversationId: state.id,
      mergeFlowVars: imgMergePreview,
    });
    if (!sent.ok) {
      return { ok: false, status: "send_next_node_failed", error: sent.error };
    }
    return { ok: true, status: "advanced", nextNodeCode: nextImg };
  }

  async function loadHydratedFlowSessionData(params: {
    empresaId: string;
    conversationId: string;
    flowCode: string;
    flowSessionId: string;
  }): Promise<Record<string, string>> {
    const raw = await getConversationFlowDataMap({
      empresaId: params.empresaId,
      conversationId: params.conversationId,
      flowCode: params.flowCode,
      flowSessionId: params.flowSessionId,
      traceReadContext: "manual_sorteo_approval",
    });
    return hydrateFlowDataFromSessionEvents(
      params.conversationId,
      params.flowCode,
      raw,
      params.flowSessionId
    );
  }

  return {
    getConversationFlowState,
    processInteractiveReply,
    processTextReply,
    processImageReply,
    advanceConversationToNode,
    sendCurrentFlowNode,
    ensureCurrentNodePresentedAfterInbound,
    loadHydratedFlowSessionData,
  };
}

export async function getConversationFlowState(
  supabase: SupabaseAdmin,
  conversationId: string
) {
  return createFlowEngine({ supabase }).getConversationFlowState(conversationId);
}

export async function processInteractiveReply(
  supabase: SupabaseAdmin,
  params: ProcessInteractiveReplyParams
) {
  return createFlowEngine({ supabase }).processInteractiveReply(params);
}

export async function advanceConversationToNode(
  supabase: SupabaseAdmin,
  params: AdvanceConversationParams
) {
  return createFlowEngine({ supabase }).advanceConversationToNode(params);
}

export async function processTextReply(
  supabase: SupabaseAdmin,
  params: ProcessTextReplyParams
) {
  return createFlowEngine({ supabase }).processTextReply(params);
}

export async function processImageReply(
  supabase: SupabaseAdmin,
  params: ProcessImageReplyParams
) {
  return createFlowEngine({ supabase }).processImageReply(params);
}

export async function sendCurrentFlowNode(
  supabase: SupabaseAdmin,
  params: SendCurrentNodeParams
) {
  return createFlowEngine({ supabase }).sendCurrentFlowNode(params);
}

export async function ensureCurrentNodePresentedAfterInbound(
  supabase: SupabaseAdmin,
  params: EnsureInboundPresentParams
): Promise<EnsureInboundPresentResult> {
  return createFlowEngine({ supabase }).ensureCurrentNodePresentedAfterInbound(params);
}

export async function loadHydratedFlowSessionData(
  supabase: SupabaseAdmin,
  params: {
    empresaId: string;
    conversationId: string;
    flowCode: string;
    flowSessionId: string;
  }
): Promise<Record<string, string>> {
  return createFlowEngine({ supabase }).loadHydratedFlowSessionData(params);
}
