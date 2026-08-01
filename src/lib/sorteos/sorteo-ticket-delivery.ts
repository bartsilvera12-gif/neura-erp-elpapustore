import "server-only";

import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { createServiceRoleClient } from "@/lib/supabase/service-admin";
import type { AppSupabaseClient } from "@/lib/supabase/schema";
import { fetchSorteoRowTicketFieldsFromPg } from "@/lib/sorteos/sorteo-order-direct-pg";
import { persistOutgoingChatMessage } from "@/lib/chat/outgoing-message-persist";
import { resolveOutboundTextContextFromIds } from "@/lib/chat/outbound-send-dispatch";
import { sendWhatsAppImage } from "@/lib/chat/whatsapp-send-service";
import { sendYCloudWhatsappMediaViaLink } from "@/lib/chat/ycloud-send-service";
import type { EnsureSorteoOrderCreatedData } from "@/lib/sorteos/sorteo-order-from-chat";
import { flowDataStubFromEntrada, loadSorteoTicketEntradaDbSnapshot } from "@/lib/sorteos/sorteo-ticket-admin";
import {
  buildSorteoTicketRenderData,
  buildSorteoTicketRenderLogPayload,
} from "@/lib/sorteos/sorteo-ticket-render-data";
import {
  normalizeTicketImageConfig,
  SORTEO_TICKET_DEFAULT_STUB,
  type SorteoTicketDeliveryMode,
} from "@/lib/sorteos/sorteo-ticket-types";
import { renderTicketPngUnified, type SorteoTicketRenderInput } from "@/lib/sorteos/sorteo-ticket-render";
import {
  createSignedUrlForTicket,
  downloadAssetIfExists,
  ensureTicketBucketsExist,
  SORTEO_TICKET_ASSETS_BUCKET,
  SORTEO_TICKET_GENERATED_BUCKET,
  sorteoTicketAssetBackgroundPath,
  sorteoTicketAssetLogoPath,
  sorteoTicketAssetTemplateCandidates,
  sorteoTicketGeneratedPath,
  uploadGeneratedTicketPng,
} from "@/lib/sorteos/sorteo-ticket-storage";

export type SorteoTicketTrigger = "confirmacion_final" | "comprobante_imagen";

type DeliveryRow = {
  id: string;
  status: string;
  template_revision: number;
  is_current: boolean;
};

function safeErr(e: unknown): string {
  if (e instanceof Error) {
    const m = e.message;
    if (/key|token|password|secret|bearer|api-?key/i.test(m)) return "error_interno";
    return m.slice(0, 500);
  }
  return "error_desconocido";
}

async function loadEmpresaNombre(empresaId: string): Promise<string> {
  const catalog = createServiceRoleClient();
  const { data } = await catalog
    .from("empresas")
    .select("nombre")
    .eq("id", empresaId)
    .maybeSingle();
  const n = (data as { nombre?: string } | null)?.nombre;
  return (typeof n === "string" && n.trim() ? n.trim() : "Empresa");
}

/** Shim del webhook (`sorteos` por PG) o catálogo; si PostgREST falla en tenant, fallback SQL directo. */
async function loadSorteoRowForTicket(input: {
  supabase: AppSupabaseClient;
  empresaId: string;
  sorteoId: string;
}): Promise<{
  nombre: string;
  ticket_delivery_mode: SorteoTicketDeliveryMode | undefined;
  ticket_image_config: unknown;
} | null> {
  const { data, error } = await input.supabase
    .from("sorteos")
    .select("id, nombre, ticket_delivery_mode, ticket_image_config")
    .eq("id", input.sorteoId)
    .maybeSingle();
  if (!error && data) {
    return {
      nombre: String((data as { nombre?: string }).nombre ?? "").trim(),
      ticket_delivery_mode: (data as { ticket_delivery_mode?: string }).ticket_delivery_mode as
        | SorteoTicketDeliveryMode
        | undefined,
      ticket_image_config: (data as { ticket_image_config?: unknown }).ticket_image_config,
    };
  }
  const schema = await fetchDataSchemaForEmpresaId(input.empresaId);
  const pg = await fetchSorteoRowTicketFieldsFromPg(schema, input.sorteoId);
  if (!pg) {
    if (error) {
      console.warn("[sorteo-ticket] sorteo_row_pg_fallback_miss", {
        sorteoId: String(input.sorteoId).slice(0, 8),
        message: error.message,
      });
    }
    return null;
  }
  return {
    nombre: String(pg.nombre ?? "").trim(),
    ticket_delivery_mode: pg.ticket_delivery_mode as SorteoTicketDeliveryMode | undefined,
    ticket_image_config: pg.ticket_image_config,
  };
}

