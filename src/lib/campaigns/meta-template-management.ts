import "server-only";
import type { SupabaseAdmin } from "@/lib/chat/types";
import { effectiveOutboundProvider } from "@/lib/chat/outbound-send-dispatch";

function graphVersion(): string {
  return process.env.WHATSAPP_GRAPH_VERSION ?? "v19.0";
}

export type MetaChannelCreds = { wabaId: string; accessToken: string; appId: string | null };

export async function getMetaChannelCreds(params: {
  supabase: SupabaseAdmin;
  empresaId: string;
  channelId: string;
}): Promise<{ ok: true; creds: MetaChannelCreds } | { ok: false; error: string }> {
  const { data: ch, error } = await params.supabase
    .from("chat_channels")
    .select("id, provider, type, config, meta_phone_number_id, whatsapp_access_token, activo, provider_channel_id")
    .eq("id", params.channelId)
    .eq("empresa_id", params.empresaId)
    .maybeSingle();
  if (error || !ch) return { ok: false, error: error?.message ?? "Canal no encontrado" };

  const channel = ch as {
    config?: unknown;
    activo?: boolean;
    provider?: string | null;
    type?: string | null;
    whatsapp_access_token?: string | null;
    meta_phone_number_id?: string | null;
    provider_channel_id?: string | null;
  };
  if (channel.activo === false) return { ok: false, error: "Canal desactivado" };
  if (effectiveOutboundProvider(channel) !== "meta") {
    return { ok: false, error: "La gestión de plantillas desde el ERP solo está disponible para canales Meta." };
  }

  const cfg =
    channel.config && typeof channel.config === "object" && !Array.isArray(channel.config)
      ? (channel.config as Record<string, unknown>)
      : {};
  const wabaId =
    typeof cfg.meta_waba_id === "string"
      ? cfg.meta_waba_id.trim()
      : typeof cfg.waba_id === "string"
        ? String(cfg.waba_id).trim()
        : "";
  const accessToken = typeof channel.whatsapp_access_token === "string" ? channel.whatsapp_access_token.trim() : "";
  const appId = typeof cfg.meta_app_id === "string" && cfg.meta_app_id.trim() ? cfg.meta_app_id.trim() : null;

  if (!wabaId || !accessToken) {
    return { ok: false, error: "El canal no tiene WABA ID o token de Meta configurados (Configuración → Canales)." };
  }
  return { ok: true, creds: { wabaId, accessToken, appId } };
}

function metaErrorMessage(raw: Record<string, unknown>, fallback: string): string {
  const err = raw.error as { message?: string; error_user_title?: string; error_user_msg?: string } | undefined;
  if (!err) return fallback;
  const user = [err.error_user_title, err.error_user_msg].filter(Boolean).join(": ");
  return user || err.message || fallback;
}

export type MetaTemplateListItem = {
  id: string | null;
  name: string;
  language: string;
  status: string;
  category: string | null;
  rejected_reason: string | null;
  quality: string | null;
  components: unknown[];
};

/** Lista todas las plantillas de la WABA (aprobadas, pendientes, rechazadas, pausadas). Solo lectura. */
export async function listMetaTemplatesAllStatuses(creds: MetaChannelCreds): Promise<MetaTemplateListItem[]> {
  const base = `https://graph.facebook.com/${graphVersion()}/${encodeURIComponent(creds.wabaId)}/message_templates`;
  const fields = "name,language,status,category,components,id,rejected_reason,quality_score";
  let url: string | null =
    `${base}?fields=${fields}&limit=100&access_token=${encodeURIComponent(creds.accessToken)}`;
  const out: MetaTemplateListItem[] = [];

  for (let guard = 0; guard < 20 && url; guard++) {
    const res: Response = await fetch(url, { method: "GET", cache: "no-store" });
    const raw = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new Error(metaErrorMessage(raw, `Meta HTTP ${res.status}`));
    for (const t of (raw.data as Record<string, unknown>[] | undefined) ?? []) {
      const name = typeof t.name === "string" ? t.name : "";
      if (!name) continue;
      const rejected = typeof t.rejected_reason === "string" && t.rejected_reason !== "NONE" ? t.rejected_reason : null;
      const q = t.quality_score as { score?: string } | undefined;
      out.push({
        id: typeof t.id === "string" ? t.id : null,
        name,
        language: typeof t.language === "string" ? t.language : "",
        status: typeof t.status === "string" ? t.status.toUpperCase() : "UNKNOWN",
        category: typeof t.category === "string" ? t.category : null,
        rejected_reason: rejected,
        quality: typeof q?.score === "string" ? q.score : null,
        components: Array.isArray(t.components) ? (t.components as unknown[]) : [],
      });
    }
    const next = (raw.paging as { next?: string } | undefined)?.next;
    url = typeof next === "string" && next.trim() ? next.trim() : null;
  }
  return out;
}

