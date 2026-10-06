import {
  provisionChannelFromWebhookEnv,
  type WebhookProvisionEnv,
} from "@/lib/chat/channel-provision";
import { createFlowEngine, logFlowStateTransition } from "@/lib/chat/flow-engine-service";
import { isTransientWebhookError } from "@/lib/chat/webhooks/webhook-transient-error";
import { flowTrace } from "@/lib/chat/flow-trace-log";
import { persistInboundChatMessageAndBump } from "@/lib/chat/incoming-message-service";
import { isSingleClientMode } from "@/lib/instance/single-client";
import { assignConversation } from "@/lib/chat/assign-conversation-service";
import { assignConversationPg } from "@/lib/chat/webhooks/assign-conversation-pg";
import { createTenantPgChatSupabaseShim } from "@/lib/chat/tenant-pg-chat-supabase-shim";
import { ensureCentralChatChannelMirror } from "@/lib/chat/central-chat-channel-mirror";
import { ensureCentralChatContactMirror } from "@/lib/chat/central-chat-contact-mirror";
import { ensureCentralChatConversationMirror } from "@/lib/chat/central-chat-conversation-mirror";
import {
  fetchOmnichannelRouteByMetaPhone,
  syncOmnichannelRouteForWhatsappChannel,
} from "@/lib/chat/omnichannel-route-sync";
import { createWhatsappConversationWithActiveFlow } from "@/lib/chat/whatsapp-conversation-bootstrap";
import { ensureActiveFlowSessionForConversation } from "@/lib/chat/flow-session-service";
import {
  resolveOutboundTextContextFromConversationId,
  sendOutboundTextMessage,
} from "@/lib/chat/conversation-send-context";
import { attachInboundMessageMedia } from "@/lib/chat/inbound-media-attach";
import { fetchChatChannelConfigForWebhookWakeKeywords } from "@/lib/chat/fetch-channel-config-webhook";
import {
  maybeRestartForPurchaseIntent,
  PAID_PURCHASE_PENDING_ORDER_REASON,
} from "@/lib/chat/flow-restart-intent";
import { findPaidPurchasePendingOrder, PAID_PURCHASE_RESUME_NOTICE } from "@/lib/chat/paid-purchase-guard";
import {
  CONV_LOG,
  checkFlowKnownAndActiveInCatalog,
  checkNodeActiveInFlow,
  matchesConversationRestartKeyword,
  matchesHumanHandoffKeyword,
  restartWhatsappConversationToFlowStart,
  syncWhatsappConversationFlowFromCatalog,
  WEBHOOK_IMMEDIATE_HANDOFF_BUTTON_IDS,
} from "@/lib/chat/resolve-whatsapp-active-flow";
import { runWhatsappBusinessAutomationAfterInbound } from "@/lib/chat/channel-business-automation-runtime";
import { ensureWhatsappInboundCrmLeadPg } from "@/lib/crm/whatsapp-inbound-lead-pg";
import { ensureWhatsappInboundCrmProspecto } from "@/lib/crm/whatsapp-inbound-lead";
import type {
  MetaInboundMessage,
  MetaWebhookValue,
  ProcessWebhookResult,
  SupabaseAdmin,
} from "@/lib/chat/types";
import { normalizeWaPhone } from "@/lib/chat/wa-phone";
import { applySorteoReferralToActiveSession } from "@/lib/sorteos/referral-attribution";
import { markCampaignReplyFromInbound } from "@/lib/campaigns/campaign-inbound-hook";
import { executeCampaignButtonActionForMatchedRecipient } from "@/lib/campaigns/campaign-button-action-service";
import {
  createServiceRoleClientWithDbSchema,
  fetchDataSchemaForEmpresaId,
} from "@/lib/supabase/empresa-data-schema";
import { getChatPostgresPool, quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";
import {
  SUPABASE_APP_SCHEMA,
  resolveEmpresaDataSchema,
  type AppSupabaseClient,
} from "@/lib/supabase/schema";
import type { Pool } from "pg";
import {
  assertAllowedChatDataSchema,
  isLikelyUnexposedTenantChatSchema,
} from "@/lib/supabase/chat-data-schema";
import {
  collectMetaWebhookStatusValues,
  compactMetaStatusPayload,
  firstMetaStatusError,
  metaStatusTimestampToIso,
  normalizeMetaWhatsappStatus,
  recordFromUnknown,
  shouldApplyWhatsappStatus,
  type MetaWebhookStatusValue,
  type MetaWhatsappStatus,
  type MetaWhatsappStatusName,
} from "@/lib/chat/meta-whatsapp-status";

export { normalizeWaPhone } from "@/lib/chat/wa-phone";

const WH_RESOLVE = "[webhooks/whatsapp][resolve_channel]";
const WH_CONTACT = "[webhooks/whatsapp][upsert_contact]";
const WH_CONV = "[webhooks/whatsapp][upsert_conversation]";
const WH_MSG = "[webhooks/whatsapp][insert_message]";
const WH_FLOW = "[webhooks/whatsapp][flow_session]";
const WH_STATUS = "[whatsapp-status]";

/**
 * Claim gate contra duplicación por reintentos de Meta. Meta reintenta el webhook si tarda,
 * y el chequeo `messageExists()` (SELECT sin lock) deja pasar reintentos paralelos → el motor
 * corre 2-5 veces → el cliente recibe la bienvenida/combos duplicados.
 * Con el gate activo, el early-persist (INSERT idempotente sobre `wa_message_id`) decide:
 * el que gana el insert procesa; el que pierde (`duplicate`) es un reintento y NO ejecuta el motor.
 * `WEBHOOK_CLAIM_GATE_ENABLED=false` lo desactiva (rollback instantáneo, sin deploy).
 * (Portado de Mevo.)
 */
const WEBHOOK_CLAIM_GATE_ENABLED = process.env.WEBHOOK_CLAIM_GATE_ENABLED !== "false";

function contactNameForWa(
  contacts: MetaWebhookValue["contacts"],
  waId: string
): string | null {
  if (!contacts?.length) return null;
  const norm = normalizeWaPhone(waId);
  const c = contacts.find((x) => x.wa_id && normalizeWaPhone(x.wa_id) === norm);
  return c?.profile?.name?.trim() || null;
}

/** Tipos Meta que pueden aportar media descargable para comprobante / image_input. */
function isComprobanteMediaMessageKind(msg: MetaInboundMessage): boolean {
  const t = (msg.type ?? "").trim().toLowerCase();
  return t === "image" || t === "document" || t === "sticker";
}

/** Solo nombres de claves de primer nivel (sin valores). */
function metaInboundMessageTopLevelKeys(msg: MetaInboundMessage): string[] {
  return typeof msg === "object" && msg !== null ? Object.keys(msg as object).sort() : [];
}

export function extractMessageBody(msg: MetaInboundMessage): { message_type: string; content: string } {
  const t = (msg.type ?? "unknown").trim().toLowerCase();
  switch (t) {
    case "text":
      return { message_type: "text", content: msg.text?.body ?? "" };
    case "image":
      return {
        message_type: "image",
        content: msg.image?.caption?.trim() || "[imagen]",
      };
    case "document":
      return {
        message_type: "document",
        content:
          msg.document?.caption?.trim() ||
          msg.document?.filename ||
          "[documento]",
      };
    case "audio":
      return { message_type: "audio", content: "[audio]" };
    case "video":
      return {
        message_type: "video",
        content: msg.video?.caption?.trim() || "[video]",
      };
    case "sticker":
      return { message_type: "sticker", content: "[sticker]" };
    case "button": {
      const b = msg.button;
      const label =
        b?.text?.trim() || b?.payload?.trim() || "[button]";
      return { message_type: "button", content: label };
    }
    case "interactive": {
      const button = msg.interactive?.button_reply;
      if (button?.id) {
        return {
          message_type: "interactive",
          content: button.title?.trim() || `[button:${button.id}]`,
        };
      }
      const list = msg.interactive?.list_reply;
      if (list?.id) {
        return {
          message_type: "interactive",
          content: list.title?.trim() || `[list:${list.id}]`,
        };
      }
      return { message_type: "interactive", content: "[interactive]" };
    }
    default:
      return { message_type: (msg.type ?? "unknown").trim() || "unknown", content: `[${t}]` };
  }
}

/**
 * Media descargable para nodo `image_input` / comprobante.
 * Meta suele mandar fotos como `image`, pero muchos usuarios envían PDF o imagen como `document`.
 */
export function extractInboundComprobanteMedia(msg: MetaInboundMessage): {
  mediaId: string;
  mimeType: string | null;
  caption: string | null;
  sourceType: "image" | "document" | "sticker";
} | null {
  const t = (msg.type ?? "").trim().toLowerCase();
  if (t === "image") {
    const mediaId = msg.image?.id?.trim();
    if (!mediaId) {
      console.info("[flow-image-input]", "[skipped-reason]", "media_id_missing", {
        msgType: msg.type ?? null,
        normalizedType: t,
        keysPresent: metaInboundMessageTopLevelKeys(msg),
      });
      return null;
    }
    return {
      mediaId,
      mimeType: msg.image?.mime_type?.trim() || null,
      caption: msg.image?.caption?.trim() || null,
      sourceType: "image",
    };
  }
  if (t === "document") {
    const doc = msg.document;
    const mediaId = doc?.id?.trim();
    if (!mediaId) {
      console.info("[flow-image-input]", "[skipped-reason]", "media_id_missing", {
        msgType: msg.type ?? null,
        normalizedType: t,
        keysPresent: metaInboundMessageTopLevelKeys(msg),
      });
      return null;
    }
    return {
      mediaId,
      mimeType: doc?.mime_type?.trim() || null,
      caption: doc?.caption?.trim() || null,
      sourceType: "document",
    };
  }
  if (t === "sticker") {
    const mediaId = msg.sticker?.id?.trim();
    if (!mediaId) {
      console.info("[flow-image-input]", "[skipped-reason]", "media_id_missing", {
        msgType: msg.type ?? null,
        normalizedType: t,
        keysPresent: metaInboundMessageTopLevelKeys(msg),
      });
      return null;
    }
    return {
      mediaId,
      mimeType: null,
      caption: null,
      sourceType: "sticker",
    };
  }
  return null;
}

/** Evita reprocesar la misma imagen si ya hay image_received con este wa_message_id (reintentos webhook). */
async function flowImageInboundAlreadyRecorded(
  supabase: SupabaseAdmin,
  conversationId: string,
  waMessageId: string
): Promise<boolean> {
  const { data: rows, error } = await supabase
    .from("chat_flow_events")
    .select("payload")
    .eq("conversation_id", conversationId)
    .eq("event_type", "image_received")
    .order("created_at", { ascending: false })
    .limit(25);
  if (error || !rows?.length) return false;
  return rows.some((r) => {
    const p = r.payload as Record<string, unknown> | null | undefined;
    return typeof p?.wa_message_id === "string" && p.wa_message_id === waMessageId;
  });
}

function extractMetaButtonId(msg: MetaInboundMessage): string | null {
  const buttonId = msg.interactive?.button_reply?.id?.trim();
  if (buttonId) return buttonId;
  const listId = msg.interactive?.list_reply?.id?.trim();
  if (listId) return listId;
  const msgType = (msg.type ?? "").trim().toLowerCase();
  if (msgType === "button") {
    const b = msg.button;
    const id = b?.payload?.trim() || b?.text?.trim();
    if (id) return id;
  }
  return null;
}

/**
 * ¿Ya está guardado este wa_message_id? `error` != null si la LECTURA falló: antes se tomaba
 * como "no existe" y un corte de Supabase podía reprocesar un mensaje ya guardado.
 */
async function messageExists(
  supabase: SupabaseAdmin,
  waMessageId: string
): Promise<{ exists: boolean; error: string | null }> {
  const { data, error } = await supabase
    .from("chat_messages")
    .select("id")
    .eq("wa_message_id", waMessageId)
    .maybeSingle();
  if (error) return { exists: false, error: error.message ?? "error" };
  return { exists: !!data?.id, error: null };
}

/**
 * Nodos de captura de dato donde un TEXTO del cliente ES la respuesta. Si un mensaje quedó guardado
 * pero SIN procesar (la 1ª entrega murió a mitad por timeout bajo carga) y Meta lo reenvía, el dedupe
 * normal lo descartaba y el cliente quedaba mudo. Acá lo recuperamos SOLO en estos nodos.
 */
const WHATSAPP_CAPTURE_NODE_CODES = new Set([
  "cedula",
  "primer_nombre",
  "primer_apellido",
  "ciudad",
  "solicitud_de_nro_de_celular",
  "nombre_y_apellido",
]);

/**
 * Recuperación de "respuesta de captura perdida por reintento de Meta": cuando un texto YA existe
 * (Meta reintenta) pero la conversación sigue parada en un nodo de captura y ESTE wa_message_id nunca
 * se capturó, la 1ª entrega murió antes de procesar. Reprocesamos SOLO el motor de texto (no la
 * bienvenida/reinicio → sin doble welcome). Idempotente y ultra-defensivo: ante cualquier duda
 * devuelve false y el llamador hace el `skip` de siempre (comportamiento actual, cero riesgo nuevo).
 */
async function maybeRecoverUnprocessedCaptureText(params: {
  supabase: SupabaseAdmin;
  empresaId: string;
  channelId: string;
  fromPhone: string;
  waMessageId: string;
  textValue: string;
  rawMsg: Record<string, unknown>;
}): Promise<boolean> {
  const { supabase, empresaId, channelId, fromPhone, waMessageId, textValue, rawMsg } = params;
  try {
    if (!textValue.trim()) return false;
    const { data: contact } = await supabase
      .from("chat_contacts")
      .select("id")
      .eq("empresa_id", empresaId)
      .eq("phone_number", fromPhone)
      .maybeSingle();
    const contactId = (contact as { id?: string } | null)?.id;
    if (!contactId) return false;
    const { data: conv } = await supabase
      .from("chat_conversations")
      .select("id, flow_current_node, flow_status, human_taken_over, active_flow_session_id")
      .eq("contact_id", contactId)
      .eq("channel_id", channelId)
      .maybeSingle();
    const co = conv as
      | {
          id?: string;
          flow_current_node?: string | null;
          flow_status?: string | null;
          human_taken_over?: boolean | null;
          active_flow_session_id?: string | null;
        }
      | null;
    if (!co?.id) return false;
    // Solo en modo bot y parado en un nodo de captura.
    if (co.human_taken_over || String(co.flow_status ?? "bot").toLowerCase() === "human") return false;
    const node = String(co.flow_current_node ?? "").trim();
    if (!WHATSAPP_CAPTURE_NODE_CODES.has(node)) return false;
    // ¿Este mismo mensaje ya se capturó? (la 1ª entrega SÍ terminó) → no recuperar, dejar skip.
    const sid = co.active_flow_session_id?.trim();
    if (sid) {
      const { data: already } = await supabase
        .from("chat_flow_events")
        .select("id")
        .eq("conversation_id", co.id)
        .eq("flow_session_id", sid)
        .eq("event_type", "text_captured")
        .contains("payload", { raw: { id: waMessageId } })
        .limit(1);
      if (Array.isArray(already) && already.length > 0) return false;
    }
    // Reprocesar SOLO el motor de texto (no reinicio/bienvenida). El guard de idempotencia por
    // wa_message_id dentro de processTextReply es la segunda red de seguridad.
    const flowEngine = createFlowEngine({ supabase });
    const res = await flowEngine.processTextReply({
      conversationId: co.id,
      empresaId,
      textValue,
      rawPayload: rawMsg,
    });
    console.info("[webhooks/whatsapp]", "recovered_unprocessed_capture_text", {
      conversationId: co.id,
      node,
      waMessageId,
      status: res.status,
      ok: res.ok,
    });
    try {
      await supabase.from("chat_flow_events").insert({
        empresa_id: empresaId,
        conversation_id: co.id,
        flow_code: null,
        node_code: node,
        flow_session_id: sid ?? null,
        event_type: "recovered_capture_on_retry",
        payload: { wa_message_id: waMessageId, status: res.status, ok: res.ok },
      });
    } catch {
      /* no-op */
    }
    return true;
  } catch (e) {
    console.warn("[webhooks/whatsapp]", "recover_unprocessed_capture_text_failed", {
      waMessageId,
      err: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
}

type WhatsappChannelRow = {
  id: string;
  empresa_id: string;
  meta_phone_number_id: string;
  activo: boolean | null;
};

type StatusChannelContext = {
  channel: WhatsappChannelRow;
  empresaId: string;
  dataSchema: string;
  useTenantPg: boolean;
  pool: Pool | null;
  supabase: SupabaseAdmin;
};

/**
 * Si el canal vive en un esquema tenant distinto de `zentra_erp` (`er_*`, `erp_*`, etc.) pero falta
 * la fila en `zentra_erp.omnichannel_routes`, el webhook solo miraba `zentra_erp.chat_channels` y fallaba.
 * Recorremos empresas con `data_schema` no vacío (valor real en `empresas`) y buscamos el canal ahí.
 */
const BLOCKED_DATA_SCHEMA_NAMES = new Set(
  ["public", "pg_catalog", "information_schema"].map((s) => s.toLowerCase())
);

async function pgLoadWhatsappChannelById(
  pool: Pool,
  schemaRaw: string,
  channelId: string,
  empresaId: string
): Promise<WhatsappChannelRow | null> {
  const schema = assertAllowedChatDataSchema(schemaRaw);
  const qt = quoteSchemaTable(schema, "chat_channels");
  const r = await pool.query(
    `SELECT id::text, empresa_id::text, meta_phone_number_id::text, activo
     FROM ${qt}
     WHERE id = $1::uuid AND empresa_id = $2::uuid
     LIMIT 1`,
    [channelId, empresaId]
  );
  const row = r.rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: String(row.id),
    empresa_id: String(row.empresa_id),
    meta_phone_number_id: String(row.meta_phone_number_id ?? ""),
    activo: row.activo === null || row.activo === undefined ? null : Boolean(row.activo),
  };
}

async function findWhatsappChannelInTenantSchemas(
  catalogSupabase: SupabaseAdmin,
  phoneNumberId: string
): Promise<{ channel: WhatsappChannelRow; dataSupabase: SupabaseAdmin; dataSchema: string } | null> {
  const pool = getChatPostgresPool();
  const { data: empresas, error } = await catalogSupabase
    .from("empresas")
    .select("id, data_schema")
    .not("data_schema", "is", null);

  if (error) {
    console.error("[webhook] listar empresas (data_schema):", error.message);
    return null;
  }

  for (const e of (empresas ?? []) as Array<{ id: string; data_schema: string | null }>) {
    const schema = resolveEmpresaDataSchema(e.data_schema);
    if (schema === SUPABASE_APP_SCHEMA) continue;
    if (BLOCKED_DATA_SCHEMA_NAMES.has(schema.toLowerCase())) {
      console.warn("[webhook] scan tenant: omitiendo data_schema reservado", {
        empresa_id: e.id,
        schema,
      });
      continue;
    }

    if (pool && isLikelyUnexposedTenantChatSchema(schema)) {
      console.info(WH_RESOLVE, "scan_tenant_pg", { schema, empresa_id: e.id, phoneNumberId });
      try {
        const sch = assertAllowedChatDataSchema(schema);
        const qt = quoteSchemaTable(sch, "chat_channels");
        const r = await pool.query(
          `SELECT id::text, empresa_id::text, meta_phone_number_id::text, activo
           FROM ${qt}
           WHERE meta_phone_number_id = $1 AND empresa_id = $2::uuid
           LIMIT 1`,
          [phoneNumberId, e.id]
        );
        const row = r.rows[0] as Record<string, unknown> | undefined;
        if (row) {
          const channel: WhatsappChannelRow = {
            id: String(row.id),
            empresa_id: String(row.empresa_id),
            meta_phone_number_id: String(row.meta_phone_number_id ?? ""),
            activo: row.activo === null || row.activo === undefined ? null : Boolean(row.activo),
          };
          return {
            channel,
            dataSupabase: catalogSupabase,
            dataSchema: schema,
          };
        }
      } catch (err) {
        console.warn(WH_RESOLVE, "scan_tenant_pg_error", {
          schema,
          err: err instanceof Error ? err.message : String(err),
        });
      }
      continue;
    }

    const tenantSb = createServiceRoleClientWithDbSchema(schema) as SupabaseAdmin;
    const { data: ch, error: chErr } = await tenantSb
      .from("chat_channels")
      .select("id, empresa_id, meta_phone_number_id, activo")
      .eq("meta_phone_number_id", phoneNumberId)
      .eq("empresa_id", e.id)
      .maybeSingle();

    if (chErr) {
      console.warn("[webhook] scan tenant chat_channels", { schema, err: chErr.message });
      continue;
    }
    if (ch) {
      return {
        channel: ch as WhatsappChannelRow,
        dataSupabase: tenantSb,
        dataSchema: schema,
      };
    }
  }
  return null;
}

/**
 * ¿El fallo al procesar un texto del flujo es transitorio (vale reintentar en el mismo request)?
 * Bajo carga, el procesamiento del dato puede fallar por PostgREST/red; si se traga, el cliente
 * queda mudo (la app responde 200 a Meta y Meta no reenvía). El reintento es seguro por el guard
 * de idempotencia por wa_message_id dentro de processTextReply.
 */
function isTransientFlowTextFailure(status?: string, error?: string | null): boolean {
  const st = (status ?? "").trim();
  if (
    st === "exception" ||
    st === "save_text_failed" ||
    st === "advance_failed" ||
    st === "send_next_node_failed" ||
    st === "idempotency_check_failed" ||
    st === "duplicate_capture_resend_failed"
  ) {
    return true;
  }
  const msg = (error ?? "").toLowerCase();
  if (!msg) return false;
  return (
    msg.includes("schema cache") ||
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("fetch failed") ||
    msg.includes("econn") ||
    msg.includes("socket") ||
    msg.includes("network") ||
    msg.includes("503") ||
    msg.includes("502") ||
    msg.includes("500") ||
    msg.includes("could not query the database")
  );
}

/**
 * Procesa mensajes entrantes de un único `value` de Meta (un change).
 */
export async function processInboundWebhookValue(
  catalogSupabase: SupabaseAdmin,
  value: MetaWebhookValue,
  provisionEnv?: WebhookProvisionEnv
): Promise<ProcessWebhookResult> {
  const errors: string[] = [];
  let processed = 0;
  let skipped = 0;
  let inboundDurableWrite = false;

  const phoneNumberId = value.metadata?.phone_number_id?.trim();
  if (!phoneNumberId) {
    return {
      ok: false,
      processed: 0,
      skipped: 0,
      errors: ["Falta metadata.phone_number_id"],
    };
  }

  let dataSupabase: SupabaseAdmin = catalogSupabase;
  let channel: WhatsappChannelRow | null = null;

  const routeRow = await fetchOmnichannelRouteByMetaPhone(catalogSupabase, phoneNumberId);
  const pool = getChatPostgresPool();

  if (routeRow) {
    const r = routeRow;
    const schema = resolveEmpresaDataSchema(r.data_schema || null);
    console.info(WH_RESOLVE, "omnichannel_route", { schema, channel_id: r.channel_id, empresa_id: r.empresa_id });

    if (pool && isLikelyUnexposedTenantChatSchema(schema) && schema !== SUPABASE_APP_SCHEMA) {
      const chPg = await pgLoadWhatsappChannelById(pool, schema, r.channel_id, r.empresa_id);
      if (!chPg || chPg.empresa_id !== r.empresa_id) {
        return {
          ok: false,
          processed: 0,
          skipped: 0,
          errors: [
            "Ruta omnicanal inconsistente: canal no encontrado en Postgres o empresa distinta (tenant no expuesto).",
          ],
        };
      }
      channel = chPg;
      dataSupabase = catalogSupabase;
    } else {
      dataSupabase =
        schema === SUPABASE_APP_SCHEMA
          ? catalogSupabase
          : (createServiceRoleClientWithDbSchema(schema) as SupabaseAdmin);
      const { data: chT, error: errT } = await dataSupabase
        .from("chat_channels")
        .select("id, empresa_id, meta_phone_number_id, activo")
        .eq("id", r.channel_id)
        .maybeSingle();
      if (errT) {
        return {
          ok: false,
          processed: 0,
          skipped: 0,
          errors: [errT.message],
        };
      }
      const row = chT as WhatsappChannelRow | null;
      if (!row || row.empresa_id !== r.empresa_id) {
        return {
          ok: false,
          processed: 0,
          skipped: 0,
          errors: ["Ruta omnicanal inconsistente: canal no encontrado o empresa distinta."],
        };
      }
      channel = row;
    }
  } else {
    const { data: ch0, error: chErr } = await catalogSupabase
      .from("chat_channels")
      .select("id, empresa_id, meta_phone_number_id, activo")
      .eq("meta_phone_number_id", phoneNumberId)
      .maybeSingle();

    if (chErr) {
      return {
        ok: false,
        processed: 0,
        skipped: 0,
        errors: [chErr.message],
      };
    }

    channel = ch0 as WhatsappChannelRow | null;
    dataSupabase = catalogSupabase;

    if (!channel) {
      const tenantHit = await findWhatsappChannelInTenantSchemas(catalogSupabase, phoneNumberId);
      if (tenantHit) {
        channel = tenantHit.channel;
        dataSupabase = tenantHit.dataSupabase;
        try {
          await syncOmnichannelRouteForWhatsappChannel({
            metaPhoneNumberId: phoneNumberId,
            empresaId: tenantHit.channel.empresa_id,
            channelId: tenantHit.channel.id,
            activo: tenantHit.channel.activo !== false,
            dataSchema: tenantHit.dataSchema,
          });
        } catch (e) {
          console.warn(
            "[webhook] no se pudo reparar omnichannel_routes (el mensaje sigue con el canal encontrado):",
            e instanceof Error ? e.message : e
          );
        }
      }
    }

    if (!channel && provisionEnv) {
      await provisionChannelFromWebhookEnv(catalogSupabase, phoneNumberId, provisionEnv);
      const routeAfter = await fetchOmnichannelRouteByMetaPhone(catalogSupabase, phoneNumberId);

      if (routeAfter) {
        const r = routeAfter;
        const schema = resolveEmpresaDataSchema(r.data_schema || null);
        console.info(WH_RESOLVE, "provision_route", { schema, channel_id: r.channel_id });

        if (pool && isLikelyUnexposedTenantChatSchema(schema) && schema !== SUPABASE_APP_SCHEMA) {
          channel = await pgLoadWhatsappChannelById(pool, schema, r.channel_id, r.empresa_id);
          dataSupabase = catalogSupabase;
        } else {
          dataSupabase =
            schema === SUPABASE_APP_SCHEMA
              ? catalogSupabase
              : (createServiceRoleClientWithDbSchema(schema) as SupabaseAdmin);
          const { data: chTenant } = await dataSupabase
            .from("chat_channels")
            .select("id, empresa_id, meta_phone_number_id, activo")
            .eq("id", r.channel_id)
            .maybeSingle();
          channel = chTenant as WhatsappChannelRow | null;
        }
      } else {
        const { data: ch1 } = await catalogSupabase
          .from("chat_channels")
          .select("id, empresa_id, meta_phone_number_id, activo")
          .eq("meta_phone_number_id", phoneNumberId)
          .maybeSingle();
        channel = ch1 as WhatsappChannelRow | null;
        dataSupabase = catalogSupabase;
      }
    }
  }

  if (channel && channel.activo === false) {
    return {
      ok: false,
      processed: 0,
      skipped: 0,
      errors: [
        "El canal WhatsApp está desactivado. Activalo en Conversaciones → Configuración.",
      ],
    };
  }

  if (!channel) {
    return {
      ok: false,
      processed: 0,
      skipped: 0,
      errors: [
        `Canal no registrado para phone_number_id=${phoneNumberId}. Configurá el canal en el ERP (Conversaciones → Configuración) o definí WHATSAPP_DEFAULT_EMPRESA_ID y WHATSAPP_PHONE_NUMBER_ID (mismo ID que en Meta) en el servidor.`,
      ],
    };
  }

  const empresaId = channel.empresa_id as string;
  const tenantDataSchema = await fetchDataSchemaForEmpresaId(empresaId);
  const useTenantPg = Boolean(pool && isLikelyUnexposedTenantChatSchema(tenantDataSchema));

  if (useTenantPg && pool) {
    console.info(WH_RESOLVE, "sanity_pg", {
      tenantDataSchema,
      channel_id: channel.id,
      empresa_id: empresaId,
    });
    try {
      const qt = quoteSchemaTable(assertAllowedChatDataSchema(tenantDataSchema), "chat_channels");
      const rs = await pool.query(
        `SELECT id::text FROM ${qt} WHERE id = $1::uuid AND empresa_id = $2::uuid LIMIT 1`,
        [channel.id, empresaId]
      );
      if (!rs.rows?.length) {
        return {
          ok: false,
          processed: 0,
          skipped: 0,
          errors: [
            `Canal ${channel.id} no existe en Postgres (${tenantDataSchema}) para empresa ${empresaId}.`,
          ],
        };
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(WH_RESOLVE, "sanity_pg_error", msg);
      return {
        ok: false,
        processed: 0,
        skipped: 0,
        errors: [`sanity_pg chat_channels: ${msg}`],
      };
    }
  } else {
    const { data: channelSanity, error: chSanErr } = await dataSupabase
      .from("chat_channels")
      .select("id")
      .eq("id", channel.id)
      .eq("empresa_id", empresaId)
      .maybeSingle();
    if (chSanErr || !channelSanity) {
      return {
        ok: false,
        processed: 0,
        skipped: 0,
        errors: [
          `Canal ${channel.id} no existe en el schema PostgREST usado para chat_* (FK o data_schema inconsistente). Revisá migración supabase 20260411190000 y coherencia de empresas.data_schema. ${chSanErr?.message ?? ""}`,
        ],
      };
    }
  }

  const legacyTenantChat =
    tenantDataSchema === SUPABASE_APP_SCHEMA
      ? catalogSupabase
      : (createServiceRoleClientWithDbSchema(tenantDataSchema) as SupabaseAdmin);

  /** Cliente tenant: shim Postgres cuando `erp_*`/`er_*` no está expuesto en PostgREST; si no, PostgREST legacy. */
  const supabase: SupabaseAdmin =
    useTenantPg && pool
      ? createTenantPgChatSupabaseShim({
          pool,
          schema: tenantDataSchema,
          storageDelegate: catalogSupabase,
          rpcDelegate: catalogSupabase as AppSupabaseClient,
        })
      : legacyTenantChat;

  console.info("[webhooks/whatsapp]", "persist_engine", {
    modo: useTenantPg ? "postgres_directo_shim" : "postgrest_legacy",
    data_schema: tenantDataSchema,
    empresa_id: empresaId,
  });

  const channelId = channel.id as string;
  const channelWakeConfig = await fetchChatChannelConfigForWebhookWakeKeywords({
    pool: pool ?? null,
    useTenantPg,
    tenantDataSchema,
    empresaId,
    channelId,
    supabase,
  });
  const messages = value.messages ?? [];

  for (const msg of messages) {
    const from = msg.from ? normalizeWaPhone(msg.from) : "";
    const waMid = msg.id?.trim();
    if (!from || !waMid) {
      skipped += 1;
      errors.push("Mensaje sin from o id");
      continue;
    }

    const existsCheck = await messageExists(supabase, waMid);
    if (existsCheck.error && isTransientWebhookError(existsCheck.error)) {
      // Supabase caído un momento: no sabemos si ya está guardado → cortar antes de escribir
      // nada; el handler responde 503 y Meta reintenta. Otros errores siguen como antes.
      errors.push(`Mensaje entrante (lectura): ${existsCheck.error}`);
      continue;
    }
    const messageAlreadyExists = existsCheck.exists;
    let inboundMessageAlreadyPersisted = messageAlreadyExists;
    if (messageAlreadyExists) inboundDurableWrite = true;

    /**
     * Antes se hacía `continue` en cualquier mensaje ya persistido (no media): Meta reintenta webhooks
     * y hay carreras en el insert. Si el primer request solo guardó la fila y falló después, el reintento
     * nunca corría `markCampaignReplyFromInbound` ni `executeCampaignButtonAction…`.
     * Los clics de plantilla (`button` / `interactive` con reply) deben reprocesar routing siempre.
     */
    const msgTypeInbound = (msg.type ?? "").trim().toLowerCase();
    const mustRetryInboundRoutingDespiteDedupe =
      msgTypeInbound === "button" ||
      (msgTypeInbound === "interactive" &&
        Boolean(
          (msg as MetaInboundMessage).interactive?.button_reply ||
            (msg as MetaInboundMessage).interactive?.list_reply
        ));
    if (
      messageAlreadyExists &&
      !isComprobanteMediaMessageKind(msg) &&
      !mustRetryInboundRoutingDespiteDedupe
    ) {
      /**
       * CAUSA RAÍZ del "bot mudo": bajo carga la 1ª entrega guarda el mensaje pero muere a mitad de
       * procesar (timeout → 499 en kong); Meta reenvía y este dedupe lo descartaba → cliente mudo.
       * Antes de descartar, intentamos recuperar SOLO si es una respuesta de captura nunca procesada.
       */
      if (msgTypeInbound === "text") {
        const { content: recContent } = extractMessageBody(msg);
        const recovered = await maybeRecoverUnprocessedCaptureText({
          supabase,
          empresaId,
          channelId,
          fromPhone: from,
          waMessageId: waMid,
          textValue: recContent,
          rawMsg: msg as unknown as Record<string, unknown>,
        });
        if (recovered) {
          processed += 1;
          continue;
        }
      }
      skipped += 1;
      continue;
    }

    if (isComprobanteMediaMessageKind(msg)) {
      console.info("[flow-image-input]", "[precheck]", {
        waMessageId: waMid,
        msgType: (msg.type ?? "") || null,
        hasImageId: Boolean(msg.image?.id?.trim()),
        hasDocumentId: Boolean(msg.document?.id?.trim()),
        hasStickerId: Boolean(msg.sticker?.id?.trim()),
        messageAlreadyExists,
        willAllowFlowProcessing: !messageAlreadyExists || inboundMessageAlreadyPersisted,
      });
    }

    const displayName = contactNameForWa(value.contacts, from) ?? from;

    /** Hoisted para el catch: permite re-presentar y registrar diagnóstico aunque la excepción
     * ocurra en un paso intermedio (antes de llegar a processTextReply). */
    let diagConversationId: string | null = null;
    const diagIsTextMsg = String(msg.type ?? "").trim().toLowerCase() === "text";

    try {
      console.info(WH_CONTACT, "upsert_start", { empresaId, phone: from, useTenantPg });
      const { data: contact, error: cErr } = await supabase
        .from("chat_contacts")
        .upsert(
          {
            empresa_id: empresaId,
            phone_number: from,
            phone_normalized: from,
            name: displayName,
          },
          { onConflict: "empresa_id,phone_number" }
        )
        .select("id, name, crm_prospecto_id")
        .single();

      if (cErr || !contact) {
        console.warn(WH_CONTACT, "upsert_error", { err: cErr?.message ?? "error" });
        errors.push(`Contacto: ${cErr?.message ?? "error"}`);
        continue;
      }
      console.info(WH_CONTACT, "upsert_ok", { contact_id: (contact as { id?: string }).id });

      const contactId = contact.id as string;

      await ensureCentralChatChannelMirror({
        pool: pool ?? null,
        tenantDataSchema,
        empresaId,
        channelId,
      });
      await ensureCentralChatContactMirror({
        pool: pool ?? null,
        tenantDataSchema,
        empresaId,
        contactId,
      });

      if (displayName && displayName !== contact.name) {
        await supabase
          .from("chat_contacts")
          .update({ name: displayName, updated_at: new Date().toISOString() })
          .eq("id", contactId);
      }

      console.info(WH_CONV, "lookup_open", { contact_id: contactId, channel_id: channelId });
      let { data: existingConv } = await supabase
        .from("chat_conversations")
        .select(
          "id, status, unread_count, flow_code, flow_current_node, flow_status, human_taken_over, active_flow_session_id"
        )
        .eq("contact_id", contactId)
        .eq("channel_id", channelId)
        .maybeSingle();

      const { message_type, content } = extractMessageBody(msg);
      const preview = content.slice(0, 280);
      const ts = msg.timestamp
        ? new Date(parseInt(msg.timestamp, 10) * 1000).toISOString()
        : new Date().toISOString();

      if (!existingConv) {
        console.info(WH_CONV, "bootstrap_new", { contact_id: contactId, channel_id: channelId });
        const { conv, error: bootErr } = await createWhatsappConversationWithActiveFlow(
          supabase,
          empresaId,
          channelId,
          contactId
        );
        if (bootErr) {
          console.warn(WH_CONV, "bootstrap_error", bootErr);
          errors.push(`Conversación: ${bootErr}`);
          continue;
        }
        if (conv) existingConv = conv;
      }

      if (!existingConv) {
        errors.push("Conversación: no encontrada");
        continue;
      }

      const conversationId = existingConv.id as string;
      diagConversationId = conversationId;

      /**
       * Early-persist (single_client): guardar el inbound INMEDIATAMENTE (idempotente), antes de
       * restart-intent / CRM / flow-engine, para que el mensaje del usuario quede en chat_messages
       * aunque un paso posterior tire excepción. persistInboundChatMessageAndBump rutea por PG directo
       * en single_client y tolera duplicados (23505). El bloque de persistencia posterior detecta
       * `inboundMessageAlreadyPersisted` y reutiliza la fila (no doble-inserta).
       */
      if (isSingleClientMode() && !inboundMessageAlreadyPersisted) {
        const early = await persistInboundChatMessageAndBump({
          supabase,
          empresaId,
          conversationId,
          externalMessageId: waMid,
          messageType: message_type,
          content,
          rawPayload: msg as unknown as Record<string, unknown>,
          timestampIso: ts,
          preview,
          fromMe: false,
          senderType: "contact",
          conversationState: {
            flow_code: (existingConv as { flow_code?: string | null }).flow_code ?? null,
            flow_current_node:
              (existingConv as { flow_current_node?: string | null }).flow_current_node ?? null,
            flow_status: (existingConv as { flow_status?: string | null }).flow_status ?? "bot",
            human_taken_over: Boolean(
              (existingConv as { human_taken_over?: boolean | null }).human_taken_over
            ),
            unread_count: (existingConv.unread_count as number) ?? 0,
            status: (existingConv.status as string) ?? "open",
          },
        });
        if (early.ok || early.duplicate) {
          inboundMessageAlreadyPersisted = true;
          inboundDurableWrite = true;
          // CLAIM GATE: si perdí el claim (otra invocación ya insertó este wa_message_id primero),
          // esto es un reintento/duplicado de Meta → NO ejecutar el motor (evita bienvenida/combos
          // duplicados). Se preservan las excepciones existentes: botones/lista (reprocesan routing
          // de campañas) y comprobantes-media (tienen su propio dedup por image_received).
          if (
            WEBHOOK_CLAIM_GATE_ENABLED &&
            !early.ok &&
            early.duplicate &&
            !mustRetryInboundRoutingDespiteDedupe &&
            !isComprobanteMediaMessageKind(msg)
          ) {
            console.info("[claim][lost]", { conversationId, wa_mid: waMid, msgType: msgTypeInbound });
            skipped += 1;
            continue;
          }
          console.info(WH_MSG, early.ok ? "[claim][won]" : "early_inbound_persist_ok", {
            conversationId,
            wa_mid: waMid,
            duplicate: !early.ok,
          });
        } else {
          console.warn(WH_MSG, "early_inbound_persist_failed", {
            conversationId,
            wa_mid: waMid,
            error: early.error,
          });
          // Base/PostgREST caído un momento: cortar ACÁ, antes de cualquier efecto del flujo, para
          // que el handler responda 503 y Meta reintente (antes el mensaje se perdía sin rastro).
          if (isTransientWebhookError(early.error)) {
            errors.push(`Insert mensaje (early): ${early.error}`);
            continue;
          }
        }
      }

      // Desde acá pueden correr efectos no idempotentes (restart-intent, CRM, envíos del flujo):
      // aunque algo falle después, no se pide reintento a Meta.
      inboundDurableWrite = true;

      await ensureCentralChatConversationMirror({
        pool: pool ?? null,
        tenantDataSchema,
        empresaId,
        conversationId,
      });

      console.info(WH_FLOW, "sync_catalog_before", { conversationId });
      /**
       * Si la lectura del catálogo falla (API caída un momento) se sigue con el flujo y el paso que
       * ya tenía la conversación. Antes la excepción abortaba el mensaje entero: quedaba guardado
       * pero el motor nunca lo procesaba y el cliente se quedaba sin respuesta.
       */
      let syncedFlow: { flow_code: string | null; flow_current_node: string | null };
      try {
        syncedFlow = await syncWhatsappConversationFlowFromCatalog(supabase, empresaId, conversationId, {
          flow_code: (existingConv as { flow_code?: string | null }).flow_code ?? null,
          flow_current_node: (existingConv as { flow_current_node?: string | null }).flow_current_node ?? null,
        });
      } catch (e) {
        console.warn(WH_FLOW, "sync_catalog_failed_keep_pointer", {
          conversationId,
          err: e instanceof Error ? e.message : String(e),
        });
        syncedFlow = {
          flow_code: (existingConv as { flow_code?: string | null }).flow_code ?? null,
          flow_current_node: (existingConv as { flow_current_node?: string | null }).flow_current_node ?? null,
        };
      }
      existingConv = {
        ...existingConv,
        flow_code: syncedFlow.flow_code,
        flow_current_node: syncedFlow.flow_current_node,
      };

      /**
       * Reanudar / reiniciar flujo con el mismo contacto+canal (sin duplicar conversación):
       * - Palabras clave → primer nodo del flujo activo (o del flujo actual si hay varios activos).
       * - Puntero roto (sin flow, flujo inactivo en catálogo, nodo inválido) → reinicio seguro.
       * - Si todo válido → conversation_resumed (solo log).
       */
      let convFlow = (existingConv as { flow_code?: string | null }).flow_code ?? null;
      let convNode = (existingConv as { flow_current_node?: string | null }).flow_current_node ?? null;
      let convHuman = (existingConv as { human_taken_over?: boolean | null }).human_taken_over ?? false;
      let convFlowStatus = (existingConv as { flow_status?: string | null }).flow_status ?? "bot";

      let restartedThisMessage = false;
      /** Takeover por palabra/botón genérico: mensaje de confirmación tras persistir el entrante. */
      let keywordHandoffPendingConfirmation = false;
      /**
       * Se evitó reiniciar una compra YA PAGADA sin orden: este mensaje no es un dato del flujo;
       * se le vuelve a mostrar al cliente el paso pendiente (ver `findPaidPurchasePendingOrder`).
       */
      let resumePaidPurchase = false;

      const restartKeywordMatch =
        message_type === "text"
          ? matchesConversationRestartKeyword(content, channelWakeConfig, {
              channelId,
              empresaId,
            })
          : false;

      const paidPendingAtRestart =
        restartKeywordMatch ? await findPaidPurchasePendingOrder(supabase, empresaId, conversationId) : null;
      if (paidPendingAtRestart) {
        resumePaidPurchase = !(convHuman || convFlowStatus === "human");
        console.info(CONV_LOG, "restart_keyword_skipped_paid_purchase_pending_order", {
          conversationId,
          flow_session_id: paidPendingAtRestart.flowSessionId,
          validation_id: paidPendingAtRestart.validationId,
          resume: resumePaidPurchase,
        });
      }

      /**
       * Reinicio por palabra (hola, menú, iniciar…): debe aplicar también si el chat estaba en modo humano,
       * para poder volver al bot sin depender solo de conversaciones nuevas.
       */
      if (restartKeywordMatch && !paidPendingAtRestart) {
        console.info(CONV_LOG, "restart_keyword_branch_entered", {
          conversationId,
          preferFlowCode: convFlow,
          was_human: convHuman || convFlowStatus === "human",
        });
        const rrKw = await restartWhatsappConversationToFlowStart(supabase, empresaId, conversationId, {
          preferFlowCode: convFlow,
          trigger: "restart_keyword",
        });
        console.info(CONV_LOG, "restart_keyword_result", {
          conversationId,
          restarted: rrKw.restarted,
          reason: rrKw.reason,
          flow_code: rrKw.flow_code,
          flow_current_node: rrKw.flow_current_node,
        });
        if (!rrKw.restarted) {
          console.warn(CONV_LOG, "restart_keyword_no_op", {
            conversationId,
            reason: rrKw.reason,
            convFlowBefore: convFlow,
          });
        }
        if (rrKw.restarted) {
          convFlow = rrKw.flow_code;
          convNode = rrKw.flow_current_node;
          convHuman = false;
          convFlowStatus = "bot";
          restartedThisMessage = true;
        }
      }

      /**
       * Intención de compra / reinicio suave (keywords por `chat_flows.flow_config`), p. ej. “boletos”, “quiero comprar”.
       * No sustituye al reinicio por hola/menú/iniciar (rama anterior). Si no hubo match ahí, evaluamos aquí.
       */
      if (!restartKeywordMatch && message_type === "text") {
        let pi: Awaited<ReturnType<typeof maybeRestartForPurchaseIntent>>;
        try {
          pi = await maybeRestartForPurchaseIntent(supabase, empresaId, conversationId, {
            messageType: message_type,
            content,
            convFlow,
            convNode,
            convHuman,
            convFlowStatus,
            restartedThisMessage,
            channelConfig: channelWakeConfig,
            blockRestart: async () =>
              Boolean(await findPaidPurchasePendingOrder(supabase, empresaId, conversationId)),
          });
        } catch (e) {
          // Falla leyendo catálogo/config: no se reinicia y el mensaje sigue al motor como siempre.
          console.warn(CONV_LOG, "purchase_intent_check_failed", {
            conversationId,
            err: e instanceof Error ? e.message : String(e),
          });
          pi = {
            restarted: false,
            flow_code: null,
            flow_current_node: null,
            new_flow_session_id: null,
            reason: "check_failed",
          };
        }
        if (pi.reason === PAID_PURCHASE_PENDING_ORDER_REASON) {
          resumePaidPurchase = !(convHuman || convFlowStatus === "human");
        }
        if (pi.restarted) {
          convFlow = pi.flow_code;
          convNode = pi.flow_current_node;
          convHuman = false;
          convFlowStatus = "bot";
          restartedThisMessage = true;
          existingConv = {
            ...existingConv,
            flow_code: convFlow,
            flow_current_node: convNode,
            human_taken_over: convHuman,
            flow_status: convFlowStatus,
            active_flow_session_id:
              pi.new_flow_session_id ??
              (existingConv as { active_flow_session_id?: string | null }).active_flow_session_id ??
              null,
          };
          console.info(CONV_LOG, "purchase_intent_restart_applied", {
            conversationId,
            flow_code: convFlow,
            flow_current_node: convNode,
            new_flow_session_id: pi.new_flow_session_id,
            reason: pi.reason,
          });
        }
      }

      const startedInHumanMode = convHuman || convFlowStatus === "human";
      if (message_type === "text") {
        console.info(CONV_LOG, "inbound_text_after_restart_keyword", {
          conversationId,
          contentLength: content.length,
          contentPreview: content.slice(0, 200),
          matchesRestartKeyword: restartKeywordMatch,
          startedInHumanMode,
        });
      }

      if (!startedInHumanMode) {
        if (!restartedThisMessage) {
          const fc = convFlow?.trim() || null;
          const nc = convNode?.trim() || null;
          let mustRestart = false;
          let restartTrigger = "";
          let prefer: string | null = null;

          /**
           * Si la consulta al catálogo FALLA (API caída un momento) no se reinicia: antes una falla
           * pasajera se leía como "nodo inválido" y reiniciaba el flujo en plena carga de datos,
           * con sesión nueva — el cliente perdía lo ya cargado y el bot volvía a preguntar.
           * Un nodo realmente inválido lo repara igual `sendCurrentFlowNode` al intentar enviarlo.
           */
          const flowCheck = fc ? await checkFlowKnownAndActiveInCatalog(supabase, empresaId, fc) : "no";
          const nodeCheck =
            fc && nc && flowCheck !== "no" ? await checkNodeActiveInFlow(supabase, empresaId, fc, nc) : "no";

          if (!fc) {
            mustRestart = true;
            restartTrigger = "missing_flow_code";
            console.warn(CONV_LOG, "invalid_current_node", {
              conversationId,
              detail: "missing_flow_code",
            });
          } else if (flowCheck === "no") {
            mustRestart = true;
            restartTrigger = "inactive_flow_reassigned";
            prefer = null;
            console.warn(CONV_LOG, "inactive_flow_reassigned", {
              conversationId,
              flow_code: fc,
              detail: "not_in_catalog_or_inactive",
            });
          } else if (!nc || nodeCheck === "no") {
            mustRestart = true;
            restartTrigger = "invalid_current_node";
            prefer = fc;
            console.warn(CONV_LOG, "invalid_current_node", {
              conversationId,
              flow_code: fc,
              flow_current_node: nc,
            });
          } else if (flowCheck === "unknown" || nodeCheck === "unknown") {
            console.warn(CONV_LOG, "catalog_check_unknown_keep_pointer", {
              conversationId,
              flow_code: fc,
              flow_current_node: nc,
              flowCheck,
              nodeCheck,
            });
          }

          if (mustRestart) {
            const rrFix = await restartWhatsappConversationToFlowStart(supabase, empresaId, conversationId, {
              preferFlowCode: prefer,
              trigger: restartTrigger,
            });
            if (rrFix.restarted) {
              convFlow = rrFix.flow_code;
              convNode = rrFix.flow_current_node;
              convHuman = false;
              convFlowStatus = "bot";
            }
          } else {
            console.info(CONV_LOG, "conversation_resumed", {
              conversationId,
              flow_code: fc,
              flow_current_node: nc,
            });
          }
        }
      } else {
        console.info(CONV_LOG, "skip_catalog_repair_human_mode", { conversationId });
      }

      const metaButtonIdPre = extractMetaButtonId(msg);
      if (!convHuman && convFlowStatus === "bot") {
        if (message_type === "text" && matchesHumanHandoffKeyword(content)) {
          convHuman = true;
          convFlowStatus = "human";
          keywordHandoffPendingConfirmation = true;
          console.info(CONV_LOG, "human_handoff_keyword", { conversationId, preview: content.slice(0, 80) });
        } else if (metaButtonIdPre && WEBHOOK_IMMEDIATE_HANDOFF_BUTTON_IDS.has(metaButtonIdPre)) {
          convHuman = true;
          convFlowStatus = "human";
          keywordHandoffPendingConfirmation = true;
          console.info(CONV_LOG, "human_handoff_button", { conversationId, metaButtonId: metaButtonIdPre });
        }
      }

      existingConv = {
        ...existingConv,
        flow_code: convFlow,
        flow_current_node: convNode,
        human_taken_over: convHuman,
        flow_status: convFlowStatus,
      };

      if (convFlow?.trim() && !convHuman && convFlowStatus !== "human") {
        let ensuredSid: string | null = null;
        try {
          ensuredSid = await ensureActiveFlowSessionForConversation(
            supabase,
            empresaId,
            conversationId,
            convFlow
          );
        } catch (e) {
          // Rechazo transitorio de transporte (pool agotado / timeout / socket) NO debe abortar el
          // mensaje: dejamos el puntero como está y el motor resuelve la sesión aguas abajo.
          console.warn("[bot-routing]", "ensure_session_exception_keep_pointer", {
            conversationId,
            err: e instanceof Error ? e.message : String(e),
          });
        }
        console.info("[bot-routing]", "ensure_session_pre_assign", {
          conversationId,
          empresa_id: empresaId,
          flow_code: convFlow.trim(),
          active_flow_session_id: ensuredSid,
        });
        if (ensuredSid) {
          existingConv = {
            ...existingConv,
            active_flow_session_id: ensuredSid,
          };
        }
      }

      const logW = "[webhook/whatsapp][inbound]";
      console.info(logW, "message_received", {
        waMessageId: waMid,
        fromDigits: from,
        phoneNumberId,
        channelId,
        messageType: (msg as { type?: string }).type ?? "unknown",
        conversationId,
        flow_code: (existingConv as { flow_code?: string | null }).flow_code ?? null,
        flow_current_node: (existingConv as { flow_current_node?: string | null }).flow_current_node ?? null,
        flow_status: (existingConv as { flow_status?: string | null }).flow_status ?? null,
      });

      // ── Integración CRM Funnel (WhatsApp): tras autoasignación, creado por = canal, responsable = asesor.
      console.info("[webhooks/whatsapp][assignConversation]", useTenantPg ? "pg_v2" : "postgrest", {
        conversationId,
      });
      /**
       * Asignación a asesor y lead de CRM son secundarios: si fallan (pool de Postgres saturado por
       * las pantallas del ERP, API caída) se registra y el mensaje SIGUE al motor. Antes la
       * excepción abortaba el mensaje entero y el cliente que respondía su dato no recibía nada.
       */
      try {
        const arCrm =
          useTenantPg && pool
            ? await assignConversationPg(pool, tenantDataSchema, conversationId)
            : await assignConversation(supabase, conversationId);
        if (!arCrm.ok) {
          console.warn("[webhook/whatsapp][crm] assignConversation", arCrm.error);
        }
      } catch (e) {
        console.warn("[webhook/whatsapp][crm] assignConversation_exception_continue", {
          conversationId,
          err: e instanceof Error ? e.message : String(e),
        });
      }
      try {
        if (pool) {
          const crmPg = await ensureWhatsappInboundCrmLeadPg({
            pool,
            data_schema: tenantDataSchema,
            empresa_id: empresaId,
            contact_id: contactId,
            conversation_id: conversationId,
            channel_id: channelId,
            first_message_preview: preview,
          });
          if (!crmPg.ok) {
            errors.push(crmPg.error);
          }
        } else {
          const crmRes = await ensureWhatsappInboundCrmProspecto({
            chatSupabase: supabase,
            etapaSupabase: catalogSupabase,
            empresaId,
            contactId,
            conversationId,
            channelId,
            firstMessagePreview: preview,
          });
          if (!crmRes.ok) {
            errors.push(crmRes.error);
          }
        }
      } catch (e) {
        console.warn("[webhook/whatsapp][crm] lead_exception_continue", {
          conversationId,
          err: e instanceof Error ? e.message : String(e),
        });
      }

      const flowEngine = createFlowEngine({ supabase });

      let convPersistSnap: unknown = null;
      try {
        ({ data: convPersistSnap } = await supabase
          .from("chat_conversations")
          .select(
            "flow_code, flow_current_node, flow_status, human_taken_over, unread_count, status"
          )
          .eq("id", conversationId)
          .eq("empresa_id", empresaId)
          .maybeSingle());
      } catch (e) {
        // Rechazo transitorio: no abortar el mensaje; seguimos con el estado en memoria.
        console.warn(logW, "conv_persist_snap_read_failed", {
          conversationId,
          err: e instanceof Error ? e.message : String(e),
        });
      }

      const snap =
        convPersistSnap as null | {
          flow_code?: string | null;
          flow_current_node?: string | null;
          flow_status?: string | null;
          human_taken_over?: boolean | null;
          unread_count?: number | null;
          status?: string | null;
        };

      console.info("[bot-routing]", "persist_flow_snapshot_merge", {
        conversationId,
        snap_flow_code: snap?.flow_code ?? null,
        snap_active_node: snap?.flow_current_node ?? null,
        memory_flow_code: (existingConv as { flow_code?: string | null }).flow_code ?? null,
        memory_node: (existingConv as { flow_current_node?: string | null }).flow_current_node ?? null,
      });

      console.info(WH_MSG, "persistInbound_start", {
        conversationId,
        wa_mid: waMid,
        inboundMessageAlreadyPersisted,
      });

      // A esta altura pudo haber efectos previos a la persistencia (CRM, sync de flujo): no reintentar.
      inboundDurableWrite = true;

      let inboundRowId: string | null = null;

      if (inboundMessageAlreadyPersisted) {
        const { data: existingInbound } = await supabase
          .from("chat_messages")
          .select("id")
          .eq("wa_message_id", waMid)
          .maybeSingle();
        inboundRowId = (existingInbound as { id?: string } | null)?.id ?? null;
        if (!inboundRowId) {
          errors.push("Mensaje entrante: wa_message_id existente pero fila no encontrada");
          continue;
        }
        console.info(logW, "inbound_message_reuse_existing_row", {
          conversationId,
          waMessageId: waMid,
          messageRowId: inboundRowId,
        });
      } else {
        const persistInbound = await persistInboundChatMessageAndBump({
          supabase,
          empresaId,
          conversationId,
          externalMessageId: waMid,
          messageType: message_type,
          content,
          rawPayload: msg as unknown as Record<string, unknown>,
          timestampIso: ts,
          preview,
          fromMe: false,
          senderType: "contact",
          conversationState: {
            flow_code: snap?.flow_code ?? (existingConv as { flow_code?: string | null }).flow_code ?? null,
            flow_current_node:
              snap?.flow_current_node ??
              (existingConv as { flow_current_node?: string | null }).flow_current_node ??
              null,
            flow_status: (existingConv as { flow_status?: string | null }).flow_status ?? snap?.flow_status ?? "bot",
            human_taken_over: Boolean(
              (existingConv as { human_taken_over?: boolean | null }).human_taken_over
            ),
            unread_count: (snap?.unread_count as number) ?? (existingConv.unread_count as number) ?? 0,
            status: (snap?.status as string) ?? (existingConv.status as string),
          },
        });

        if (!persistInbound.ok) {
          if (persistInbound.duplicate && isComprobanteMediaMessageKind(msg)) {
            const { data: dupRow } = await supabase
              .from("chat_messages")
              .select("id")
              .eq("wa_message_id", waMid)
              .maybeSingle();
            inboundRowId = (dupRow as { id?: string } | null)?.id ?? null;
            if (!inboundRowId) {
              errors.push(`Insert mensaje duplicado (comprobante media): ${persistInbound.error ?? "sin fila"}`);
              continue;
            }
            inboundMessageAlreadyPersisted = true;
            console.info(logW, "inbound_message_duplicate_race_comprobante_media", {
              conversationId,
              waMessageId: waMid,
              messageRowId: inboundRowId,
            });
          } else if (persistInbound.duplicate && !mustRetryInboundRoutingDespiteDedupe) {
            /**
             * Perdimos la carrera del insert contra OTRA entrega del mismo mensaje (Meta a veces
             * entrega en paralelo). Mismo criterio que el dedupe de arriba para reintentos
             * secuenciales: un texto ya procesado no vuelve a entrar al motor de flujo. Antes se
             * seguía de largo y el mismo "Pedro" se procesaba dos veces: la segunda copia caía en
             * el campo siguiente y corría toda la carga de datos un lugar.
             */
            console.info(logW, "inbound_message_duplicate_race_skipped", {
              conversationId,
              waMessageId: waMid,
              message_type,
            });
            skipped += 1;
            continue;
          } else if (persistInbound.duplicate) {
            const { data: dupRow } = await supabase
              .from("chat_messages")
              .select("id")
              .eq("wa_message_id", waMid)
              .maybeSingle();
            inboundRowId = (dupRow as { id?: string } | null)?.id ?? null;
            if (!inboundRowId) {
              skipped += 1;
              continue;
            }
            console.info(logW, "inbound_message_duplicate_reuse_row", {
              conversationId,
              waMessageId: waMid,
              messageRowId: inboundRowId,
            });
          } else {
            errors.push(`Insert mensaje: ${persistInbound.error}`);
            continue;
          }
        } else {
          inboundRowId = persistInbound.message_id;
          console.info(logW, "inbound_message_persisted", {
            conversationId,
            waMessageId: waMid,
            message_type,
            messageRowId: inboundRowId,
          });
        }
      }

      // ETQ-CAMP-FIX-5: reactivación automática de conversación oculta por etiqueta.
      // Si la conv tenía hidden_by_tag=true y este inbound es del cliente (from_me=false),
      // limpiar campos de etiqueta y registrar history action='cleared'.
      // Idempotente: UPDATE condicional con AND hidden_by_tag=true; un segundo evento ve rowCount=0.
      // Multi-tenant: try/catch silencia errores en schemas sin la columna (la propagación a otros
      // tenants se hace cuando reciban la migración de etiquetas).
      try {
        const { data: convForTag } = await supabase
          .from("chat_conversations")
          .select("contact_id, hidden_by_tag, current_tag_id, hidden_by_tag_rule_id, hidden_by_tag_at")
          .eq("id", conversationId)
          .eq("empresa_id", empresaId)
          .maybeSingle();
        const cur = convForTag as
          | {
              contact_id?: string | null;
              hidden_by_tag?: boolean | null;
              current_tag_id?: string | null;
              hidden_by_tag_rule_id?: string | null;
              hidden_by_tag_at?: string | null;
            }
          | null;
        if (cur?.hidden_by_tag === true) {
          const prevTagId = cur.current_tag_id ?? null;
          const prevRuleId = cur.hidden_by_tag_rule_id ?? null;
          const prevHiddenAt = cur.hidden_by_tag_at ?? null;
          const contactIdForHistory = cur.contact_id ?? null;
          const nowIso = new Date().toISOString();
          const { error: updErr, count: updRows } = await supabase
            .from("chat_conversations")
            .update(
              {
                hidden_by_tag: false,
                current_tag_id: null,
                hidden_by_tag_rule_id: null,
                tag_reactivated_at: nowIso,
                updated_at: nowIso,
              },
              { count: "exact" }
            )
            .eq("id", conversationId)
            .eq("empresa_id", empresaId)
            .eq("hidden_by_tag", true);
          if (!updErr && (updRows ?? 0) > 0) {
            await supabase.from("chat_conversation_tag_history").insert({
              empresa_id: empresaId,
              conversation_id: conversationId,
              contact_id: contactIdForHistory,
              previous_tag_id: prevTagId,
              new_tag_id: null,
              rule_id: prevRuleId,
              action: "cleared",
              reason: "inbound_reactivated_conversation_meta",
              source: "client_replied",
              metadata: {
                source_phase: "etq_camp_fix_5_meta_reactivation",
                provider: "meta",
                wa_message_id: waMid ?? null,
                message_id: inboundRowId,
                previous_tag_id: prevTagId,
                previous_rule_id: prevRuleId,
                previous_hidden_by_tag_at: prevHiddenAt,
              },
            });
            console.info(logW, "[chat-tags][reactivated-by-inbound-meta]", {
              empresa_id_short: empresaId.slice(0, 8),
              conversation_id_short: conversationId.slice(0, 8),
              previous_tag_id: prevTagId,
            });
          }
        }
      } catch (reactErr) {
        // No bloquear el persist por errores en la reactivación. Tenants sin la columna
        // hidden_by_tag (no Papu) caen acá y siguen normal.
        console.warn(logW, "[chat-tags][reactivation-meta-skip]", {
          conversationId,
          error: reactErr instanceof Error ? reactErr.message : String(reactErr),
        });
      }

      if (!inboundRowId) {
        errors.push("Mensaje entrante sin id de fila");
        continue;
      }

      let campaignReplyMatch: Awaited<ReturnType<typeof markCampaignReplyFromInbound>> = {
        matched: false,
      };
      try {
        campaignReplyMatch = await markCampaignReplyFromInbound({
          supabase,
          empresaId,
          channelId,
          contactId,
          inboundAtIso: ts,
          preview,
          waMessageId: waMid,
        });
      } catch (e) {
        console.warn("[campaign-reply][webhook]", e instanceof Error ? e.message : String(e));
      }

      let campaignButtonSuppressFlowInteractive = false;
      const rawInboundPayload = msg as unknown as Record<string, unknown>;
      const msgTypeLower = String(msg.type ?? "").trim().toLowerCase();
      const isButtonReplyInteractive =
        message_type === "interactive" &&
        Boolean(
          (msg.interactive as { button_reply?: { id?: string; title?: string } } | undefined)
            ?.button_reply
        );
      const isListReplyInteractive =
        message_type === "interactive" &&
        Boolean(
          (msg.interactive as { list_reply?: { id?: string; title?: string } } | undefined)?.list_reply
        );
      /** Meta Cloud API: respuesta a botón de plantilla suele llegar como `type: "button"` + `button.payload`. */
      const isMetaButtonMessage =
        msgTypeLower === "button" && Boolean((msg as MetaInboundMessage).button);
      if (
        campaignReplyMatch.matched &&
        (isButtonReplyInteractive ||
          isListReplyInteractive ||
          isMetaButtonMessage ||
          message_type === "text")
      ) {
        const reply = campaignReplyMatch;
        try {
          const btnRes = await executeCampaignButtonActionForMatchedRecipient({
            supabase,
            empresaId,
            channelId,
            conversationId,
            contactId,
            campaignId: reply.campaignId,
            recipientId: reply.recipientId,
            inboundAtIso: ts,
            waMessageId: waMid,
            rawPayload: rawInboundPayload,
          });
          campaignButtonSuppressFlowInteractive = btnRes.handled;
        } catch (e) {
          console.warn("[campaign-button-action][webhook]", e instanceof Error ? e.message : String(e));
        }
      }

      {
        let chTok: unknown = null;
        try {
          ({ data: chTok } = await supabase
            .from("chat_channels")
            .select("whatsapp_access_token")
            .eq("id", channelId)
            .maybeSingle());
        } catch (e) {
          // Rechazo transitorio leyendo el token: no abortar; cae al fallback de env.
          console.warn(logW, "chat_channel_token_read_failed", {
            conversationId,
            err: e instanceof Error ? e.message : String(e),
          });
        }
        const rowTok =
          typeof (chTok as { whatsapp_access_token?: string } | null)?.whatsapp_access_token === "string"
            ? (chTok as { whatsapp_access_token: string }).whatsapp_access_token.trim()
            : "";
        const mediaToken = rowTok || process.env.WHATSAPP_TOKEN?.trim() || "";
        if (mediaToken) {
          try {
            await attachInboundMessageMedia({
              supabase,
              empresaId,
              conversationId,
              messageId: inboundRowId,
              msg,
              accessToken: mediaToken,
            });
          } catch (e) {
            console.warn(logW, "inbound_media_attach_failed", {
              conversationId,
              messageId: inboundRowId,
              err: e instanceof Error ? e.message : String(e),
            });
          }
        }
      }

      let businessAutomationResult = { sentWelcome: false, sentAwayMessage: false };
      try {
        businessAutomationResult = await runWhatsappBusinessAutomationAfterInbound({
          supabase,
          empresaId,
          channelId,
          conversationId,
          humanTakenOver: convHuman || convFlowStatus === "human",
        });
      } catch (e) {
        console.warn(logW, "business_automation_failed", {
          conversationId,
          err: e instanceof Error ? e.message : String(e),
        });
      }
      /**
       * Fuera de horario: evitamos amontonar respuesta automática + primer nodo del flujo en el mismo tick.
       * Mensaje de bienvenida ya no bloquea el motor (antes el primer "hola" solo enviaba welcome y cortaba el flujo).
       * Clic en botón/lista: NUNCA omitir el motor solo por `away_message`: el cliente debe avanzar (resumen, etc.).
       */
      const interactiveInboundMetaId = extractMetaButtonId(msg);
      const skipFlowForBusinessAutomation =
        businessAutomationResult.sentAwayMessage && !interactiveInboundMetaId;

      /**
       * TRAMPA DE RUTEO: si un mensaje de TEXTO se desvía del manejador de texto (por away/horario
       * o porque se detectó un botón interactivo en un texto), deja rastro en la base. Esto explica
       * los mudos que no producen NINGÚN otro evento (ni processTextReply ni skip). Solo se graba en
       * el caso desviado (bajo volumen). Best-effort.
       */
      if (message_type === "text" && (skipFlowForBusinessAutomation || interactiveInboundMetaId)) {
        try {
          await supabase.from("chat_flow_events").insert({
            empresa_id: empresaId,
            conversation_id: conversationId,
            flow_code: convFlow ?? null,
            node_code: convNode ?? null,
            event_type: "text_routed_away_diag",
            payload: {
              wa_message_id: waMid,
              skip_flow_business_automation: skipFlowForBusinessAutomation,
              sent_away_message: businessAutomationResult.sentAwayMessage,
              sent_welcome: businessAutomationResult.sentWelcome,
              interactive_meta_id: interactiveInboundMetaId ?? null,
              text_preview: content.slice(0, 40),
            },
          });
        } catch {
          /* no-op */
        }
      }

      console.info(logW, "conversation_updated_unread", { conversationId });

      let convDbAfterUnread: unknown = null;
      try {
        ({ data: convDbAfterUnread } = await supabase
          .from("chat_conversations")
          .select(
            "flow_code, flow_current_node, active_flow_session_id, flow_status, human_taken_over"
          )
          .eq("id", conversationId)
          .eq("empresa_id", empresaId)
          .maybeSingle());
      } catch (e) {
        // Rechazo transitorio: no abortar el mensaje; seguimos con el estado en memoria.
        console.warn(logW, "conv_db_after_unread_read_failed", {
          conversationId,
          err: e instanceof Error ? e.message : String(e),
        });
      }
      if (convDbAfterUnread) {
        const ec = existingConv as {
          flow_code?: string | null;
          flow_current_node?: string | null;
          flow_status?: string | null;
          human_taken_over?: boolean | null;
          active_flow_session_id?: string | null;
        };
        existingConv = {
          ...existingConv,
          flow_code:
            (convDbAfterUnread as { flow_code?: string | null }).flow_code ?? ec.flow_code ?? null,
          flow_current_node:
            (convDbAfterUnread as { flow_current_node?: string | null }).flow_current_node ??
            ec.flow_current_node ??
            null,
          flow_status:
            (convDbAfterUnread as { flow_status?: string | null }).flow_status ?? ec.flow_status ?? null,
          human_taken_over:
            (convDbAfterUnread as { human_taken_over?: boolean | null }).human_taken_over ??
            ec.human_taken_over ??
            false,
          active_flow_session_id:
            (convDbAfterUnread as { active_flow_session_id?: string | null }).active_flow_session_id ??
            ec.active_flow_session_id ??
            null,
        };
      }
      flowTrace("webhook_pre_engine_db_snapshot", {
        conversation_id: conversationId,
        empresa_id: empresaId,
        wa_message_id: waMid,
        restarted_this_message: restartedThisMessage,
        restart_keyword_matched: restartKeywordMatch,
        db_active_flow_session_id:
          (convDbAfterUnread as { active_flow_session_id?: string | null } | null)
            ?.active_flow_session_id ?? null,
        db_flow_code: (convDbAfterUnread as { flow_code?: string | null } | null)?.flow_code ?? null,
        db_flow_current_node:
          (convDbAfterUnread as { flow_current_node?: string | null } | null)?.flow_current_node ?? null,
        memory_active_flow_session_id:
          (existingConv as { active_flow_session_id?: string | null }).active_flow_session_id ?? null,
      });

      try {
        await applySorteoReferralToActiveSession({
          supabase,
          empresaId,
          conversationId,
          activeFlowSessionId: (existingConv as { active_flow_session_id?: string | null })
            .active_flow_session_id,
          flowCode: (existingConv as { flow_code?: string | null }).flow_code,
          inboundText: content,
          contactPhoneDigits: from,
        });
      } catch (e) {
        console.warn(logW, "referral_attribution_failed", {
          conversationId,
          err: e instanceof Error ? e.message : String(e),
        });
      }

      if (keywordHandoffPendingConfirmation) {
        const sid =
          (convDbAfterUnread as { active_flow_session_id?: string | null } | null)
            ?.active_flow_session_id ??
          (existingConv as { active_flow_session_id?: string | null }).active_flow_session_id ??
          null;
        await supabase.from("chat_flow_events").insert({
          empresa_id: empresaId,
          conversation_id: conversationId,
          flow_code: (existingConv as { flow_code?: string | null }).flow_code ?? null,
          node_code: (existingConv as { flow_current_node?: string | null }).flow_current_node ?? null,
          flow_session_id: sid,
          event_type: "human_handoff_keyword_or_button",
          meta_button_id: metaButtonIdPre,
          payload: {
            trigger: message_type === "text" ? "text_keyword" : "interactive_button",
            preview: preview.slice(0, 200),
          },
        });

        const handoffText =
          "Te derivamos con un asesor humano. En breve te vamos a escribir desde este mismo número.";
        try {
          const ctx = await resolveOutboundTextContextFromConversationId(supabase, conversationId, empresaId);
          const sendC = await sendOutboundTextMessage(ctx, handoffText);
          if (sendC.ok) {
            const nowH = new Date().toISOString();
            await supabase.from("chat_messages").insert({
              empresa_id: empresaId,
              conversation_id: conversationId,
              wa_message_id: sendC.waMessageId,
              from_me: true,
              sender_type: "system",
              message_type: "text",
              content: handoffText,
              raw_payload: (sendC.raw ?? {}) as Record<string, unknown>,
            });
            await supabase
              .from("chat_conversations")
              .update({
                last_message_at: nowH,
                last_message_preview: handoffText.slice(0, 280),
                updated_at: nowH,
              })
              .eq("id", conversationId);
          }
        } catch (e) {
          console.warn(logW, "human_handoff_confirm_send_failed", {
            conversationId,
            err: e instanceof Error ? e.message : String(e),
          });
        }
      }

      /**
       * Interactivo (botón/lista): procesar clic primero; no mezclar con `ensureCurrentNodePresented`.
       * Otros tipos: presentar nodo si falta, luego texto/imagen/comprobante.
       */
      let presentResult: Awaited<
        ReturnType<typeof flowEngine.ensureCurrentNodePresentedAfterInbound>
      > | null = null;

      if (skipFlowForBusinessAutomation) {
        console.info(logW, "skip_flow_engine_business_automation", {
          conversationId,
          sentWelcome: businessAutomationResult.sentWelcome,
          sentAwayMessage: businessAutomationResult.sentAwayMessage,
          interactive_inbound_meta_id: interactiveInboundMetaId,
        });
      } else {
        /**
         * Clic en botón/lista: procesar ANTES que `ensureCurrentNodePresented`.
         * Si `ensure` corre primero y falta `node_sent` en BD, se re-envía el mismo menú interactivo
         * en el mismo webhook y el cliente ve el paso repetido sin avanzar al siguiente nodo.
         */
        if (interactiveInboundMetaId && !campaignButtonSuppressFlowInteractive) {
          console.info(logW, "flow_trigger: interactive_reply_first", {
            conversationId,
            empresaId,
            metaButtonId: interactiveInboundMetaId,
            currentNode:
              (existingConv as { flow_current_node?: string | null }).flow_current_node ??
              "inicio",
          });
          const interactiveResult = await flowEngine.processInteractiveReply({
            conversationId,
            empresaId,
            metaButtonId: interactiveInboundMetaId,
            rawPayload: msg as unknown as Record<string, unknown>,
          });
          console.info(logW, "flow_result: interactive", {
            conversationId,
            metaButtonId: interactiveInboundMetaId,
            status: interactiveResult.status,
            nextNodeCode: interactiveResult.nextNodeCode ?? null,
          });
          if (!interactiveResult.ok) {
            errors.push(
              `Flow interactive: ${interactiveResult.error ?? interactiveResult.status}`
            );
          }
          // FIX: botón de "comprar de nuevo" que no es opción del nodo actual (p. ej. en
          // compra_realizada). En vez de quedar como invalid_button, reiniciamos una compra nueva.
          if (
            interactiveResult.status === "invalid_button_restart_intent" &&
            !restartedThisMessage &&
            !convHuman &&
            convFlowStatus !== "human" &&
            (await findPaidPurchasePendingOrder(supabase, empresaId, conversationId))
          ) {
            // Compra pagada sin orden: no se empieza otra; se repite el paso pendiente.
            const resentInt = await flowEngine.sendCurrentFlowNode({ conversationId });
            console.info(CONV_LOG, "interactive_restart_skipped_paid_purchase_pending_order", {
              conversationId,
              ok: resentInt.ok,
              nodeCode: resentInt.nodeCode ?? null,
            });
          } else if (
            interactiveResult.status === "invalid_button_restart_intent" &&
            !restartedThisMessage &&
            !convHuman &&
            convFlowStatus !== "human"
          ) {
            console.info(CONV_LOG, "interactive_purchase_intent_restart", {
              conversationId,
              title: content.trim().slice(0, 40),
            });
            const rrInteractive = await restartWhatsappConversationToFlowStart(
              supabase,
              empresaId,
              conversationId,
              {
                preferFlowCode: convFlow,
                trigger: "interactive_purchase_intent",
                preserveReferralFromPreviousSession: true,
                intentAudit: { matched_keyword: content.trim().slice(0, 60) || "interactive" },
              }
            );
            if (rrInteractive.restarted) {
              restartedThisMessage = true;
              convFlow = rrInteractive.flow_code;
              convNode = rrInteractive.flow_current_node;
              const presentAfterInt = await flowEngine.ensureCurrentNodePresentedAfterInbound({
                conversationId,
                empresaId,
              });
              console.info(CONV_LOG, "interactive_purchase_intent_restart_presented", {
                conversationId,
                ok: presentAfterInt.ok,
                status: presentAfterInt.status,
              });
            }
          }
          presentResult = {
            ok: interactiveResult.ok,
            status: interactiveResult.status,
            presentedNow: false,
            acceptsInboundTextAsCapture: false,
          };
        } else {
          presentResult = await flowEngine.ensureCurrentNodePresentedAfterInbound({
            conversationId,
            empresaId,
          });
          console.info(logW, "flow_present_step", {
            conversationId,
            ok: presentResult.ok,
            status: presentResult.status,
            presentedNow: presentResult.presentedNow,
            acceptsInboundTextAsCapture: presentResult.acceptsInboundTextAsCapture,
            error: presentResult.error ?? null,
          });
          if (!presentResult.ok && presentResult.error) {
            errors.push(`Flow present: ${presentResult.error}`);
          }
        }

        if (!interactiveInboundMetaId) {
          if (message_type === "text") {
            /**
             * Si este mismo mensaje ya disparó un reinicio del flujo —por palabra clave O por
             * intención de compra (p. ej. "hola")— el flujo ya se presentó desde el inicio
             * (bienvenida + combos). Reprocesar el texto re-presenta el nodo actual y duplica el
             * envío (combos dobles). Antes el guard sólo cubría el reinicio por palabra clave;
             * el reinicio por purchase_intent se colaba y por eso los combos salían dos veces.
             */
            const skipAfterRestart = restartedThisMessage;
            /**
             * Si el nodo actual se ACABA de presentar con este mismo mensaje, el cliente escribió
             * este texto antes de ver la pregunta: no puede ser su respuesta. Antes esto sólo se
             * respetaba para nodos que no son de captura; en uno de captura el texto se guardaba
             * igual en ese campo. Así terminaba el teléfono guardado como ciudad cuando el puntero
             * había quedado en un nodo sin enviar (envío fallido, continuación manual, rebobinado
             * del gate). La pregunta ya salió con este envío: la próxima respuesta es la buena.
             */
            const skipBecauseJustPresented = Boolean(presentResult && presentResult.presentedNow);
            if (resumePaidPurchase && !skipBecauseJustPresented) {
              /**
               * Compra pagada sin orden: "Y mis boletas" / "Hola…" no es la respuesta al paso actual
               * (no se guarda como cédula o celular) ni un motivo para empezar otra compra. Se avisa que
               * el pago está recibido y se repite la pregunta pendiente para que termine y reciba sus boletas.
               */
              try {
                const ctxNotice = await resolveOutboundTextContextFromConversationId(
                  supabase,
                  conversationId,
                  empresaId
                );
                const sendNotice = await sendOutboundTextMessage(ctxNotice, PAID_PURCHASE_RESUME_NOTICE);
                if (sendNotice.ok) {
                  const nowN = new Date().toISOString();
                  await supabase.from("chat_messages").insert({
                    empresa_id: empresaId,
                    conversation_id: conversationId,
                    wa_message_id: sendNotice.waMessageId,
                    from_me: true,
                    sender_type: "system",
                    automation_source: "flow_engine",
                    message_type: "text",
                    content: PAID_PURCHASE_RESUME_NOTICE,
                    raw_payload: (sendNotice.raw ?? {}) as Record<string, unknown>,
                  });
                  await supabase
                    .from("chat_conversations")
                    .update({
                      last_message_at: nowN,
                      last_message_preview: PAID_PURCHASE_RESUME_NOTICE.slice(0, 280),
                      updated_at: nowN,
                    })
                    .eq("id", conversationId);
                }
              } catch (e) {
                console.warn(logW, "paid_purchase_resume_notice_failed", {
                  conversationId,
                  err: e instanceof Error ? e.message : String(e),
                });
              }
              const resent = await flowEngine.sendCurrentFlowNode({ conversationId });
              console.info(logW, "paid_purchase_resume_current_step", {
                conversationId,
                ok: resent.ok,
                nodeCode: resent.nodeCode ?? null,
                error: resent.error ?? null,
              });
            } else if (skipAfterRestart) {
              console.info(logW, "skip_text_flow_handler", {
                conversationId,
                reason: "mensaje_usado_como_reinicio_flujo_no_es_captura",
              });
            } else if (skipBecauseJustPresented) {
              console.info(logW, "skip_text_flow_handler", {
                conversationId,
                reason: presentResult?.acceptsInboundTextAsCapture
                  ? "Se acaba de enviar la pregunta del nodo actual; el mensaje es anterior a la pregunta y no se toma como respuesta"
                  : "Se acaba de enviar la UI del nodo actual (no es captura de texto); el mismo mensaje no se interpreta como dato del flujo",
              });
              // Diagnóstico: registrar en la base para medir si esta rama es la que deja mudo.
              try {
                await supabase.from("chat_flow_events").insert({
                  empresa_id: empresaId,
                  conversation_id: conversationId,
                  flow_code: convFlow ?? null,
                  node_code: convNode ?? null,
                  event_type: "text_skipped_just_presented_diag",
                  payload: {
                    wa_message_id: waMid,
                    present_status: presentResult?.status ?? null,
                    accepts_capture: presentResult?.acceptsInboundTextAsCapture ?? null,
                    text_preview: content.slice(0, 40),
                  },
                });
              } catch {
                /* no-op */
              }
              logFlowStateTransition({
                conversationId,
                flowSessionId: null,
                expectedNode: null,
                expectedField: null,
                lastQuestionSent: null,
                textValue: content,
                nextNode: null,
                result: presentResult?.acceptsInboundTextAsCapture
                  ? "not_captured_question_just_presented"
                  : "not_captured_non_capture_node_presented",
              });
            } else {
              /**
               * Reintento in-request: si el procesamiento del texto falla por causa transitoria
               * (lo que dejaba MUDO al cliente en un paso de captura) reintentamos hasta 3 veces con
               * backoff. Seguro por el guard de idempotencia (wa_message_id) en processTextReply.
               */
              let textResult: Awaited<ReturnType<typeof flowEngine.processTextReply>> = {
                ok: false,
                status: "not_run",
              };
              let textAttempt = 0;
              while (textAttempt < 3) {
                textAttempt += 1;
                try {
                  textResult = await flowEngine.processTextReply({
                    conversationId,
                    empresaId,
                    textValue: content,
                    rawPayload: msg as unknown as Record<string, unknown>,
                  });
                } catch (e) {
                  textResult = {
                    ok: false,
                    status: "exception",
                    error: e instanceof Error ? e.message : String(e),
                  };
                }
                if (
                  textResult.ok ||
                  textAttempt >= 3 ||
                  !isTransientFlowTextFailure(textResult.status, textResult.error)
                ) {
                  break;
                }
                console.warn(logW, "flow_text_retry", {
                  conversationId,
                  attempt: textAttempt,
                  status: textResult.status,
                  error: textResult.error ?? null,
                });
                await new Promise((r) => setTimeout(r, 350 * textAttempt));
              }
              console.info(logW, "flow_result: text", {
                conversationId,
                status: textResult.status,
                nextNodeCode: textResult.nextNodeCode ?? null,
                attempts: textAttempt,
              });
              /**
               * Resultado del procesamiento del texto. Clasificamos:
               *  - CAPTURA OK: se guardó y avanzó → nada que hacer.
               *  - YA RE-PRESENTADO / carrera: processTextReply ya reenvió o el ganador enviará → nada.
               *  - CUALQUIER OTRO (fallo, o "ignorado" silencioso): el cliente queda mudo si no
               *    hacemos nada. Registramos el status EXACTO en la base (para auditar la causa) y
               *    re-presentamos el nodo actual para que reciba la pregunta al instante. Re-presentar
               *    NO captura → no cruza datos.
               */
              const CAPTURE_OK = new Set(["advanced", "captured_no_next_node"]);
              const ALREADY_HANDLED = new Set([
                "duplicate_capture_represented",
                "ignored_pointer_not_on_screen",
                "ignored_text_predates_question",
                "ignored_concurrent_reply",
                "image_expected_text_received",
              ]);
              if (!CAPTURE_OK.has(textResult.status) && !ALREADY_HANDLED.has(textResult.status)) {
                try {
                  await supabase.from("chat_flow_events").insert({
                    empresa_id: empresaId,
                    conversation_id: conversationId,
                    flow_code: convFlow ?? null,
                    node_code: convNode ?? null,
                    event_type: "text_not_captured_diag",
                    payload: {
                      status: textResult.status,
                      ok: textResult.ok,
                      error: textResult.error ?? null,
                      wa_message_id: waMid,
                      attempts: textAttempt,
                      present_status: presentResult?.status ?? null,
                      presented_now: presentResult?.presentedNow ?? null,
                      accepts_capture: presentResult?.acceptsInboundTextAsCapture ?? null,
                      text_preview: content.slice(0, 40),
                    },
                  });
                } catch (diagErr) {
                  console.warn(logW, "text_not_captured_diag_insert_failed", {
                    conversationId,
                    err: diagErr instanceof Error ? diagErr.message : String(diagErr),
                  });
                }
                // Fin del mute: re-presentar el nodo actual al instante.
                try {
                  await flowEngine.sendCurrentFlowNode({ conversationId });
                } catch {
                  /* no-op: el watchdog/barrido siguen como red final */
                }
              }
              if (!textResult.ok) {
                errors.push(`Flow text: ${textResult.error ?? textResult.status}`);
                /**
                 * Deja rastro del fallo EN LA BASE (los logs de la app son efímeros). Best-effort:
                 * nunca debe romper el webhook. Permite auditar la causa raíz del residual por SQL.
                 */
                try {
                  await supabase.from("chat_flow_events").insert({
                    empresa_id: empresaId,
                    conversation_id: conversationId,
                    flow_code: convFlow ?? null,
                    node_code: convNode ?? null,
                    event_type: "text_process_failed",
                    payload: {
                      status: textResult.status,
                      error: textResult.error ?? null,
                      wa_message_id: waMid,
                      attempts: textAttempt,
                      text_preview: content.slice(0, 40),
                    },
                  });
                } catch (diagErr) {
                  console.warn(logW, "text_process_failed_diag_insert_failed", {
                    conversationId,
                    err: diagErr instanceof Error ? diagErr.message : String(diagErr),
                  });
                }
              }
            }
          } else {
            const hasMediaSlot = extractInboundComprobanteMedia(msg);
            if (!hasMediaSlot && (message_type === "image" || message_type === "document")) {
              errors.push(
                `Flow comprobante: tipo ${message_type} pero falta media id en payload (revisar shape Meta/n8n)`
              );
            } else if (!hasMediaSlot) {
              console.info(logW, "no_typed_flow_handler", {
                conversationId,
                message_type,
              });
            }
            /* Imagen/documento con media_id: bloque unificado [flow-image-input] debajo (corre también con away/skipFlow). */
          }
        }
      }

      /**
       * Comprobante imagen/documento: debe ejecutarse incluso si `skipFlowForBusinessAutomation`
       * evitó el bloque anterior (fuera de horario / away sin interactivo).
       */
      const comprobanteUnified = extractInboundComprobanteMedia(msg);
      if (
        comprobanteUnified &&
        !interactiveInboundMetaId &&
        !keywordHandoffPendingConfirmation
      ) {
        const fsImg = String((existingConv as { flow_status?: string | null }).flow_status ?? "bot")
          .trim()
          .toLowerCase();
        const htImg = Boolean((existingConv as { human_taken_over?: boolean | null }).human_taken_over);

        console.info("[flow-image-input]", "[candidate]", {
          conversationId,
          waMessageId: waMid,
          mediaId: comprobanteUnified.mediaId,
          message_type,
          skipFlowForBusinessAutomation,
          flow_status: fsImg,
          human_taken_over: htImg,
          flow_current_node:
            (existingConv as { flow_current_node?: string | null }).flow_current_node ?? null,
        });

        let skippedReason: string | null = null;
        if (htImg || fsImg === "human") {
          skippedReason = "human_mode";
        }

        let fallbackPublicUrl: string | undefined;
        let fallbackMimeType: string | undefined;
        const { data: msgRow } = await supabase
          .from("chat_messages")
          .select("raw_payload")
          .eq("id", inboundRowId)
          .maybeSingle();
        const rp = msgRow?.raw_payload as Record<string, unknown> | undefined;
        const erp = rp?.erp as Record<string, unknown> | undefined;
        if (erp && typeof erp.public_url === "string" && erp.public_url.trim()) {
          fallbackPublicUrl = erp.public_url.trim();
        }
        if (erp && typeof erp.mime_type === "string" && erp.mime_type.trim()) {
          fallbackMimeType = erp.mime_type.trim();
        }

        if (skippedReason) {
          console.info("[flow-image-input]", "[skipped-reason]", {
            conversationId,
            waMessageId: waMid,
            skippedReason,
          });
        } else {
          const alreadyRecorded = await flowImageInboundAlreadyRecorded(supabase, conversationId, waMid);
          if (alreadyRecorded) {
            console.info("[flow-image-input]", "[skipped-reason]", {
              conversationId,
              waMessageId: waMid,
              skippedReason: "already_recorded",
            });
          } else {
            console.info("[flow-image-input]", "[calling-processImageReply]", {
              conversationId,
              waMessageId: waMid,
              hasFallbackUrl: Boolean(fallbackPublicUrl),
            });
            try {
              const imageUnifiedResult = await flowEngine.processImageReply({
                conversationId,
                empresaId,
                mediaId: comprobanteUnified.mediaId,
                mimeType: comprobanteUnified.mimeType,
                caption: comprobanteUnified.caption,
                rawPayload: msg as unknown as Record<string, unknown>,
                fallbackPublicUrl: fallbackPublicUrl ?? null,
                fallbackMimeType: fallbackMimeType ?? null,
                waMessageId: waMid,
              });
              console.info("[flow-image-input]", "[result]", {
                conversationId,
                waMessageId: waMid,
                ok: imageUnifiedResult.ok,
                status: imageUnifiedResult.status,
                nextNodeCode: imageUnifiedResult.nextNodeCode ?? null,
              });
              console.info(logW, "flow_result: comprobante_media_unified", {
                conversationId,
                mediaId: comprobanteUnified.mediaId,
                sourceType: comprobanteUnified.sourceType,
                messageTypeFromMeta: msg.type ?? null,
                status: imageUnifiedResult.status,
                nextNodeCode: imageUnifiedResult.nextNodeCode ?? null,
              });
              if (!imageUnifiedResult.ok) {
                errors.push(`Flow comprobante: ${imageUnifiedResult.error ?? imageUnifiedResult.status}`);
                console.warn("[flow-image-input]", "[error]", {
                  conversationId,
                  waMessageId: waMid,
                  status: imageUnifiedResult.status,
                  error: imageUnifiedResult.error ?? null,
                });
              }
            } catch (imgEx) {
              const em = imgEx instanceof Error ? imgEx.message : String(imgEx);
              errors.push(`Flow comprobante: ${em}`);
              console.error("[flow-image-input]", "[error]", {
                conversationId,
                waMessageId: waMid,
                exception: em,
              });
            }
          }
        }
      }

      processed += 1;
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
      /**
       * Una excepción en cualquier paso intermedio del webhook (asignación, CRM, catálogo,
       * intención de compra, present, etc.) abortaba el mensaje: quedaba guardado pero el motor
       * nunca lo procesaba y el cliente quedaba MUDO en un paso de captura.
       * Acá, best-effort (sin relanzar nunca):
       *  (1) registramos el error EXACTO en la base para auditar qué paso rompe, y
       *  (2) si es un texto, re-presentamos el nodo actual para que el cliente reciba la pregunta
       *      vigente al instante en vez de quedar mudo. Re-presentar NO captura → no cruza datos.
       */
      if (diagConversationId) {
        try {
          await supabase.from("chat_flow_events").insert({
            empresa_id: empresaId,
            conversation_id: diagConversationId,
            flow_code: null,
            node_code: null,
            event_type: "webhook_message_exception",
            payload: {
              error: e instanceof Error ? e.message : String(e),
              stack: e instanceof Error ? (e.stack ?? "").slice(0, 600) : null,
              wa_message_id: msg.id ?? null,
              message_type: String(msg.type ?? ""),
            },
          });
        } catch {
          /* no-op */
        }
        if (diagIsTextMsg) {
          try {
            await createFlowEngine({ supabase }).sendCurrentFlowNode({
              conversationId: diagConversationId,
            });
          } catch {
            /* no-op */
          }
        }
      }
    }
  }

  return {
    ok: errors.length === 0 || processed > 0,
    processed,
    skipped,
    errors,
    inboundDurableWrite,
  };
}

/**
 * Extrae bloques `value` como los envía Meta en `entry[].changes[]`, o el mismo objeto
 * si n8n (u otro proxy) reenvía solo el `value` en la raíz del JSON.
 */
export function collectMetaWebhookMessageValues(body: unknown): MetaWebhookValue[] {
  const out: MetaWebhookValue[] = [];
  if (!body || typeof body !== "object") return out;

  // n8n a veces serializa el lote como array con un ítem por mensaje
  if (Array.isArray(body)) {
    for (const item of body) {
      out.push(...collectMetaWebhookMessageValues(item));
    }
    return out;
  }

  const root = body as Record<string, unknown>;
  const entries = (root.entry as Array<{ changes?: unknown[] }> | undefined) ?? [];

  for (const ent of entries) {
    const changes = ent.changes ?? [];
    for (const ch of changes) {
      const change = ch as { value?: MetaWebhookValue; field?: string };
      if (change.field === "statuses") continue;
      const value = change.value;
      if (value?.messages?.length) out.push(value);
    }
  }

  if (out.length > 0) return out;

  // Payload plano (p. ej. n8n): mismo shape que `change.value` de Meta
  const field = typeof root.field === "string" ? root.field : undefined;
  if (field === "statuses") return out;

  const metadata = root.metadata as { phone_number_id?: string } | undefined;
  const phoneNumberId = metadata?.phone_number_id?.trim();
  const messages = root.messages;
  if (phoneNumberId && Array.isArray(messages) && messages.length > 0) {
    out.push(body as MetaWebhookValue);
  }

  return out;
}

async function resolveStatusChannelContext(
  catalogSupabase: SupabaseAdmin,
  phoneNumberId: string
): Promise<{ ok: true; ctx: StatusChannelContext } | { ok: false; error: string }> {
  const pool = getChatPostgresPool();
  let channel: WhatsappChannelRow | null = null;
  let dataSchema: string = SUPABASE_APP_SCHEMA;
  let dataSupabase: SupabaseAdmin = catalogSupabase;

  const routeRow = await fetchOmnichannelRouteByMetaPhone(catalogSupabase, phoneNumberId);
  if (routeRow) {
    dataSchema = resolveEmpresaDataSchema(routeRow.data_schema || null);
    console.info(`${WH_STATUS}[channel-resolved]`, {
      phone_number_id: phoneNumberId,
      schema: dataSchema,
      empresa_id: routeRow.empresa_id,
      channel_id: routeRow.channel_id,
      source: "omnichannel_route",
    });

    if (pool && isLikelyUnexposedTenantChatSchema(dataSchema) && dataSchema !== SUPABASE_APP_SCHEMA) {
      channel = await pgLoadWhatsappChannelById(pool, dataSchema, routeRow.channel_id, routeRow.empresa_id);
      dataSupabase = catalogSupabase;
    } else {
      dataSupabase =
        dataSchema === SUPABASE_APP_SCHEMA
          ? catalogSupabase
          : (createServiceRoleClientWithDbSchema(dataSchema) as SupabaseAdmin);
      const { data, error } = await dataSupabase
        .from("chat_channels")
        .select("id, empresa_id, meta_phone_number_id, activo")
        .eq("id", routeRow.channel_id)
        .maybeSingle();
      if (error) return { ok: false, error: error.message };
      channel = data as WhatsappChannelRow | null;
    }
  } else {
    const { data, error } = await catalogSupabase
      .from("chat_channels")
      .select("id, empresa_id, meta_phone_number_id, activo")
      .eq("meta_phone_number_id", phoneNumberId)
      .maybeSingle();
    if (error) return { ok: false, error: error.message };
    channel = data as WhatsappChannelRow | null;

    if (!channel) {
      const tenantHit = await findWhatsappChannelInTenantSchemas(catalogSupabase, phoneNumberId);
      if (tenantHit) {
        channel = tenantHit.channel;
        dataSchema = tenantHit.dataSchema;
        dataSupabase = tenantHit.dataSupabase;
      }
    }
  }

  if (!channel) {
    return { ok: false, error: `Canal no registrado para phone_number_id=${phoneNumberId}` };
  }
  if (channel.activo === false) {
    return { ok: false, error: "El canal WhatsApp está desactivado" };
  }

  const empresaId = channel.empresa_id;
  dataSchema = dataSchema === SUPABASE_APP_SCHEMA ? await fetchDataSchemaForEmpresaId(empresaId) : dataSchema;
  const useTenantPg = Boolean(pool && isLikelyUnexposedTenantChatSchema(dataSchema));
  const supabase: SupabaseAdmin =
    useTenantPg && pool
      ? createTenantPgChatSupabaseShim({
          pool,
          schema: dataSchema,
          storageDelegate: catalogSupabase,
          rpcDelegate: catalogSupabase as AppSupabaseClient,
        })
      : dataSchema === SUPABASE_APP_SCHEMA
        ? catalogSupabase
        : (createServiceRoleClientWithDbSchema(dataSchema) as SupabaseAdmin);

  console.info(`${WH_STATUS}[channel-resolved]`, {
    phone_number_id: phoneNumberId,
    schema: dataSchema,
    empresa_id: empresaId,
    channel_id: channel.id,
    provider: "meta",
    storage: useTenantPg ? "postgres_directo" : "postgrest",
  });

  return {
    ok: true,
    ctx: {
      channel,
      empresaId,
      dataSchema,
      useTenantPg,
      pool: pool ?? null,
      supabase,
    },
  };
}

async function loadTableColumns(pool: Pool, schema: string, table: string): Promise<Set<string>> {
  const r = await pool.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = $2`,
    [schema, table]
  );
  return new Set(r.rows.map((row: { column_name: string }) => row.column_name));
}

async function applyWhatsappStatusPg(
  ctx: StatusChannelContext,
  status: MetaWhatsappStatus,
  nextStatus: MetaWhatsappStatusName
): Promise<"updated" | "skipped" | "not_found"> {
  if (!ctx.pool) return "not_found";
  const schema = assertAllowedChatDataSchema(ctx.dataSchema);
  const msgT = quoteSchemaTable(schema, "chat_messages");
  const convT = quoteSchemaTable(schema, "chat_conversations");
  const cols = await loadTableColumns(ctx.pool, schema, "chat_messages");
  const id = status.id?.trim() ?? "";
  const idClauses = ["m.wa_message_id = $3"];
  if (cols.has("provider_message_id")) idClauses.push("m.provider_message_id = $3");

  const found = await ctx.pool.query(
    `SELECT m.id::text, m.whatsapp_delivery_status, m.raw_payload
     FROM ${msgT} m
     JOIN ${convT} c ON c.id = m.conversation_id
     WHERE m.empresa_id = $1::uuid
       AND c.channel_id = $2::uuid
       AND (${idClauses.join(" OR ")})
     LIMIT 1`,
    [ctx.empresaId, ctx.channel.id, id]
  );
  const row = found.rows[0] as
    | { id: string; whatsapp_delivery_status: string | null; raw_payload: unknown }
    | undefined;
  if (!row) return "not_found";
  if (!shouldApplyWhatsappStatus(row.whatsapp_delivery_status, nextStatus)) return "skipped";

  const receivedAt = new Date().toISOString();
  const timestampIso = metaStatusTimestampToIso(status.timestamp);
  const rawPayload = {
    ...recordFromUnknown(row.raw_payload),
    neura_meta_status: compactMetaStatusPayload(status, receivedAt),
  };
  const error = firstMetaStatusError(status);

  const sets: string[] = [];
  const params: unknown[] = [row.id];
  const addSet = (col: string, value: unknown, cast = "") => {
    if (!cols.has(col)) return;
    params.push(value);
    sets.push(`${col} = $${params.length}${cast}`);
  };

  addSet("whatsapp_delivery_status", nextStatus);
  if (nextStatus === "sent") addSet("whatsapp_sent_at", timestampIso);
  if (nextStatus === "delivered") addSet("whatsapp_delivered_at", timestampIso);
  if (nextStatus === "read") addSet("whatsapp_read_at", timestampIso);
  if (nextStatus === "failed") {
    addSet("whatsapp_failed_at", timestampIso);
    addSet("error_code", error.code);
    addSet("error_message", error.message);
  }
  addSet("raw_payload", JSON.stringify(rawPayload), "::jsonb");

  if (sets.length === 0) return "skipped";
  await ctx.pool.query(`UPDATE ${msgT} SET ${sets.join(", ")} WHERE id = $1::uuid`, params);

  console.info(`${WH_STATUS}[message-updated]`, {
    schema: ctx.dataSchema,
    empresa_id: ctx.empresaId,
    channel_id: ctx.channel.id,
    message_id: row.id,
    wamid: id,
    status: nextStatus,
    recipient_id: status.recipient_id ?? null,
    error_code: error.code,
  });
  return "updated";
}

async function applyWhatsappStatusPostgrest(
  ctx: StatusChannelContext,
  status: MetaWhatsappStatus,
  nextStatus: MetaWhatsappStatusName
): Promise<"updated" | "skipped" | "not_found"> {
  const id = status.id?.trim() ?? "";
  const { data, error } = await ctx.supabase
    .from("chat_messages")
    .select("id, whatsapp_delivery_status, raw_payload")
    .eq("empresa_id", ctx.empresaId)
    .eq("wa_message_id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const row = data as
    | { id: string; whatsapp_delivery_status?: string | null; raw_payload?: unknown }
    | null;
  if (!row) return "not_found";
  if (!shouldApplyWhatsappStatus(row.whatsapp_delivery_status, nextStatus)) return "skipped";

  const receivedAt = new Date().toISOString();
  const timestampIso = metaStatusTimestampToIso(status.timestamp);
  const patch: Record<string, unknown> = {
    whatsapp_delivery_status: nextStatus,
    raw_payload: {
      ...recordFromUnknown(row.raw_payload),
      neura_meta_status: compactMetaStatusPayload(status, receivedAt),
    },
  };
  if (nextStatus === "delivered") patch.whatsapp_delivered_at = timestampIso;
  if (nextStatus === "read") patch.whatsapp_read_at = timestampIso;

  const { error: updErr } = await ctx.supabase.from("chat_messages").update(patch).eq("id", row.id);
  if (updErr) throw new Error(updErr.message);

  const statusError = firstMetaStatusError(status);
  console.info(`${WH_STATUS}[message-updated]`, {
    schema: ctx.dataSchema,
    empresa_id: ctx.empresaId,
    channel_id: ctx.channel.id,
    message_id: row.id,
    wamid: id,
    status: nextStatus,
    recipient_id: status.recipient_id ?? null,
    error_code: statusError.code,
  });
  return "updated";
}

async function processWhatsappStatusValue(
  catalogSupabase: SupabaseAdmin,
  value: MetaWebhookStatusValue
): Promise<ProcessWebhookResult> {
  const errors: string[] = [];
  let processed = 0;
  let skipped = 0;
  const phoneNumberId = value.metadata?.phone_number_id?.trim();
  if (!phoneNumberId) {
    return { ok: false, processed: 0, skipped: 0, errors: ["Falta metadata.phone_number_id en status"] };
  }

  const resolved = await resolveStatusChannelContext(catalogSupabase, phoneNumberId);
  if (!resolved.ok) {
    console.warn(`${WH_STATUS}[failed]`, { phone_number_id: phoneNumberId, error: resolved.error });
    return { ok: false, processed: 0, skipped: 0, errors: [resolved.error] };
  }

  for (const status of value.statuses ?? []) {
    const wamid = status.id?.trim() ?? "";
    const nextStatus = normalizeMetaWhatsappStatus(status.status);
    console.info(`${WH_STATUS}[received]`, {
      phone_number_id: phoneNumberId,
      schema: resolved.ctx.dataSchema,
      empresa_id: resolved.ctx.empresaId,
      channel_id: resolved.ctx.channel.id,
      wamid: wamid || null,
      status: status.status ?? null,
      recipient_id: status.recipient_id ?? null,
      error_code: firstMetaStatusError(status).code,
    });

    if (!wamid || !nextStatus) {
      skipped += 1;
      errors.push("Status sin id o estado soportado");
      continue;
    }

    try {
      const outcome =
        resolved.ctx.useTenantPg && resolved.ctx.pool
          ? await applyWhatsappStatusPg(resolved.ctx, status, nextStatus)
          : await applyWhatsappStatusPostgrest(resolved.ctx, status, nextStatus);
      if (outcome === "updated") processed += 1;
      else {
        skipped += 1;
        if (outcome === "not_found") {
          console.info(`${WH_STATUS}[message-not-found]`, {
            phone_number_id: phoneNumberId,
            schema: resolved.ctx.dataSchema,
            empresa_id: resolved.ctx.empresaId,
            channel_id: resolved.ctx.channel.id,
            wamid,
            status: nextStatus,
            recipient_id: status.recipient_id ?? null,
          });
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(message);
      console.warn(`${WH_STATUS}[failed]`, {
        phone_number_id: phoneNumberId,
        schema: resolved.ctx.dataSchema,
        empresa_id: resolved.ctx.empresaId,
        channel_id: resolved.ctx.channel.id,
        wamid,
        status: nextStatus,
        error: message,
      });
    }
  }

  return { ok: errors.length === 0, processed, skipped, errors };
}

export async function processWhatsAppWebhookStatuses(
  catalogSupabase: SupabaseAdmin,
  body: unknown
): Promise<ProcessWebhookResult> {
  const values = collectMetaWebhookStatusValues(body);
  const aggregated: ProcessWebhookResult = { ok: true, processed: 0, skipped: 0, errors: [] };
  for (const value of values) {
    const result = await processWhatsappStatusValue(catalogSupabase, value);
    aggregated.processed += result.processed;
    aggregated.skipped += result.skipped;
    aggregated.errors.push(...result.errors);
    if (!result.ok) aggregated.ok = false;
  }
  return aggregated;
}

/**
 * Recorre el body completo del webhook Meta (o el `value` reenviado en la raíz).
 */
export async function processWhatsAppWebhookBody(
  supabase: SupabaseAdmin,
  body: unknown,
  provisionEnv?: WebhookProvisionEnv
): Promise<ProcessWebhookResult> {
  const aggregated: ProcessWebhookResult = {
    ok: true,
    processed: 0,
    skipped: 0,
    errors: [],
  };

  if (!body || typeof body !== "object") {
    aggregated.ok = false;
    aggregated.errors.push("Body inválido");
    return aggregated;
  }

  const statusResult = await processWhatsAppWebhookStatuses(supabase, body);
  aggregated.processed += statusResult.processed;
  aggregated.skipped += statusResult.skipped;
  aggregated.errors.push(...statusResult.errors);
  if (!statusResult.ok) aggregated.ok = false;

  const values = collectMetaWebhookMessageValues(body);

  for (const value of values) {
    const r = await processInboundWebhookValue(supabase, value, provisionEnv);
    aggregated.processed += r.processed;
    aggregated.skipped += r.skipped;
    aggregated.errors.push(...r.errors);
    if (!r.ok) aggregated.ok = false;
    if (r.inboundDurableWrite) aggregated.inboundDurableWrite = true;
  }

  return aggregated;
}