async function loadChatFlowDataNewestPerField(
  sb: AppSupabaseClient,
  conversationId: string
): Promise<Record<string, string>> {
  const cid = conversationId.trim();
  if (!cid) return {};
  const { data, error } = await sb
    .from("chat_flow_data")
    .select("field_name, field_value, updated_at")
    .eq("conversation_id", cid)
    .order("updated_at", { ascending: false });
  if (error || !data?.length) {
    if (error) {
      console.warn("[sorteo-ticket] chat_flow_data_load_warn", { message: error.message });
    }
    return {};
  }
  const out: Record<string, string> = {};
  for (const row of data as { field_name?: string; field_value?: unknown }[]) {
    const fn = typeof row.field_name === "string" ? row.field_name.trim() : "";
    if (!fn || fn in out) continue;
    out[fn] = String(row.field_value ?? "").trim();
  }
  return out;
}

async function mergeFlowDataForTicketRender(params: {
  supabase: AppSupabaseClient;
  conversationId: string | null;
  entradaId: string;
  flowData: Record<string, string>;
}): Promise<Record<string, string>> {
  const chatMap = params.conversationId?.trim()
    ? await loadChatFlowDataNewestPerField(params.supabase, params.conversationId)
    : {};
  /** Base: historial del chat; no pisar con vacíos del caller (p. ej. stub de regenerar). */
  const merged: Record<string, string> = { ...chatMap };
  for (const [k, v] of Object.entries(params.flowData)) {
    const t = (v ?? "").trim();
    if (t) merged[k] = t;
  }
  try {
    const stub = await flowDataStubFromEntrada(params.supabase, params.entradaId);
    for (const [k, v] of Object.entries(stub)) {
      const cur = (merged[k] ?? "").trim();
      const nv = (v ?? "").trim();
      if (!cur && nv) merged[k] = nv;
    }
  } catch (e) {
    console.warn("[sorteo-ticket] entrada_stub_merge_skip", {
      message: e instanceof Error ? e.message : String(e),
    });
  }
  return merged;
}

export type MaybeGenerateAndSendSorteoTicketDeliveryInput = {
  supabase: AppSupabaseClient;
  empresaId: string;
  sorteoId: string;
  entradaId: string;
  conversationId: string | null;
  flowSessionId: string | null;
  contactId: string;
  channelId: string;
  orderResult: EnsureSorteoOrderCreatedData;
  flowData: Record<string, string>;
  trigger: SorteoTicketTrigger;
  /** Solo generar PNG + storage; sin WhatsApp (p. ej. regenerar diseño desde panel). */
  skipWhatsApp?: boolean;
};

export type MaybeGenerateAndSendSorteoTicketDeliveryResult = {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  deliveryId?: string;
  lastStatus?: "pending" | "generated" | "sent" | "error";
  storageBucket?: string | null;
  storagePath?: string | null;
  whatsappMessageId?: string | null;
  provider?: string | null;
  /** Solo dry-run: signed URL creada y HEAD OK sobre el PNG */
  signedUrlCreated?: boolean;
  signedUrlHeadOk?: boolean;
  signedUrlError?: string | null;
};

/**
 * Genera PNG, sube a storage, envía por WhatsApp. Errores: no lanza; registra fila `error`.
 */