/** Sube el archivo de muestra del encabezado (Resumable Upload API) y devuelve el handle que pide Meta. */
export async function uploadMetaHeaderSample(
  creds: MetaChannelCreds,
  bytes: Uint8Array,
  mime: string
): Promise<string> {
  if (!creds.appId) {
    throw new Error(
      "Para encabezados con imagen o video, el canal necesita el App ID de Meta (Configuración → Canales → App ID)."
    );
  }
  const v = graphVersion();
  const startUrl =
    `https://graph.facebook.com/${v}/${encodeURIComponent(creds.appId)}/uploads` +
    `?file_length=${bytes.byteLength}&file_type=${encodeURIComponent(mime)}&access_token=${encodeURIComponent(creds.accessToken)}`;
  const startRes = await fetch(startUrl, { method: "POST" });
  const startRaw = (await startRes.json().catch(() => ({}))) as Record<string, unknown>;
  const sessionId = typeof startRaw.id === "string" ? startRaw.id : "";
  if (!startRes.ok || !sessionId) throw new Error(metaErrorMessage(startRaw, "No se pudo iniciar la subida a Meta"));

  const upRes = await fetch(`https://graph.facebook.com/${v}/${sessionId}`, {
    method: "POST",
    headers: { Authorization: `OAuth ${creds.accessToken}`, file_offset: "0" },
    body: Buffer.from(bytes),
  });
  const upRaw = (await upRes.json().catch(() => ({}))) as Record<string, unknown>;
  const handle = typeof upRaw.h === "string" ? upRaw.h : "";
  if (!upRes.ok || !handle) throw new Error(metaErrorMessage(upRaw, "Meta no devolvió el handle del archivo"));
  return handle;
}

export type TemplateButtonInput =
  | { type: "QUICK_REPLY"; text: string }
  | { type: "URL"; text: string; url: string; example?: string }
  | { type: "PHONE_NUMBER"; text: string; phone_number: string };

export type CreateTemplateInput = {
  name: string;
  language: string;
  category: "UTILITY" | "MARKETING";
  header:
    | { kind: "none" }
    | { kind: "text"; text: string; example?: string }
    | { kind: "image" | "video" | "document"; handle: string };
  body: { text: string; examples: string[] };
  footer?: string;
  buttons: TemplateButtonInput[];
};

const VAR_RE = /\{\{(\d+)\}\}/g;

function varNumbers(text: string): number[] {
  return [...text.matchAll(VAR_RE)].map((m) => Number(m[1]));
}

/** Valida contra las reglas de Meta para fallar antes de mandar y dar un mensaje claro en español. */
export function validateCreateTemplateInput(input: CreateTemplateInput): string | null {
  if (!/^[a-z0-9_]{1,512}$/.test(input.name)) {
    return "El nombre solo puede tener minúsculas, números y guion bajo (ej: promo_sorteo_s10).";
  }
  if (!input.language.trim()) return "Falta el idioma.";
  if (input.category !== "UTILITY" && input.category !== "MARKETING") return "Categoría inválida.";

  const body = input.body.text;
  if (!body.trim()) return "El cuerpo del mensaje es obligatorio.";
  if (body.length > 1024) return "El cuerpo no puede superar 1024 caracteres.";
  const nums = varNumbers(body);
  const uniq = [...new Set(nums)].sort((a, b) => a - b);
  if (uniq.some((n, i) => n !== i + 1)) {
    return "Las variables del cuerpo tienen que ser consecutivas: {{1}}, {{2}}, {{3}}…";
  }
  if (uniq.length > 0) {
    if (input.body.examples.length < uniq.length || input.body.examples.slice(0, uniq.length).some((e) => !e.trim())) {
      return "Cada variable del cuerpo necesita un ejemplo (Meta lo pide para revisarla).";
    }
    const trimmed = body.trim();
    if (/^\{\{\d+\}\}/.test(trimmed) || /\{\{\d+\}\}$/.test(trimmed)) {
      return "El cuerpo no puede empezar ni terminar con una variable (regla de Meta).";
    }
  }

  if (input.header.kind === "text") {
    const h = input.header.text;
    if (!h.trim()) return "El encabezado de texto está vacío.";
    if (h.length > 60) return "El encabezado de texto no puede superar 60 caracteres.";
    const hv = varNumbers(h);
    if (hv.length > 1 || (hv.length === 1 && hv[0] !== 1)) return "El encabezado admite como máximo una variable: {{1}}.";
    if (hv.length === 1 && !input.header.example?.trim()) return "La variable del encabezado necesita un ejemplo.";
  }
  if (
    (input.header.kind === "image" || input.header.kind === "video" || input.header.kind === "document") &&
    !input.header.handle
  ) {
    return "Subí el archivo del encabezado (foto, video o PDF).";
  }

  if (input.footer && input.footer.length > 60) return "El pie no puede superar 60 caracteres.";

  const qr = input.buttons.filter((b) => b.type === "QUICK_REPLY");
  const url = input.buttons.filter((b) => b.type === "URL");
  const phone = input.buttons.filter((b) => b.type === "PHONE_NUMBER");
  if (input.buttons.length > 10) return "Máximo 10 botones.";
  if (url.length > 2) return "Máximo 2 botones de enlace.";
  if (phone.length > 1) return "Máximo 1 botón de llamada.";
  for (const b of input.buttons) {
    if (!b.text.trim()) return "Todos los botones necesitan un texto.";
    if (b.text.length > 25) return `El botón "${b.text}" supera 25 caracteres.`;
    if (b.type === "URL" && !/^https:\/\/\S+$/.test(b.url)) return `El enlace del botón "${b.text}" tiene que empezar con https://`;
    if (b.type === "PHONE_NUMBER" && !/^\+?\d{8,15}$/.test(b.phone_number.replace(/\s/g, ""))) {
      return `El teléfono del botón "${b.text}" no es válido (ej: +595981123456).`;
    }
  }
  const groups = input.buttons
    .map((b) => (b.type === "QUICK_REPLY" ? "qr" : "cta"))
    .filter((g, i, arr) => i === 0 || g !== arr[i - 1]);
  if (qr.length > 0 && groups.length > 2) {
    return "Agrupá los botones: primero las respuestas rápidas y después enlaces/llamada (o al revés), sin mezclarlos.";
  }
  return null;
}

