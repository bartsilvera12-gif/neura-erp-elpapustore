"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch } from "@/lib/api/fetch-with-supabase-session";

type Channel = { id: string; nombre: string; provider: string };
type TemplateItem = {
  id: string | null;
  name: string;
  language: string;
  status: string;
  category: string | null;
  rejected_reason: string | null;
  quality: string | null;
  components: Array<{ type?: string; format?: string; text?: string; buttons?: Array<{ type?: string; text?: string }> }>;
  default_header_url: string | null;
};

function templateMediaKind(t: TemplateItem): MediaKind | null {
  const h = t.components.find((c) => String(c.type).toUpperCase() === "HEADER");
  const f = String(h?.format ?? "").toUpperCase();
  return f === "IMAGE" ? "image" : f === "VIDEO" ? "video" : f === "DOCUMENT" ? "document" : null;
}
type ButtonRow = { type: "QUICK_REPLY" | "URL" | "PHONE_NUMBER"; text: string; url: string; phone_number: string };
type HeaderKind = "none" | "text" | "image" | "video" | "document";
type MediaKind = "image" | "video" | "document";

const MEDIA_RULES: Record<MediaKind, { accept: string; hint: string; label: string }> = {
  image: { accept: "image/jpeg,image/png", hint: "JPG o PNG, hasta 5 MB", label: "la foto" },
  video: { accept: "video/mp4", hint: "MP4 (H.264 + AAC), hasta 16 MB", label: "el video" },
  document: { accept: "application/pdf", hint: "PDF, hasta 16 MB", label: "el PDF" },
};

const HEADER_OPTIONS: Array<{ kind: HeaderKind; label: string; icon: string }> = [
  { kind: "none", label: "Sin encabezado", icon: "—" },
  { kind: "text", label: "Texto", icon: "T" },
  { kind: "image", label: "Foto", icon: "🖼️" },
  { kind: "video", label: "Video", icon: "🎬" },
  { kind: "document", label: "PDF", icon: "📄" },
];

const STATUS_LABEL: Record<string, { label: string; cls: string }> = {
  APPROVED: { label: "Aprobada", cls: "border-emerald-200 bg-emerald-50 text-emerald-700" },
  PENDING: { label: "En revisión", cls: "border-amber-200 bg-amber-50 text-amber-800" },
  IN_APPEAL: { label: "En apelación", cls: "border-amber-200 bg-amber-50 text-amber-800" },
  REJECTED: { label: "Rechazada", cls: "border-red-200 bg-red-50 text-red-700" },
  PAUSED: { label: "Pausada", cls: "border-orange-200 bg-orange-50 text-orange-700" },
  DISABLED: { label: "Desactivada", cls: "border-slate-300 bg-slate-100 text-slate-600" },
};

const REJECT_LABEL: Record<string, string> = {
  INVALID_FORMAT: "Formato inválido",
  ABUSIVE_CONTENT: "Contenido no permitido",
  INCORRECT_CATEGORY: "Categoría incorrecta",
  PROMOTIONAL: "Contenido promocional en categoría Utilidad",
  TAG_CONTENT_MISMATCH: "El contenido no coincide con la categoría",
  SCAM: "Marcada como posible estafa",
};

const CATEGORY_LABEL: Record<string, string> = { UTILITY: "Utilidad", MARKETING: "Marketing", AUTHENTICATION: "Autenticación" };

const inputCls =
  "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 focus:border-[#4FAEB2] focus:outline-none focus:ring-2 focus:ring-[#4FAEB2]/20";

function varCount(text: string): number {
  return new Set([...text.matchAll(/\{\{(\d+)\}\}/g)].map((m) => m[1])).size;
}

function fillVars(text: string, examples: string[]): string {
  return text.replace(/\{\{(\d+)\}\}/g, (m, n) => examples[Number(n) - 1]?.trim() || m);
}

/** Convierte el formato de WhatsApp (*negrita*, _cursiva_, ~tachado~, ```mono```) a HTML. Escapa todo antes, así que solo quedan nuestras etiquetas. */
function whatsappToHtml(text: string): string {
  const esc = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return esc
    .replace(/```([\s\S]+?)```/g, '<code class="rounded bg-slate-100 px-1 font-mono text-[12px]">$1</code>')
    .replace(/\*([^*\n]+)\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,!?])/gm, "$1<em>$2</em>")
    .replace(/~([^~\n]+)~/g, "<s>$1</s>");
}

function fmtSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export default function PlantillasMetaClient() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [channelId, setChannelId] = useState("");
  const [items, setItems] = useState<TemplateItem[]>([]);
  const [mediaEnabled, setMediaEnabled] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const [name, setName] = useState("");
  const [category, setCategory] = useState<"UTILITY" | "MARKETING">("UTILITY");
  const [language, setLanguage] = useState("es");
  const [headerKind, setHeaderKind] = useState<HeaderKind>("none");
  const [headerText, setHeaderText] = useState("");
  const [headerExample, setHeaderExample] = useState("");
  const [headerHandle, setHeaderHandle] = useState("");
  const [headerStoragePath, setHeaderStoragePath] = useState("");
  const [headerFile, setHeaderFile] = useState<{ name: string; size: number; previewUrl: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const defaultInputRef = useRef<HTMLInputElement>(null);
  const [defaultTarget, setDefaultTarget] = useState<{ name: string; language: string; kind: MediaKind } | null>(null);
  const [defaultUploadingKey, setDefaultUploadingKey] = useState<string | null>(null);
  const [bodyText, setBodyText] = useState("");
  const [examples, setExamples] = useState<string[]>([]);
  const [footer, setFooter] = useState("");
  const [buttons, setButtons] = useState<ButtonRow[]>([]);
  const [saving, setSaving] = useState(false);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  const bodyVars = useMemo(() => varCount(bodyText), [bodyText]);
  const headerHasVar = /\{\{1\}\}/.test(headerText);

  useEffect(() => {
    void (async () => {
      const r = await apiFetch("/api/campanas/options");
      const j = await r.json().catch(() => ({}));
      const list: Channel[] = (j?.data?.channels ?? []).filter((c: Channel) => c.provider === "meta");
      setChannels(list);
      if (list[0]) setChannelId(list[0].id);
      else setErr("No hay canales de WhatsApp de Meta activos.");
    })();
  }, []);

  const load = useCallback(async () => {
    if (!channelId) return;
    setLoading(true);
    setErr(null);
    try {
      const r = await apiFetch(`/api/campanas/templates/meta?channel_id=${encodeURIComponent(channelId)}`);
      const j = await r.json();
      if (!j.success) throw new Error(j.error ?? "No se pudieron cargar las plantillas");
      setItems(j.data.items ?? []);
      setMediaEnabled(Boolean(j.data.media_header_enabled));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Error");
    } finally {
      setLoading(false);
    }
  }, [channelId]);

  useEffect(() => {
    void load();
  }, [load]);

  function clearHeaderFile() {
    if (headerFile?.previewUrl) URL.revokeObjectURL(headerFile.previewUrl);
    setHeaderFile(null);
    setHeaderHandle("");
    setHeaderStoragePath("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function uploadHeader(file: File) {
    if (headerKind !== "image" && headerKind !== "video" && headerKind !== "document") return;
    clearHeaderFile();
    setUploading(true);
    setErr(null);
    try {
      const fd = new FormData();
      fd.append("channel_id", channelId);
      fd.append("kind", headerKind);
      fd.append("file", file);
      const r = await apiFetch("/api/campanas/templates/meta/upload", { method: "POST", body: fd });
      const j = await r.json();
      if (!j.success) throw new Error(j.error ?? "No se pudo subir el archivo");
      setHeaderHandle(j.data.handle);
      setHeaderStoragePath(j.data.storage_path ?? "");
      setHeaderFile({ name: file.name, size: file.size, previewUrl: URL.createObjectURL(file) });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Error al subir");
    } finally {
      setUploading(false);
    }
  }

  function pickDefaultFile(t: TemplateItem, kind: MediaKind) {
    setDefaultTarget({ name: t.name, language: t.language, kind });
    if (defaultInputRef.current) {
      defaultInputRef.current.accept = MEDIA_RULES[kind].accept;
      defaultInputRef.current.value = "";
      defaultInputRef.current.click();
    }
  }

  async function uploadDefaultFile(file: File) {
    if (!defaultTarget) return;
    const key = `${defaultTarget.name}-${defaultTarget.language}`;
    setDefaultUploadingKey(key);
    setErr(null);
    try {
      const fd = new FormData();
      fd.append("channel_id", channelId);
      fd.append("name", defaultTarget.name);
      fd.append("language", defaultTarget.language);
      fd.append("kind", defaultTarget.kind);
      fd.append("file", file);
      const r = await apiFetch("/api/campanas/templates/meta/default-header", { method: "POST", body: fd });
      const j = await r.json();
      if (!j.success) throw new Error(j.error ?? "No se pudo guardar el archivo");
      setItems((prev) =>
        prev.map((x) =>
          x.name === defaultTarget.name && x.language === defaultTarget.language ? { ...x, default_header_url: j.data.url } : x
        )
      );
      setOkMsg(`Listo: las campañas nuevas con "${defaultTarget.name}" usan este archivo sin cargarlo en el Excel.`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Error");
    } finally {
      setDefaultUploadingKey(null);
    }
  }

  /** Envuelve el texto seleccionado del mensaje con el marcador de WhatsApp (*, _, ~, ```). */
  function wrapSelection(marker: string) {
    const ta = bodyRef.current;
    if (!ta) return;
    const { selectionStart: s, selectionEnd: e } = ta;
    const selected = bodyText.slice(s, e) || "texto";
    const next = bodyText.slice(0, s) + marker + selected + marker + bodyText.slice(e);
    setBodyText(next);
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(s + marker.length, s + marker.length + selected.length);
    });
  }

  function insertVariable() {
    const ta = bodyRef.current;
    if (!ta) return;
    const token = `{{${bodyVars + 1}}}`;
    const pos = ta.selectionStart;
    setBodyText(bodyText.slice(0, pos) + token + bodyText.slice(ta.selectionEnd));
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(pos + token.length, pos + token.length);
    });
  }

  function resetForm() {
    setName("");
    setCategory("UTILITY");
    setLanguage("es");
    setHeaderKind("none");
    setHeaderText("");
    setHeaderExample("");
    clearHeaderFile();
    setBodyText("");
    setExamples([]);
    setFooter("");
    setButtons([]);
  }

  async function submit() {
    setSaving(true);
    setErr(null);
    setOkMsg(null);
    try {
      const r = await apiFetch("/api/campanas/templates/meta", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel_id: channelId,
          name,
          language,
          category,
          header:
            headerKind === "text"
              ? { kind: "text", text: headerText, example: headerExample }
              : headerKind === "none"
                ? { kind: "none" }
                : { kind: headerKind, handle: headerHandle, storage_path: headerStoragePath },
          body: { text: bodyText, examples: examples.slice(0, bodyVars) },
          footer,
          buttons,
        }),
      });
      const j = await r.json();
      if (!j.success) throw new Error(j.error ?? "Meta rechazó la plantilla");
      setOkMsg(
        `Plantilla "${name}" enviada a Meta. Estado: ${STATUS_LABEL[j.data.status]?.label ?? j.data.status}. ` +
          "Cuando esté aprobada, sincronizá las plantillas al crear la campaña para poder usarla." +
          (j.data.default_header_url ? " El archivo del encabezado quedó guardado: las campañas lo usan solas, sin ponerlo en el Excel." : "")
      );
      resetForm();
      setShowForm(false);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Error");
    } finally {
      setSaving(false);
    }
  }

  const sorted = useMemo(
    () => [...items].sort((a, b) => a.name.localeCompare(b.name) || a.language.localeCompare(b.language)),
    [items]
  );

  return (
    <div className="mx-auto max-w-6xl space-y-5 p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href="/dashboard/campanas" className="text-xs font-medium text-[#3F8E91] hover:underline">
            ← Campañas
          </Link>
          <h1 className="mt-1 text-lg font-bold text-slate-900">Plantillas de WhatsApp (Meta)</h1>
          <p className="text-xs text-slate-500">
            Creá plantillas y seguí su revisión sin entrar a Meta. Meta las revisa antes de poder usarlas en campañas.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {channels.length > 1 && (
            <select className={inputCls} value={channelId} onChange={(e) => setChannelId(e.target.value)}>
              {channels.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.nombre}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading || !channelId}
            className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            {loading ? "Cargando…" : "Actualizar"}
          </button>
          <button
            type="button"
            onClick={() => setShowForm((v) => !v)}
            disabled={!channelId}
            className="rounded-lg bg-[#4FAEB2] px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-[#3F8E91] disabled:opacity-50"
          >
            {showForm ? "Cerrar" : "Nueva plantilla"}
          </button>
        </div>
      </div>

      {err && <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{err}</p>}
      {okMsg && <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{okMsg}</p>}

      {showForm && (
        <section className="grid gap-5 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm lg:grid-cols-[1fr_320px]">
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="space-y-1 sm:col-span-1">
                <span className="text-xs font-semibold text-slate-600">Nombre</span>
                <input
                  className={inputCls}
                  value={name}
                  placeholder="promo_sorteo_s10"
                  onChange={(e) => setName(e.target.value.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, ""))}
                />
              </label>
              <label className="space-y-1">
                <span className="text-xs font-semibold text-slate-600">Categoría</span>
                <select className={inputCls} value={category} onChange={(e) => setCategory(e.target.value as "UTILITY" | "MARKETING")}>
                  <option value="UTILITY">Utilidad (avisos)</option>
                  <option value="MARKETING">Marketing (promociones)</option>
                </select>
              </label>
              <label className="space-y-1">
                <span className="text-xs font-semibold text-slate-600">Idioma</span>
                <select className={inputCls} value={language} onChange={(e) => setLanguage(e.target.value)}>
                  <option value="es">Español (es)</option>
                  <option value="es_AR">Español Argentina (es_AR)</option>
                  <option value="pt_BR">Portugués Brasil (pt_BR)</option>
                  <option value="en_US">Inglés (en_US)</option>
                </select>
              </label>
            </div>
            <p className="text-[11px] text-slate-500">
              Si el texto promociona algo (sorteos, ofertas), elegí Marketing: Meta reclasifica o rechaza las de Utilidad con contenido promocional.
            </p>

            <div className="space-y-2">
              <span className="text-xs font-semibold text-slate-600">Encabezado (opcional): texto, foto, video o PDF arriba del mensaje</span>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                {HEADER_OPTIONS.map((o) => {
                  const isMedia = o.kind === "image" || o.kind === "video" || o.kind === "document";
                  const active = headerKind === o.kind;
                  return (
                    <button
                      key={o.kind}
                      type="button"
                      disabled={isMedia && !mediaEnabled}
                      onClick={() => {
                        if (o.kind !== headerKind) clearHeaderFile();
                        setHeaderKind(o.kind);
                      }}
                      className={`flex flex-col items-center gap-1 rounded-xl border-2 px-2 py-3 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                        active
                          ? "border-[#4FAEB2] bg-[#4FAEB2]/10 text-[#2f7376]"
                          : "border-slate-200 bg-white text-slate-600 hover:border-[#4FAEB2]/60"
                      }`}
                    >
                      <span className="text-xl leading-none">{o.icon}</span>
                      {o.label}
                    </button>
                  );
                })}
              </div>
              {!mediaEnabled && (
                <p className="text-[11px] text-slate-500">
                  Foto, video y PDF requieren el App ID de Meta en el canal (Configuración → Canales).
                </p>
              )}
              {headerKind === "text" && (
                <div className="grid gap-2 sm:grid-cols-2">
                  <input className={inputCls} maxLength={60} value={headerText} placeholder="Ej: ¡Hola {{1}}!" onChange={(e) => setHeaderText(e.target.value)} />
                  {headerHasVar && (
                    <input className={inputCls} value={headerExample} placeholder="Ejemplo para {{1}}" onChange={(e) => setHeaderExample(e.target.value)} />
                  )}
                </div>
              )}
              {(headerKind === "image" || headerKind === "video" || headerKind === "document") && (
                <div className="space-y-1">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept={MEDIA_RULES[headerKind].accept}
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void uploadHeader(f);
                    }}
                  />
                  {headerFile ? (
                    <div className="flex items-center gap-3 rounded-xl border-2 border-emerald-300 bg-emerald-50/60 p-3">
                      <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-white text-2xl shadow-sm">
                        {headerKind === "image" ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={headerFile.previewUrl} alt="" className="h-full w-full object-cover" />
                        ) : headerKind === "video" ? (
                          <video src={headerFile.previewUrl} className="h-full w-full object-cover" muted />
                        ) : (
                          "📄"
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold text-slate-800">{headerFile.name}</p>
                        <p className="text-[11px] text-emerald-700">
                          ✓ Subido a Meta · {fmtSize(headerFile.size)}. Es la muestra que revisa Meta; en cada campaña podés mandar otro archivo.
                        </p>
                      </div>
                      <div className="flex shrink-0 flex-col gap-1">
                        <button
                          type="button"
                          onClick={() => fileInputRef.current?.click()}
                          className="rounded-lg border border-slate-300 bg-white px-3 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                        >
                          Cambiar
                        </button>
                        <button
                          type="button"
                          onClick={clearHeaderFile}
                          className="rounded-lg px-3 py-1 text-xs font-semibold text-red-600 hover:bg-red-50"
                        >
                          Quitar
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={() => !uploading && fileInputRef.current?.click()}
                      onKeyDown={(e) => {
                        if ((e.key === "Enter" || e.key === " ") && !uploading) {
                          e.preventDefault();
                          fileInputRef.current?.click();
                        }
                      }}
                      onDragOver={(e) => {
                        e.preventDefault();
                        setDragOver(true);
                      }}
                      onDragLeave={() => setDragOver(false)}
                      onDrop={(e) => {
                        e.preventDefault();
                        setDragOver(false);
                        const f = e.dataTransfer.files?.[0];
                        if (f && !uploading) void uploadHeader(f);
                      }}
                      className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-8 text-center transition-colors ${
                        dragOver ? "border-[#4FAEB2] bg-[#4FAEB2]/10" : "border-slate-300 bg-slate-50 hover:border-[#4FAEB2] hover:bg-[#4FAEB2]/5"
                      }`}
                    >
                      {uploading ? (
                        <p className="text-sm font-semibold text-[#3F8E91]">Subiendo a Meta…</p>
                      ) : (
                        <>
                          <span className="text-3xl leading-none">{HEADER_OPTIONS.find((o) => o.kind === headerKind)?.icon}</span>
                          <p className="text-sm font-semibold text-slate-800">Subí {MEDIA_RULES[headerKind].label}</p>
                          <p className="text-xs text-slate-500">Arrastralo acá o hacé clic para elegirlo · {MEDIA_RULES[headerKind].hint}</p>
                          <span className="mt-1 rounded-lg bg-[#4FAEB2] px-4 py-1.5 text-xs font-semibold text-white shadow-sm">Elegir archivo</span>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="space-y-1">
              <span className="text-xs font-semibold text-slate-600">Mensaje</span>
              <div className="overflow-hidden rounded-lg border border-slate-300 focus-within:border-[#4FAEB2] focus-within:ring-2 focus-within:ring-[#4FAEB2]/20">
                <div className="flex flex-wrap items-center gap-1 border-b border-slate-200 bg-slate-50 px-2 py-1">
                  {[
                    { m: "*", title: "Negrita", node: <strong>N</strong> },
                    { m: "_", title: "Cursiva", node: <em className="font-serif">K</em> },
                    { m: "~", title: "Tachado", node: <s>S</s> },
                    { m: "```", title: "Monoespaciado", node: <span className="font-mono text-[11px]">{"</>"}</span> },
                  ].map((b) => (
                    <button
                      key={b.title}
                      type="button"
                      title={`${b.title} (seleccioná el texto y tocá)`}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => wrapSelection(b.m)}
                      className="flex h-7 min-w-7 items-center justify-center rounded px-1.5 text-sm text-slate-700 hover:bg-white hover:shadow-sm"
                    >
                      {b.node}
                    </button>
                  ))}
                  <span className="mx-1 h-4 w-px bg-slate-300" />
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={insertVariable}
                    title="Insertar una parte que cambia por persona (nombre, monto…)"
                    className="rounded px-2 py-1 text-xs font-semibold text-[#3F8E91] hover:bg-white hover:shadow-sm"
                  >
                    + Variable {`{{${bodyVars + 1}}}`}
                  </button>
                </div>
                <textarea
                  ref={bodyRef}
                  className="block min-h-[140px] w-full resize-y border-0 px-3 py-2 text-sm text-slate-800 focus:outline-none"
                  maxLength={1024}
                  value={bodyText}
                  placeholder="Hola {{1}}, tu boleta para el sorteo del {{2}} ya está lista."
                  onChange={(e) => setBodyText(e.target.value)}
                />
              </div>
              <span className="text-[11px] text-slate-500">
                {bodyText.length}/1024 · Seleccioná texto y tocá N, K o S para darle formato. Las variables van en orden y no pueden ir al principio ni al final.
              </span>
            </div>
            {bodyVars > 0 && (
              <div className="grid gap-2 sm:grid-cols-2">
                {Array.from({ length: bodyVars }, (_, i) => (
                  <input
                    key={i}
                    className={inputCls}
                    value={examples[i] ?? ""}
                    placeholder={`Ejemplo para {{${i + 1}}} (lo ve Meta al revisar)`}
                    onChange={(e) =>
                      setExamples((prev) => {
                        const next = [...prev];
                        next[i] = e.target.value;
                        return next;
                      })
                    }
                  />
                ))}
              </div>
            )}

            <label className="block space-y-1">
              <span className="text-xs font-semibold text-slate-600">Pie (opcional)</span>
              <input className={inputCls} maxLength={60} value={footer} placeholder="Ej: Sorteo autorizado por CONAJZAR" onChange={(e) => setFooter(e.target.value)} />
            </label>

            <div className="space-y-2">
              <span className="text-xs font-semibold text-slate-600">Botones (opcional)</span>
              {buttons.map((b, i) => (
                <div key={i} className="grid gap-2 rounded-lg border border-slate-200 p-2 sm:grid-cols-[150px_1fr_1fr_auto]">
                  <select
                    className={inputCls}
                    value={b.type}
                    onChange={(e) =>
                      setButtons((prev) => prev.map((x, j) => (j === i ? { ...x, type: e.target.value as ButtonRow["type"] } : x)))
                    }
                  >
                    <option value="QUICK_REPLY">Respuesta rápida</option>
                    <option value="URL">Enlace</option>
                    <option value="PHONE_NUMBER">Llamar</option>
                  </select>
                  <input
                    className={inputCls}
                    maxLength={25}
                    value={b.text}
                    placeholder="Texto del botón"
                    onChange={(e) => setButtons((prev) => prev.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))}
                  />
                  {b.type === "URL" ? (
                    <input
                      className={inputCls}
                      value={b.url}
                      placeholder="https://…"
                      onChange={(e) => setButtons((prev) => prev.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))}
                    />
                  ) : b.type === "PHONE_NUMBER" ? (
                    <input
                      className={inputCls}
                      value={b.phone_number}
                      placeholder="+595981123456"
                      onChange={(e) => setButtons((prev) => prev.map((x, j) => (j === i ? { ...x, phone_number: e.target.value } : x)))}
                    />
                  ) : (
                    <span className="self-center text-[11px] text-slate-500">En la campaña configurás qué pasa al tocarlo.</span>
                  )}
                  <button
                    type="button"
                    onClick={() => setButtons((prev) => prev.filter((_, j) => j !== i))}
                    className="rounded-lg border border-slate-300 px-2 text-xs text-slate-600 hover:bg-slate-50"
                  >
                    Quitar
                  </button>
                </div>
              ))}
              {buttons.length < 10 && (
                <button
                  type="button"
                  onClick={() => setButtons((prev) => [...prev, { type: "QUICK_REPLY", text: "", url: "", phone_number: "" }])}
                  className="rounded-lg border border-dashed border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                >
                  + Agregar botón
                </button>
              )}
            </div>

            <div className="flex justify-end gap-2 border-t border-slate-100 pt-3">
              <button
                type="button"
                onClick={() => {
                  resetForm();
                  setShowForm(false);
                }}
                className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={() => void submit()}
                disabled={saving || uploading || !name || !bodyText.trim()}
                className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                {saving ? "Enviando a Meta…" : "Enviar a revisión de Meta"}
              </button>
            </div>
          </div>

          <div className="space-y-2">
            <span className="text-xs font-semibold text-slate-600">Vista previa</span>
            <div className="rounded-2xl bg-[#e5ddd5] p-4">
              <div className="max-w-[280px] overflow-hidden rounded-lg bg-white text-sm shadow">
                {(headerKind === "image" || headerKind === "video") && (
                  <div className="flex h-40 items-center justify-center bg-slate-200 text-xs text-slate-500">
                    {headerFile && headerKind === "image" ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={headerFile.previewUrl} alt="" className="h-full w-full object-cover" />
                    ) : headerFile ? (
                      <video src={headerFile.previewUrl} className="h-full w-full object-cover" muted controls />
                    ) : headerKind === "image" ? (
                      "🖼️ Foto"
                    ) : (
                      "🎬 Video"
                    )}
                  </div>
                )}
                {headerKind === "document" && (
                  <div className="m-2 flex items-center gap-2 rounded-md bg-slate-100 px-3 py-3 text-xs text-slate-700">
                    <span className="text-2xl">📄</span>
                    <span className="truncate font-medium">{headerFile?.name ?? "Documento.pdf"}</span>
                  </div>
                )}
                <div className="space-y-1 px-3 py-2">
                  {headerKind === "text" && headerText && (
                    <p className="font-semibold text-slate-900">{fillVars(headerText, [headerExample])}</p>
                  )}
                  <p
                    className="whitespace-pre-wrap break-words text-slate-800"
                    dangerouslySetInnerHTML={{ __html: whatsappToHtml(fillVars(bodyText, examples) || "Tu mensaje…") }}
                  />
                  {footer && <p className="text-xs text-slate-400">{footer}</p>}
                </div>
                {buttons.map((b, i) => (
                  <div key={i} className="border-t border-slate-100 py-2 text-center text-sm font-medium text-[#1f8fdf]">
                    {b.text || "Botón"}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>
      )}

      <input
        ref={defaultInputRef}
        type="file"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void uploadDefaultFile(f);
        }}
      />
      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-2">Nombre</th>
              <th className="px-4 py-2">Idioma</th>
              <th className="px-4 py-2">Categoría</th>
              <th className="px-4 py-2">Estado</th>
              <th className="px-4 py-2">Mensaje</th>
              <th className="px-4 py-2">Archivo para campañas</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((t) => {
              const st = STATUS_LABEL[t.status] ?? { label: t.status, cls: "border-slate-200 bg-slate-50 text-slate-600" };
              const body = t.components.find((c) => String(c.type).toUpperCase() === "BODY")?.text ?? "";
              return (
                <tr key={`${t.name}-${t.language}`} className="border-t border-slate-100 align-top">
                  <td className="px-4 py-2 font-mono text-xs text-slate-800">{t.name}</td>
                  <td className="px-4 py-2 text-xs text-slate-600">{t.language}</td>
                  <td className="px-4 py-2 text-xs text-slate-600">{CATEGORY_LABEL[t.category ?? ""] ?? t.category ?? "—"}</td>
                  <td className="px-4 py-2">
                    <span className={`inline-block rounded-full border px-2 py-0.5 text-[11px] font-semibold ${st.cls}`}>{st.label}</span>
                    {t.rejected_reason && (
                      <p className="mt-1 text-[11px] text-red-600">{REJECT_LABEL[t.rejected_reason] ?? t.rejected_reason}</p>
                    )}
                  </td>
                  <td className="max-w-md px-4 py-2 text-xs text-slate-600">
                    <p className="line-clamp-3 whitespace-pre-wrap" dangerouslySetInnerHTML={{ __html: whatsappToHtml(body) }} />
                  </td>
                  <td className="px-4 py-2 text-xs">
                    {(() => {
                      const kind = templateMediaKind(t);
                      if (!kind) return <span className="text-slate-400">No lleva</span>;
                      const busy = defaultUploadingKey === `${t.name}-${t.language}`;
                      return (
                        <div className="flex flex-col items-start gap-1">
                          {t.default_header_url ? (
                            <a href={t.default_header_url} target="_blank" rel="noreferrer" className="font-semibold text-emerald-700 hover:underline">
                              ✓ Cargado (ver)
                            </a>
                          ) : (
                            <span className="font-semibold text-amber-700">Falta: va en el Excel</span>
                          )}
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => pickDefaultFile(t, kind)}
                            className="rounded-md border border-[#4FAEB2]/50 bg-white px-2 py-0.5 font-semibold text-[#3F8E91] hover:bg-[#4FAEB2]/10 disabled:opacity-50"
                          >
                            {busy ? "Subiendo…" : t.default_header_url ? "Cambiar" : `Subir ${MEDIA_RULES[kind].label.replace(/^(la|el) /, "")}`}
                          </button>
                        </div>
                      );
                    })()}
                  </td>
                </tr>
              );
            })}
            {!loading && sorted.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-sm text-slate-500">
                  {channelId ? "No hay plantillas en esta cuenta." : "Elegí un canal."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}
