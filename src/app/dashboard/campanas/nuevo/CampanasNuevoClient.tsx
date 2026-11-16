"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";
import { FancySelect } from "@/app/dashboard/proyectos/components/FancySelect";

export type CampanasNuevoClientProps = {
  variant?: "page" | "modal";
  onClose?: () => void;
  onCreated?: (id: string) => void;
};

type ChannelOpt = {
  id: string;
  nombre: string | null;
  provider: string | null;
  type: string | null;
};

type QueueOpt = { id: string; nombre: string | null };

type TemplateOpt = {
  id: string;
  name: string;
  language: string;
  category: string | null;
  components_json: unknown[];
  variable_schema_json: Record<string, unknown>;
};

function providerFromChannel(ch: ChannelOpt): "meta" | "ycloud" {
  const p = String(ch.provider ?? "").trim().toLowerCase();
  if (p === "ycloud") return "ycloud";
  return "meta";
}

export default function CampanasNuevoClient({
  variant = "page",
  onClose,
  onCreated,
}: CampanasNuevoClientProps = {}) {
  const router = useRouter();
  const isModal = variant === "modal";
  const closeOrBack = () => {
    if (onClose) onClose();
    else router.push("/dashboard/campanas");
  };
  const [name, setName] = useState("");
  const [channels, setChannels] = useState<ChannelOpt[]>([]);
  const [queues, setQueues] = useState<QueueOpt[]>([]);
  const [channelId, setChannelId] = useState("");
  const [queueId, setQueueId] = useState("");
  const [templates, setTemplates] = useState<TemplateOpt[]>([]);
  const [templateId, setTemplateId] = useState("");
  const [syncSummary, setSyncSummary] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetchWithSupabaseSession("/api/campanas/options", { cache: "no-store" });
      const json = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        data?: { channels: ChannelOpt[]; queues: QueueOpt[] };
      };
      if (cancelled || !res.ok || !json.success || !json.data) return;
      setChannels(json.data.channels ?? []);
      setQueues(json.data.queues ?? []);
      if ((json.data.channels ?? []).length === 1) {
        setChannelId(json.data.channels[0].id);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedChannel = useMemo(
    () => channels.find((c) => c.id === channelId),
    [channels, channelId]
  );

  const selectedTemplate = useMemo(
    () => templates.find((t) => t.id === templateId),
    [templates, templateId]
  );

  const slots = useMemo(() => {
    const vs = selectedTemplate?.variable_schema_json as { body_slots?: string[] } | undefined;
    return Array.isArray(vs?.body_slots) ? vs!.body_slots : [];
  }, [selectedTemplate]);

  const [mapping, setMapping] = useState<Record<string, string>>({});

  async function syncTemplates() {
    if (!channelId) {
      setErr("Elegí un canal");
      return;
    }
    setBusy(true);
    setErr(null);
    const res = await fetchWithSupabaseSession("/api/campanas/templates/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel_id: channelId }),
    });
    const json = (await res.json().catch(() => ({}))) as {
      success?: boolean;
      error?: string;
      data?: { inserted?: number; fetched?: number };
    };
    setBusy(false);
    if (!res.ok || !json.success) {
      setErr(json.error ?? "No se pudieron sincronizar plantillas");
      setSyncSummary(null);
      return;
    }
    const fetchedFromApi = typeof json.data?.fetched === "number" ? json.data.fetched : undefined;
    const inserted = typeof json.data?.inserted === "number" ? json.data.inserted : undefined;

    const list = await fetchWithSupabaseSession(
      `/api/campanas/templates?channel_id=${encodeURIComponent(channelId)}`,
      { cache: "no-store" }
    );
    const lj = (await list.json().catch(() => ({}))) as { success?: boolean; data?: TemplateOpt[]; error?: string };
    if (!list.ok || !lj.success) {
      setErr(lj.error ?? "No se pudo cargar el listado de plantillas");
      setSyncSummary(null);
      setTemplates([]);
      return;
    }
    const listed = Array.isArray(lj.data) ? lj.data : [];
    setTemplates(listed);

    const n = listed.length;
    if (n > 0) {
      setSyncSummary(`Sincronización completada: ${n} plantilla(s) aprobada(s) disponible(s) para este canal.`);
    } else if (fetchedFromApi === 0) {
      setSyncSummary(
        "Sincronización completada, pero no se encontraron plantillas aprobadas para este canal. Verificá que la plantilla pertenezca al WABA configurado en YCloud y en Configuración → Canales."
      );
    } else if (typeof inserted === "number" && inserted === 0 && (fetchedFromApi ?? 0) > 0) {
      setSyncSummary(
        "YCloud devolvió plantillas pero no se pudieron guardar en el ERP. Revisá permisos de base de datos o contactá soporte."
      );
    } else {
      setSyncSummary(
        "Sincronización completada, pero no hay plantillas en el listado. Probá de nuevo o verificá el canal en Configuración → Canales."
      );
    }
  }

  async function createCampaign() {
    if (!name.trim() || !channelId || !selectedTemplate) {
      setErr("Nombre, canal y plantilla son obligatorios");
      return;
    }
    const prov = providerFromChannel(selectedChannel ?? { id: "", nombre: "", provider: null, type: null });
    setBusy(true);
    setErr(null);
    const res = await fetchWithSupabaseSession("/api/campanas", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: name.trim(),
        channel_id: channelId,
        queue_id: queueId || null,
        provider: prov,
        template_id: selectedTemplate.id,
        template_name: selectedTemplate.name,
        template_language: selectedTemplate.language,
        template_category: selectedTemplate.category,
        template_components_json: selectedTemplate.components_json,
        variable_mapping_json: mapping,
      }),
    });
    const json = (await res.json().catch(() => ({}))) as {
      success?: boolean;
      data?: { id: string };
      error?: string;
    };
    setBusy(false);
    if (!res.ok || !json.success || !json.data?.id) {
      setErr(json.error ?? "No se pudo crear");
      return;
    }
    const newId = json.data.id;
    if (onCreated) {
      onCreated(newId);
      if (onClose) onClose();
    } else {
      router.push(`/dashboard/campanas/${newId}`);
    }
  }

  return (
    <div className={`space-y-6 ${isModal ? "" : "mx-auto max-w-3xl p-6"}`}>
      {!isModal && (
        <div>
          <Link
            href="/dashboard/campanas"
            className="inline-flex items-center gap-1 text-sm font-semibold text-[#3F8E91] transition-colors hover:text-[#4FAEB2]"
          >
            ← Volver al listado
          </Link>
          <div className="mt-3 flex items-center gap-2">
            <span
              aria-hidden="true"
              className="inline-block h-1.5 w-1.5 rounded-full bg-[#4FAEB2] shadow-[0_0_0_3px_rgba(79,174,178,0.18)]"
            />
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#4FAEB2]">
              Nueva campaña
            </p>
          </div>
          <h1 className="mt-0.5 text-lg font-semibold tracking-tight text-slate-900">
            Crear borrador
          </h1>
          <p className="text-xs text-slate-500">
            Configurá canal, cola y plantilla; en el detalle importás el archivo y validás variables.
          </p>
        </div>
      )}

      {err ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {err}
        </div>
      ) : null}

      <section className="space-y-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm ring-1 ring-[#4FAEB2]/15">
        <label className="block">
          <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
            Nombre de la campaña
          </span>
          <input
            className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-slate-400 hover:border-[#4FAEB2]/60 focus:border-[#4FAEB2] focus:outline-none focus:ring-2 focus:ring-[#4FAEB2]/20"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ej. Promo marzo"
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
            Canal WhatsApp
          </span>
          <FancySelect
            ariaLabel="Canal WhatsApp"
            placeholder="Seleccionar…"
            value={channelId}
            onChange={(v) => {
              setChannelId(v);
              setTemplates([]);
              setTemplateId("");
              setSyncSummary(null);
            }}
            options={[
              { value: "", label: "Seleccionar…" },
              ...channels.map((c) => ({
                value: c.id,
                label: `${c.nombre || c.id} (${c.provider || "meta"})`,
              })),
            ]}
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
            Cola de respuesta
          </span>
          <FancySelect
            ariaLabel="Cola de respuesta"
            placeholder="(opcional — usa reglas del canal)"
            value={queueId}
            onChange={(v) => setQueueId(v)}
            options={[
              { value: "", label: "(opcional — usa reglas del canal)" },
              ...queues.map((q) => ({ value: q.id, label: q.nombre || q.id })),
            ]}
          />
        </label>

        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-dashed border-[#4FAEB2]/30 bg-[#4FAEB2]/5 p-3">
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-lg border border-[#4FAEB2]/45 bg-white px-3 py-1.5 text-xs font-semibold text-[#3F8E91] shadow-sm transition-colors hover:bg-[#4FAEB2]/10 disabled:opacity-50"
            disabled={busy || !channelId}
            onClick={() => void syncTemplates()}
          >
            Sincronizar plantillas aprobadas
          </button>
          {syncSummary ? <span className="text-xs text-slate-600">{syncSummary}</span> : null}
        </div>

        <label className="block">
          <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
            Plantilla
          </span>
          <FancySelect
            ariaLabel="Plantilla"
            placeholder="Seleccionar…"
            value={templateId}
            onChange={(v) => setTemplateId(v)}
            options={[
              { value: "", label: "Seleccionar…" },
              ...templates.map((t) => ({
                value: t.id,
                label: `${t.name} (${t.language})`,
              })),
            ]}
          />
        </label>

        {slots.length > 0 ? (
          <div className="space-y-2 rounded-xl border border-slate-200 bg-slate-50/70 p-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#4FAEB2]">
              Preview de mapeo (columnas del Excel)
            </p>
            <p className="text-xs text-slate-500">
              En el paso siguiente importarás el archivo; aquí podés adelantar el nombre de columna por cada{" "}
              {"{{n}}"}. También podés completarlo en la pantalla de detalle.
            </p>
            {slots.map((s) => (
              <label key={s} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="w-16 font-mono text-slate-600">{`{{${s}}}`}</span>
                <input
                  className="flex-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs shadow-sm transition-colors placeholder:text-slate-400 hover:border-[#4FAEB2]/60 focus:border-[#4FAEB2] focus:outline-none focus:ring-2 focus:ring-[#4FAEB2]/20"
                  placeholder="Nombre columna en Excel"
                  value={mapping[s] ?? ""}
                  onChange={(e) => setMapping((m) => ({ ...m, [s]: e.target.value }))}
                />
              </label>
            ))}
          </div>
        ) : null}

        <div className="flex items-center justify-end gap-2 pt-2">
          {isModal && (
            <button
              type="button"
              onClick={closeOrBack}
              className="px-4 py-2.5 text-sm text-slate-500 transition-colors hover:text-[#4FAEB2]"
            >
              Cancelar
            </button>
          )}
          <button
            type="button"
            className="rounded-lg bg-[#4FAEB2] px-5 py-2.5 text-sm font-semibold text-white shadow-sm shadow-[#4FAEB2]/25 transition-colors hover:bg-[#3F8E91] disabled:opacity-50"
            disabled={busy}
            onClick={() => void createCampaign()}
          >
            {busy ? "Creando…" : "Crear borrador y continuar"}
          </button>
        </div>
      </section>
    </div>
  );
}