export const HEADER_FILE_RULES: Record<"image" | "video" | "document", { mimes: RegExp; maxBytes: number; label: string }> = {
  image: { mimes: /^image\/(jpeg|png)$/, maxBytes: 5 * 1024 * 1024, label: "JPG o PNG de hasta 5 MB" },
  video: { mimes: /^video\/mp4$/, maxBytes: 16 * 1024 * 1024, label: "MP4 de hasta 16 MB" },
  document: { mimes: /^application\/pdf$/, maxBytes: 16 * 1024 * 1024, label: "PDF de hasta 16 MB" },
};

export function buildMetaComponents(input: CreateTemplateInput): unknown[] {
  const components: unknown[] = [];

  if (input.header.kind === "text") {
    const h: Record<string, unknown> = { type: "HEADER", format: "TEXT", text: input.header.text };
    if (varNumbers(input.header.text).length === 1) h.example = { header_text: [input.header.example ?? ""] };
    components.push(h);
  } else if (input.header.kind === "image" || input.header.kind === "video" || input.header.kind === "document") {
    components.push({
      type: "HEADER",
      format: input.header.kind.toUpperCase(),
      example: { header_handle: [input.header.handle] },
    });
  }

  const bodyVars = [...new Set(varNumbers(input.body.text))].length;
  const body: Record<string, unknown> = { type: "BODY", text: input.body.text };
  if (bodyVars > 0) body.example = { body_text: [input.body.examples.slice(0, bodyVars)] };
  components.push(body);

  if (input.footer?.trim()) components.push({ type: "FOOTER", text: input.footer.trim() });

  if (input.buttons.length > 0) {
    components.push({
      type: "BUTTONS",
      buttons: input.buttons.map((b) => {
        if (b.type === "QUICK_REPLY") return { type: "QUICK_REPLY", text: b.text.trim() };
        if (b.type === "PHONE_NUMBER") {
          return { type: "PHONE_NUMBER", text: b.text.trim(), phone_number: b.phone_number.replace(/\s/g, "") };
        }
        const btn: Record<string, unknown> = { type: "URL", text: b.text.trim(), url: b.url.trim() };
        if (/\{\{1\}\}/.test(b.url) && b.example?.trim()) btn.example = [b.example.trim()];
        return btn;
      }),
    });
  }
  return components;
}

export async function createMetaTemplate(
  creds: MetaChannelCreds,
  input: CreateTemplateInput,
  components: unknown[]
): Promise<{ id: string | null; status: string; category: string | null }> {
  const res = await fetch(
    `https://graph.facebook.com/${graphVersion()}/${encodeURIComponent(creds.wabaId)}/message_templates`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${creds.accessToken}` },
      body: JSON.stringify({
        name: input.name,
        language: input.language,
        category: input.category,
        components,
      }),
    }
  );
  const raw = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(metaErrorMessage(raw, `Meta HTTP ${res.status}`));
  return {
    id: typeof raw.id === "string" ? raw.id : null,
    status: typeof raw.status === "string" ? raw.status : "PENDING",
    category: typeof raw.category === "string" ? raw.category : null,
  };
}