export async function maybeGenerateAndSendSorteoTicketDelivery(
  input: MaybeGenerateAndSendSorteoTicketDeliveryInput
): Promise<MaybeGenerateAndSendSorteoTicketDeliveryResult> {
  const {
    supabase,
    empresaId,
    sorteoId,
    entradaId,
    conversationId,
    flowSessionId,
    orderResult,
    flowData,
    trigger,
  } = input;

  console.info("[sorteo-ticket] delivery_start", {
    entradaId,
    sorteoId,
    trigger,
    empresaId,
    conversationId,
    skipWhatsApp: Boolean(input.skipWhatsApp),
  });

  const schema = await fetchDataSchemaForEmpresaId(empresaId);
  const db = supabase;

  const sorteoRow = await loadSorteoRowForTicket({ supabase, empresaId, sorteoId });
  if (!sorteoRow) {
    console.warn("[sorteo-ticket] sorteo_not_found", { sorteoId: String(sorteoId).slice(0, 8) });
    return { ok: true, skipped: true, reason: "sorteo_not_found" };
  }
  console.info("[sorteo-ticket] mode_resolved", {
    source: "delivery_fn",
    entradaId,
    raw_mode: sorteoRow.ticket_delivery_mode ?? null,
    nombre_present: Boolean(sorteoRow.nombre?.trim()),
  });

  const mode = sorteoRow.ticket_delivery_mode;
  const effectiveMode: SorteoTicketDeliveryMode = mode ?? "text_only";
  if (effectiveMode === "text_only") {
    console.info("[sorteo-ticket] skipped_text_only", { entradaId, phase: "delivery_fn" });
    return { ok: true, skipped: true, reason: "text_only" };
  }

  const config = normalizeTicketImageConfig(sorteoRow.ticket_image_config);
  const sorteoNombre = sorteoRow.nombre || "Sorteo";

  const { data: existList } = await db
    .from("sorteo_ticket_deliveries")
    .select("id, status, template_revision, is_current")
    .eq("entrada_id", entradaId)
    .eq("is_current", true)
    .limit(1);
  const current = (existList?.[0] ?? null) as DeliveryRow | null;
  if (current?.status === "sent") {
    console.info("[sorteo-ticket] skipped_already_sent", {
      entradaId,
      deliveryId: current?.id,
      status: current?.status,
    });
    return {
      ok: true,
      skipped: true,
      reason: "already_sent",
      deliveryId: current?.id,
      lastStatus: "sent",
    };
  }

  const { data: maxRows } = await db
    .from("sorteo_ticket_deliveries")
    .select("template_revision")
    .eq("entrada_id", entradaId)
    .order("template_revision", { ascending: false })
    .limit(1);
  const maxRev = Number((maxRows?.[0] as { template_revision?: number } | undefined)?.template_revision ?? 0) || 0;

  const templateRevision = current ? current.template_revision : maxRev + 1;
  const deliveryId = current?.id;

  const flowDataMerged = await mergeFlowDataForTicketRender({
    supabase: db,
    conversationId,
    entradaId,
    flowData,
  });
  const { data: prevPayloadRow } = await db
    .from("sorteo_ticket_deliveries")
    .select("payload_snapshot")
    .eq("entrada_id", entradaId)
    .eq("empresa_id", empresaId)
    .order("template_revision", { ascending: false })
    .limit(1)
    .maybeSingle();
  const prevPayloadRaw = (prevPayloadRow as { payload_snapshot?: unknown } | null)?.payload_snapshot;
  const prevPayload =
    prevPayloadRaw != null && typeof prevPayloadRaw === "object" && !Array.isArray(prevPayloadRaw)
      ? (prevPayloadRaw as Record<string, unknown>)
      : null;

  const entradaDb = await loadSorteoTicketEntradaDbSnapshot(db, entradaId, empresaId);
  const { fields: normalized, sourceUsed } = buildSorteoTicketRenderData({
    entradaDb,
    flowData: flowDataMerged,
    orderResult,
    sorteoNombreCatalog: sorteoNombre,
    payloadSnapshot: prevPayload,
  });

  console.info("[sorteo-ticket] render_data_resolved", {
    entradaId,
    sorteoId,
    trigger,
    ...buildSorteoTicketRenderLogPayload({ fields: normalized, sourceUsed }),
  });

  const payloadSnapshot = {
    trigger,
    idempotent: orderResult.idempotent,
    cupones: normalized.cupones,
    sorteo_nombre: normalized.sorteoNombre,
  };

  const numeroOrdenRow = (normalized.numeroOrden || "").trim() || String(orderResult.numeroOrden);

  let rowId = deliveryId ?? "";
  if (!rowId) {
    const ins = await db
      .from("sorteo_ticket_deliveries")
      .insert({
        empresa_id: empresaId,
        sorteo_id: sorteoId,
        entrada_id: entradaId,
        conversation_id: conversationId?.trim() || null,
        flow_session_id:
          flowSessionId && /^[0-9a-f-]{36}$/i.test(flowSessionId.trim()) ? flowSessionId.trim() : null,
        delivery_mode: effectiveMode,
        status: "pending",
        cliente_nombre: normalized.clienteNombre.trim() || null,
        cliente_documento: normalized.documento.trim() || null,
        telefono: normalized.telefono.trim() || null,
        numero_orden: numeroOrdenRow,
        cupones: orderResult.cupones.map((c) => ({ id: c.id, numero_cupon: c.numero_cupon })),
        payload_snapshot: payloadSnapshot,
        config_snapshot: config as Record<string, unknown>,
        template_revision: templateRevision,
        is_current: true,
      })
      .select("id")
      .maybeSingle();
    if (ins.error || !ins.data) {
      console.warn("[sorteo-ticket] insert_pending_failed", { message: ins.error?.message });
      return { ok: false, skipped: false, reason: "insert_failed" };
    }
    rowId = (ins.data as { id: string }).id;
    console.info("[sorteo-ticket] delivery_saved", {
      deliveryId: rowId,
      status: "pending",
      phase: "insert",
    });
  } else if (current?.status === "error") {
    await db
      .from("sorteo_ticket_deliveries")
      .update({
        status: "pending",
        error_message: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", rowId);
  }

  try {
    await ensureTicketBucketsExist(supabase);

    console.info("[sorteo-ticket] render_start", { deliveryId: rowId, entradaId });

    const empresaNombre = await loadEmpresaNombre(empresaId);
    const logoPath = sorteoTicketAssetLogoPath(empresaId, sorteoId);
    const bgPath = sorteoTicketAssetBackgroundPath(empresaId, sorteoId);
    let logoDl = await downloadAssetIfExists(supabase, SORTEO_TICKET_ASSETS_BUCKET, logoPath);
    if (!logoDl) {
      logoDl = await downloadAssetIfExists(
        supabase,
        SORTEO_TICKET_ASSETS_BUCKET,
        `${empresaId}/${sorteoId}/logo.webp`
      );
    }
    const bgDl = await downloadAssetIfExists(supabase, SORTEO_TICKET_ASSETS_BUCKET, bgPath);

    let templateDl: { bytes: Buffer; mime: string } | null = null;
    if ((config.design_mode ?? "auto") === "custom_template") {
      const tb = config.custom_template_storage_bucket?.trim() || SORTEO_TICKET_ASSETS_BUCKET;
      const tp = config.custom_template_storage_path?.trim();
      if (tp) {
        templateDl = await downloadAssetIfExists(supabase, tb, tp);
      }
      if (!templateDl) {
        for (const cand of sorteoTicketAssetTemplateCandidates(empresaId, sorteoId)) {
          templateDl = await downloadAssetIfExists(supabase, SORTEO_TICKET_ASSETS_BUCKET, cand);
          if (templateDl) break;
        }
      }
    }

    const fechaHora = new Date().toLocaleString("es-PY", {
      dateStyle: "short",
      timeStyle: "short",
    });

    const renderInput: SorteoTicketRenderInput = {
      empresaNombre,
      sorteoNombre: (normalized.sorteoNombre || orderResult.sorteoNombre || sorteoNombre).trim(),
      clienteNombre: normalized.clienteNombre.trim() || undefined,
      documento: normalized.documento.trim() || undefined,
      telefono: normalized.telefono.trim() || undefined,
      ciudad: normalized.ciudad.trim() || undefined,
      numeroOrden: (normalized.numeroOrden || "").trim() || String(orderResult.numeroOrden),
      cupones: normalized.cupones,
      fechaHora,
      config,
      logoBytes: logoDl?.bytes ?? null,
      logoMime: logoDl?.mime ?? null,
      backgroundBytes: bgDl?.bytes ?? null,
      backgroundMime: bgDl?.mime ?? null,
      templateBytes: templateDl?.bytes ?? null,
      templateMime: templateDl?.mime ?? null,
    };

    const { png, hash } = await renderTicketPngUnified(renderInput);
    const genPath = sorteoTicketGeneratedPath(empresaId, sorteoId, entradaId, templateRevision);
    const up = await uploadGeneratedTicketPng(supabase, genPath, png);
    if (up.error) {
      throw new Error(up.error);
    }

    console.info("[sorteo-ticket] storage_uploaded", {
      bucket: SORTEO_TICKET_GENERATED_BUCKET,
      storage_path: genPath,
      deliveryId: rowId,
    });

    await db
      .from("sorteo_ticket_deliveries")
      .update({
        status: "generated",
        storage_bucket: "sorteo-tickets-generated",
        storage_path: genPath,
        png_bytes_hash: hash,
        generated_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", rowId);

    console.info("[sorteo-ticket] delivery_saved", {
      deliveryId: rowId,
      status: "generated",
      storage_path: genPath,
    });

    if (input.skipWhatsApp) {
      const signedDry = await createSignedUrlForTicket(supabase, genPath, 600);
      let headOk = false;
      if (signedDry.url) {
        try {
          const head = await fetch(signedDry.url, { method: "HEAD" });
          headOk = head.ok;
        } catch {
          headOk = false;
        }
      }
      console.info("[sorteo-ticket] signed_url_created", {
        deliveryId: rowId,
        hasUrl: Boolean(signedDry.url),
        signedUrlHeadOk: headOk,
        phase: "dry_run",
      });
      return {
        ok: true,
        deliveryId: rowId,
        lastStatus: "generated",
        storageBucket: "sorteo-tickets-generated",
        storagePath: genPath,
        signedUrlCreated: Boolean(signedDry.url),
        signedUrlHeadOk: headOk,
        signedUrlError: signedDry.error ?? null,
      };
    }

    const signed = await createSignedUrlForTicket(supabase, genPath, 600);
    if (!signed.url) {
      throw new Error(signed.error ?? "signed_url");
    }

    console.info("[sorteo-ticket] signed_url_created", {
      deliveryId: rowId,
      hasUrl: true,
    });

    let outbound: Awaited<ReturnType<typeof resolveOutboundTextContextFromIds>>;
    try {
      outbound = await resolveOutboundTextContextFromIds(
        supabase,
        { contactId: input.contactId, channelId: input.channelId },
        { dataSchema: schema, empresaId }
      );
    } catch (e) {
      throw new Error(safeErr(e));
    }

    const caption =
      (config.caption ?? "").trim() ||
      (config.title ?? "").trim() ||
      `Orden Nº ${orderResult.numeroOrden} — ${sorteoNombre}`.slice(0, 1024);

    console.info("[sorteo-ticket] whatsapp_send_start", {
      deliveryId: rowId,
      provider: outbound.provider,
      channelId: input.channelId,
      contactId: input.contactId,
    });

    let sendResult: { ok: boolean; waMessageId?: string | null; raw?: unknown; error?: string };
    if (outbound.provider === "ycloud") {
      sendResult = await sendYCloudWhatsappMediaViaLink({
        apiKey: outbound.apiKey,
        fromE164: outbound.fromE164,
        toDigits: outbound.toDigits,
        kind: "image",
        mediaLink: signed.url,
        caption,
      });
    } else {
      sendResult = await sendWhatsAppImage({
        toDigits: outbound.toDigits,
        phoneNumberId: outbound.phoneNumberId,
        accessToken: outbound.accessToken,
        imageUrl: signed.url,
        caption,
      });
    }

    if (!sendResult.ok) {
      console.warn("[sorteo-ticket] whatsapp_send_error", {
        deliveryId: rowId,
        provider: outbound.provider,
        error: sendResult.error ?? "send_failed",
      });
      throw new Error(sendResult.error ?? "send_failed");
    }

    console.info("[sorteo-ticket] whatsapp_send_ok", {
      deliveryId: rowId,
      whatsapp_message_id: sendResult.waMessageId ?? null,
      provider: outbound.provider,
    });

    const waId =
      typeof sendResult.waMessageId === "string" && sendResult.waMessageId
        ? sendResult.waMessageId
        : null;

    await db
      .from("sorteo_ticket_deliveries")
      .update({
        status: "sent",
        whatsapp_message_id: waId,
        provider: outbound.provider,
        channel_id: input.channelId,
        sent_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", rowId);

    console.info("[sorteo-ticket] delivery_saved", {
      deliveryId: rowId,
      status: "sent",
      whatsapp_message_id: waId,
      provider: outbound.provider,
    });

    if (conversationId?.trim()) {
      await persistOutgoingChatMessage(supabase, {
        conversation: { id: conversationId.trim(), empresa_id: empresaId },
        content: caption ? `Ticket imagen\n${caption}` : "Ticket imagen enviado",
        messageType: "image",
        waMessageId: waId,
        raw: sendResult.raw ?? {},
        senderType: "system",
        automationSource: "sorteo_ticket",
      });
    }

    return {
      ok: true,
      deliveryId: rowId,
      lastStatus: "sent",
      storageBucket: "sorteo-tickets-generated",
      storagePath: genPath,
      whatsappMessageId: waId,
      provider: outbound.provider,
    };
  } catch (e) {
    const msg = safeErr(e);
    console.warn("[sorteo-ticket] delivery_failed", {
      entradaId,
      deliveryId: rowId || null,
      reason: msg.slice(0, 200),
    });
    if (rowId) {
      await db
        .from("sorteo_ticket_deliveries")
        .update({
          status: "error",
          error_message: msg,
          updated_at: new Date().toISOString(),
        })
        .eq("id", rowId);
      console.warn("[sorteo-ticket] delivery_saved", {
        deliveryId: rowId,
        status: "error",
        error_message: msg.slice(0, 120),
      });
    }
    return {
      ok: false,
      skipped: false,
      reason: msg,
      deliveryId: rowId || undefined,
      lastStatus: rowId ? "error" : undefined,
    };
  }
}

export type SorteoTicketPhaseResult = {
  suppressPlainTextBody: boolean;
  needsPostFlowImage: boolean;
};

/**
 * Antes del mensaje de cierre del flujo: image_only intenta ticket; text_and_image difiere imagen.
 */
export async function runSorteoTicketPreClose(params: {
  supabase: AppSupabaseClient;
  empresaId: string;
  conversationId: string;
  contactId: string;
  channelId: string;
  flowSessionId: string | null;
  orderResult: EnsureSorteoOrderCreatedData;
  flowData: Record<string, string>;
  trigger: SorteoTicketTrigger;
}): Promise<SorteoTicketPhaseResult> {
  console.info("[sorteo-ticket] pre_close_enter", {
    trigger: params.trigger,
    conversationId: params.conversationId,
    sorteoId: params.orderResult.sorteoId,
    entradaId: params.orderResult.entradaId,
  });

  const meta = await loadSorteoRowForTicket({
    supabase: params.supabase,
    empresaId: params.empresaId,
    sorteoId: params.orderResult.sorteoId,
  });
  if (!meta) {
    console.warn("[sorteo-ticket] pre_close_sorteo_meta_miss", {
      sorteoId: String(params.orderResult.sorteoId).slice(0, 8),
    });
    return { suppressPlainTextBody: false, needsPostFlowImage: false };
  }
  const effectiveMode: SorteoTicketDeliveryMode = meta.ticket_delivery_mode ?? "text_only";

  console.info("[sorteo-ticket] mode_resolved", {
    source: "pre_close",
    effectiveMode,
    raw_mode: meta.ticket_delivery_mode ?? null,
    sorteoId: params.orderResult.sorteoId,
  });

  if (effectiveMode === "text_only") {
    console.info("[sorteo-ticket] skipped_text_only", {
      phase: "pre_close",
      entradaId: params.orderResult.entradaId,
    });
    return { suppressPlainTextBody: false, needsPostFlowImage: false };
  }
  if (effectiveMode === "text_and_image") {
    console.info("[sorteo-ticket] pre_close_defer_image_to_after_text", {
      entradaId: params.orderResult.entradaId,
    });
    return { suppressPlainTextBody: false, needsPostFlowImage: true };
  }

  const r = await maybeGenerateAndSendSorteoTicketDelivery({
    supabase: params.supabase,
    empresaId: params.empresaId,
    sorteoId: params.orderResult.sorteoId,
    entradaId: params.orderResult.entradaId,
    conversationId: params.conversationId,
    flowSessionId: params.flowSessionId,
    contactId: params.contactId,
    channelId: params.channelId,
    orderResult: params.orderResult,
    flowData: params.flowData,
    trigger: params.trigger,
  });

  const suppress =
    effectiveMode === "image_only" &&
    (r.ok || (Boolean(r.skipped) && r.reason === "already_sent"));
  return {
    suppressPlainTextBody: suppress,
    needsPostFlowImage: false,
  };
}

export async function runSorteoTicketAfterBuyerText(params: {
  supabase: AppSupabaseClient;
  empresaId: string;
  conversationId: string;
  contactId: string;
  channelId: string;
  flowSessionId: string | null;
  orderResult: EnsureSorteoOrderCreatedData;
  flowData: Record<string, string>;
  trigger: SorteoTicketTrigger;
}): Promise<void> {
  console.info("[sorteo-ticket] after_buyer_text_enter", {
    trigger: params.trigger,
    conversationId: params.conversationId,
    entradaId: params.orderResult.entradaId,
    channelId: params.channelId,
    contactId: params.contactId,
  });

  const meta = await loadSorteoRowForTicket({
    supabase: params.supabase,
    empresaId: params.empresaId,
    sorteoId: params.orderResult.sorteoId,
  });
  const mode = meta?.ticket_delivery_mode ?? "text_only";
  console.info("[sorteo-ticket] mode_resolved", {
    source: "after_buyer_text",
    effectiveMode: mode,
    raw_mode: meta?.ticket_delivery_mode ?? null,
  });

  if (mode !== "text_and_image") {
    console.info("[sorteo-ticket] after_buyer_text_skip", { mode, entradaId: params.orderResult.entradaId });
    return;
  }

  await maybeGenerateAndSendSorteoTicketDelivery({
    supabase: params.supabase,
    empresaId: params.empresaId,
    sorteoId: params.orderResult.sorteoId,
    entradaId: params.orderResult.entradaId,
    conversationId: params.conversationId,
    flowSessionId: params.flowSessionId,
    contactId: params.contactId,
    channelId: params.channelId,
    orderResult: params.orderResult,
    flowData: params.flowData,
    trigger: params.trigger,
  });
}

export async function getSorteoTicketDeliveryModeForSorteo(input: {
  supabase: AppSupabaseClient;
  empresaId: string;
  sorteoId: string;
}): Promise<SorteoTicketDeliveryMode> {
  const meta = await loadSorteoRowForTicket(input);
  return meta?.ticket_delivery_mode ?? "text_only";
}

/** Tras enviar el PNG en image_only: si tuvo éxito o ya estaba sent, se puede omitir el texto largo del nodo. */
export function shouldSuppressSorteoFinalTextAfterImageOnlyTicket(
  delivery: MaybeGenerateAndSendSorteoTicketDeliveryResult | null | undefined
): boolean {
  if (!delivery || !delivery.ok) {
    return false;
  }
  if (delivery.skipped) {
    return delivery.reason === "already_sent";
  }
  return delivery.lastStatus === "sent";
}

/**
 * Tras el mensaje de cierre (ej. nodo compra_realizada o resumen sin siguiente nodo):
 * genera y envía el ticket (trigger confirmacion_final). `delivery` null si el modo es text_only.
 */
export async function runSorteoTicketAfterFinalNodeMessage(params: {
  supabase: AppSupabaseClient;
  empresaId: string;
  conversationId: string;
  contactId: string;
  channelId: string;
  flowSessionId: string | null;
  orderResult: EnsureSorteoOrderCreatedData;
  flowData: Record<string, string>;
}): Promise<{
  mode: SorteoTicketDeliveryMode;
  delivery: MaybeGenerateAndSendSorteoTicketDeliveryResult | null;
}> {
  const meta = await loadSorteoRowForTicket({
    supabase: params.supabase,
    empresaId: params.empresaId,
    sorteoId: params.orderResult.sorteoId,
  });
  const mode: SorteoTicketDeliveryMode = meta?.ticket_delivery_mode ?? "text_only";
  if (mode === "text_only") {
    return { mode, delivery: null };
  }
  const delivery = await maybeGenerateAndSendSorteoTicketDelivery({
    supabase: params.supabase,
    empresaId: params.empresaId,
    sorteoId: params.orderResult.sorteoId,
    entradaId: params.orderResult.entradaId,
    conversationId: params.conversationId,
    flowSessionId: params.flowSessionId,
    contactId: params.contactId,
    channelId: params.channelId,
    orderResult: params.orderResult,
    flowData: params.flowData,
    trigger: "confirmacion_final",
  });
  return { mode, delivery };
}

export function buildImageOnlyStubText(config: Record<string, unknown>): string {
  const c = normalizeTicketImageConfig(config);
  return (c.ticket_image_only_stub ?? "").trim() || SORTEO_TICKET_DEFAULT_STUB;
}

/**
 * Reenvía por WhatsApp un ticket ya generado (misma fila, nuevo envío; no duplica orden).
 */
export async function resendSorteoTicketByDeliveryId(input: {
  supabase: AppSupabaseClient;
  empresaId: string;
  deliveryId: string;
}): Promise<{ ok: boolean; error?: string }> {
  const schema = await fetchDataSchemaForEmpresaId(input.empresaId);
  const db = input.supabase;

  const { data: row, error: r0 } = await db
    .from("sorteo_ticket_deliveries")
    .select(
      "id, entrada_id, sorteo_id, conversation_id, channel_id, storage_path, empresa_id, numero_orden, payload_snapshot"
    )
    .eq("id", input.deliveryId)
    .eq("empresa_id", input.empresaId)
    .maybeSingle();
  if (r0 || !row) return { ok: false, error: "not_found" };

  const storagePath = (row as { storage_path?: string | null }).storage_path?.trim();
  if (!storagePath) return { ok: false, error: "no_file" };

  const convId = (row as { conversation_id?: string | null }).conversation_id;
  const channelId = (row as { channel_id?: string | null }).channel_id;
  if (!convId || !channelId) return { ok: false, error: "no_conversation" };

  const { data: conv } = await db
    .from("chat_conversations")
    .select("contact_id")
    .eq("id", convId)
    .maybeSingle();
  const contactId = (conv as { contact_id?: string } | null)?.contact_id;
  if (!contactId) return { ok: false, error: "no_contact" };

  const sorteoId = (row as { sorteo_id: string }).sorteo_id;
  const sr = await loadSorteoRowForTicket({
    supabase: input.supabase,
    empresaId: input.empresaId,
    sorteoId,
  });
  const cfg = normalizeTicketImageConfig(sr?.ticket_image_config);
  const sorteoNombre = String(sr?.nombre ?? "").trim();

  const signed = await createSignedUrlForTicket(input.supabase, storagePath, 600);
  if (!signed.url) return { ok: false, error: signed.error ?? "signed_url" };

  let outbound: Awaited<ReturnType<typeof resolveOutboundTextContextFromIds>>;
  try {
    outbound = await resolveOutboundTextContextFromIds(
      input.supabase,
      { contactId, channelId },
      { dataSchema: schema, empresaId: input.empresaId }
    );
  } catch {
    return { ok: false, error: "outbound" };
  }

  const numOrden = String((row as { numero_orden?: string | null }).numero_orden ?? "");
  const caption =
    (cfg.caption ?? "").trim() ||
    (cfg.title ?? "").trim() ||
    `Orden Nº ${numOrden} — ${sorteoNombre}`.slice(0, 1024);

  let sendResult: { ok: boolean; waMessageId?: string | null; raw?: unknown; error?: string };
  if (outbound.provider === "ycloud") {
    sendResult = await sendYCloudWhatsappMediaViaLink({
      apiKey: outbound.apiKey,
      fromE164: outbound.fromE164,
      toDigits: outbound.toDigits,
      kind: "image",
      mediaLink: signed.url,
      caption,
    });
  } else {
    sendResult = await sendWhatsAppImage({
      toDigits: outbound.toDigits,
      phoneNumberId: outbound.phoneNumberId,
      accessToken: outbound.accessToken,
      imageUrl: signed.url,
      caption,
    });
  }

  if (!sendResult.ok) return { ok: false, error: sendResult.error ?? "send_failed" };

  const waId =
    typeof sendResult.waMessageId === "string" && sendResult.waMessageId
      ? sendResult.waMessageId
      : null;

  await db
    .from("sorteo_ticket_deliveries")
    .update({
      whatsapp_message_id: waId,
      provider: outbound.provider,
      sent_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.deliveryId);

  await persistOutgoingChatMessage(input.supabase, {
    conversation: { id: convId, empresa_id: input.empresaId },
    content: caption ? `Ticket imagen (reenvío)\n${caption}` : "Ticket imagen reenviado",
    messageType: "image",
    waMessageId: waId,
    raw: sendResult.raw ?? {},
    senderType: "system",
    automationSource: "sorteo_ticket_resend",
  });

  return { ok: true };
}
