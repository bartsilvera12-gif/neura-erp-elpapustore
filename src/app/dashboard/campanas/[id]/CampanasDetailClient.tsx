"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";
import {
  buildCampaignTemplatePreviewText,
  extractBodyPlaceholderKeysOrdered,
} from "@/lib/campaigns/campaign-placeholders-shared";
import {
  extractQuickReplyButtonsFromTemplateComponents,
  type TemplateQuickReplyButton,
} from "@/lib/campaigns/template-quick-reply-buttons";

type SavedButtonActionRow = {
  button_id: string;
  button_label?: string | null;
  action_type: string;
  flow_code?: string | null;
  start_node_code?: string | null;
  text_body?: string | null;
};

function mergeTemplateWithSavedButtonActions(
  templateButtons: TemplateQuickReplyButton[],
  saved: SavedButtonActionRow[]
) {
  return templateButtons.map((t) => {
    const s =
      saved.find((x) => x.button_id === t.suggested_button_id) ??
      saved.find((x) => (x.button_label ?? "").trim() === t.label);
    const rawAt = String(s?.action_type ?? "none").trim();
    const action_type: "none" | "start_flow" | "send_text" =
      rawAt === "start_flow"
        ? "start_flow"
        : rawAt === "send_text"
          ? "send_text"
          : "none";
    return {
      button_id: (s?.button_id ?? t.suggested_button_id).trim(),
      button_label: t.label,
      action_type,
      flow_code: String(s?.flow_code ?? "").trim(),
      start_node_code: String(s?.start_node_code ?? "").trim(),
      text_body: String(s?.text_body ?? "").trim(),
    };
  });
}

type CampaignDetail = Record<string, unknown> & {
  id: string;
  name: string;
  status: string;
  channel_id: string;
  queue_id: string | null;
  provider: string;
  template_name: string;
  template_language: string;
  template_components_json: unknown[];
  variable_mapping_json: Record<string, unknown>;
  send_config_json?: Record<string, unknown> | null;
  total_count: number;
  sent_count: number;
  failed_count: number;
  replied_count: number;
};

type EvRow = {
  id: string;
  event_type: string;
  created_at: string;
  event_payload_json: unknown;
};

type RecipientRow = {
  id: string;
  row_number: number;
  phone_e164: string;
  status: string;
  row_payload_json?: Record<string, string>;
  mapped_variables_json?: Record<string, unknown>;
  provider_message_id?: string | null;
  first_reply_at?: string | null;
};

export type CampanasDetailClientProps = {
  campaignId: string;
  variant?: "page" | "modal";
  onClose?: () => void;
};

export default function CampanasDetailClient({
  campaignId,
  variant = "page",
  onClose: _onClose,
}: CampanasDetailClientProps) {
  void _onClose;
  const isModal = variant === "modal";
  const [campaign, setCampaign] = useState<CampaignDetail | null>(null);
  const [events, setEvents] = useState<EvRow[]>([]);
  const [recipients, setRecipients] = useState<unknown[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [showEvents, setShowEvents] = useState(false);

  const load = useCallback(async () => {
    const res = await fetchWithSupabaseSession(`/api/campanas/${campaignId}`, { cache: "no-store" });
    const json = (await res.json().catch(() => ({}))) as {
      success?: boolean;
      data?: { campaign: CampaignDetail; events: EvRow[] };
      error?: string;
    };
    if (!res.ok || !json.success || !json.data?.campaign) {
      setErr(json.error ?? "No se pudo cargar");
      setLoading(false);
      return;
    }
    setCampaign(json.data.campaign);
    setEvents(json.data.events ?? []);
    const vm = json.data.campaign.variable_mapping_json ?? {};
    const flat: Record<string, string> = {};
    for (const [k, v] of Object.entries(vm)) {
      const key = k.replace(/^\{\{|\}\}$/g, "").trim();
      flat[key] = String(v ?? "");
    }
    setMapping(flat);

    const rr = await fetchWithSupabaseSession(`/api/campanas/${campaignId}/recipients?limit=100`, {
      cache: "no-store",
    });
    const rj = (await rr.json().catch(() => ({}))) as {
      success?: boolean;
      data?: { recipients: unknown[] };
    };
    if (rr.ok && rj.success && rj.data?.recipients) setRecipients(rj.data.recipients);

    setLoading(false);
  }, [campaignId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Guard "en vuelo": nunca disparar /process si el anterior sigue corriendo. Sin esto, el
  // setInterval acumulaba llamadas concurrentes cuando un batch tardaba > el intervalo, y cada
  // una reenviaba a los mismos destinatarios (duplicados 3-7x). El claim atómico del server ya lo
  // blinda; esto además evita llamadas al pedo.
  const processingRef = useRef(false);
  useEffect(() => {
    if (!campaign || campaign.status !== "sending") return;
    const t = window.setInterval(() => {
      if (processingRef.current) return;
      processingRef.current = true;
      void (async () => {
        try {
          await fetchWithSupabaseSession("/api/campanas/process", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ campaign_id: campaignId }),
          });
          await load();
        } finally {
          processingRef.current = false;
        }
      })();
    }, 4000);
    return () => window.clearInterval(t);
  }, [campaign?.status, campaignId, load, campaign]);

  const placeholderSlots = useMemo(() => {
    const comps = campaign?.template_components_json as unknown;
    return extractBodyPlaceholderKeysOrdered(Array.isArray(comps) ? comps : []);
  }, [campaign?.template_components_json]);

  const excelColumns = useMemo(() => {
    const set = new Set<string>();
    for (const r of recipients as RecipientRow[]) {
      const row = r.row_payload_json;
      if (row && typeof row === "object") {
        for (const k of Object.keys(row)) {
          if (k.trim()) set.add(k);
        }
      }
    }
    return Array.from(set).sort((a, b) => (a === b ? 0 : a < b ? -1 : 1));
  }, [recipients]);

  useEffect(() => {
    if (placeholderSlots.length === 0 || excelColumns.length === 0) return;
    setMapping((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const slot of placeholderSlots) {
        if ((next[slot] ?? "").trim()) continue;
        if (excelColumns.includes(slot)) {
          next[slot] = slot;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [campaignId, excelColumns, placeholderSlots]);

  const previewText = useMemo(() => {
    if (!campaign || placeholderSlots.length === 0) return null;
    const first = (recipients as RecipientRow[])[0];
    const row = first?.row_payload_json;
    if (!row || typeof row !== "object") return null;
    const mappedBySlot: Record<string, string> = {};
    for (const slot of placeholderSlots) {
      const col = (mapping[slot] ?? "").trim();
      if (!col) continue;
      mappedBySlot[slot] = String(row[col] ?? "").trim();
    }
    return buildCampaignTemplatePreviewText({
      templateName: campaign.template_name,
      languageCode: campaign.template_language,
      componentsSnapshot: campaign.template_components_json as unknown[],
      mappedBySlot,
    });
  }, [campaign, mapping, placeholderSlots, recipients]);

  const templateHasHeaderImage = useMemo(() => {
    const vs = campaign?.template_components_json as unknown;
    if (!vs || !Array.isArray(vs)) return false;
    return (vs as { type?: string; format?: string }[]).some(
      (c) =>
        String(c.type ?? "").toUpperCase() === "HEADER" &&
        String(c.format ?? "").toUpperCase() === "IMAGE"
    );
  }, [campaign]);

  const headerImageError =
    typeof campaign?.send_config_json?.header_image_error === "string"
      ? String(campaign.send_config_json.header_image_error)
      : null;

  const quickReplyTemplateButtons = useMemo(
    () =>
      extractQuickReplyButtonsFromTemplateComponents(
        (campaign?.template_components_json ?? []) as unknown[]
      ),
    [campaign?.template_components_json]
  );

  const [buttonActionRows, setButtonActionRows] = useState<
    Array<{
      button_id: string;
      button_label: string;
      action_type: "none" | "start_flow" | "send_text";
      flow_code: string;
      start_node_code: string;
      text_body: string;
    }>
  >([]);

  const [flowCatalog, setFlowCatalog] = useState<Array<{ flow_code: string; label: string }>>([]);
  const [nodeOptionsByFlow, setNodeOptionsByFlow] = useState<
    Record<string, Array<{ node_code: string }>>
  >({});

  const [savingButtonActions, setSavingButtonActions] = useState(false);
  const [buttonActionsFeedback, setButtonActionsFeedback] = useState<
    | { kind: "success"; message: string }
    | { kind: "error"; message: string }
    | null
  >(null);

  useEffect(() => {
    if (!campaign || quickReplyTemplateButtons.length === 0) {
      setButtonActionRows([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      const [baRes, flRes] = await Promise.all([
        fetchWithSupabaseSession(`/api/campanas/${campaignId}/button-actions`, { cache: "no-store" }),
        fetchWithSupabaseSession(`/api/chat/flows`, { cache: "no-store" }),
      ]);
      const baj = (await baRes.json().catch(() => ({}))) as {
        success?: boolean;
        data?: {
          actions?: Array<{
            button_id: string;
            button_label?: string | null;
            action_type: string;
            flow_code?: string | null;
            start_node_code?: string | null;
            text_body?: string | null;
          }>;
        };
      };
      const flj = (await flRes.json().catch(() => ({}))) as {
        ok?: boolean;
        items?: Array<{ flow_code: string; label?: string; activo?: boolean }>;
      };
      if (cancelled) return;
      const saved = (baj.data?.actions ?? []) as SavedButtonActionRow[];
      const flows = (flj.items ?? []).filter((f) => f.activo !== false);
      setFlowCatalog(flows.map((f) => ({ flow_code: f.flow_code, label: f.label ?? f.flow_code })));

      setButtonActionRows(mergeTemplateWithSavedButtonActions(quickReplyTemplateButtons, saved));
    })();
    return () => {
      cancelled = true;
    };
  }, [campaign, campaignId, quickReplyTemplateButtons]);

  async function ensureNodesLoaded(flowCode: string) {
    const fc = flowCode.trim();
    if (!fc || nodeOptionsByFlow[fc]?.length) return;
    const res = await fetchWithSupabaseSession(`/api/chat/flows/${encodeURIComponent(fc)}/nodes`, {
      cache: "no-store",
    });
    const j = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      items?: Array<{ node_code: string }>;
    };
    if (!j.ok || !j.items?.length) return;
    setNodeOptionsByFlow((prev) => ({
      ...prev,
      [fc]: j.items!.map((n) => ({ node_code: n.node_code })),
    }));
  }

  async function saveButtonActions() {
    setSavingButtonActions(true);
    setButtonActionsFeedback(null);
    try {
      const res = await fetchWithSupabaseSession(`/api/campanas/${campaignId}/button-actions`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actions: buttonActionRows.map((r) => ({
            button_id: r.button_id.trim(),
            button_label: r.button_label,
            action_type: r.action_type,
            flow_code: r.action_type === "start_flow" ? r.flow_code.trim() : null,
            start_node_code:
              r.action_type === "start_flow" && r.start_node_code.trim()
                ? r.start_node_code.trim()
                : null,
            text_body: r.action_type === "send_text" ? r.text_body.trim() : null,
          })),
        }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        error?: string;
        data?: { actions?: SavedButtonActionRow[] };
      };
      if (!res.ok || !json.success) {
        const detail = String(json.error ?? "").trim();
        setButtonActionsFeedback({
          kind: "error",
          message: detail
            ? `No se pudieron guardar las acciones de botones. ${detail}`
            : "No se pudieron guardar las acciones de botones. Revisá la configuración.",
        });
        return;
      }
      const serverActions = json.data?.actions;
      if (Array.isArray(serverActions) && quickReplyTemplateButtons.length > 0) {
        setButtonActionRows(
          mergeTemplateWithSavedButtonActions(quickReplyTemplateButtons, serverActions)
        );
      }
      setButtonActionsFeedback({
        kind: "success",
        message: "Acciones de botones guardadas correctamente.",
      });
      await load();
    } catch {
      setButtonActionsFeedback({
        kind: "error",
        message: "No se pudieron guardar las acciones de botones. Revisá la configuración.",
      });
    } finally {
      setSavingButtonActions(false);
    }
  }

  async function uploadFile(file: File) {
    setBusy(true);
    setErr(null);
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetchWithSupabaseSession(`/api/campanas/${campaignId}/import`, {
      method: "POST",
      body: fd,
    });
    const json = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string };
    setBusy(false);
    if (!res.ok || !json.success) {
      setErr(json.error ?? "Importación fallida");
      return;
    }
    await load();
  }

  async function saveMapping() {
    setBusy(true);
    setErr(null);
    const body: Record<string, string> = {};
    for (const [k, v] of Object.entries(mapping)) {
      const t = v.trim();
      if (t) body[k] = t;
    }
    const res = await fetchWithSupabaseSession(`/api/campanas/${campaignId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ variable_mapping_json: body }),
    });
    const json = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string };
    setBusy(false);
    if (!res.ok || !json.success) {
      setErr(json.error ?? "No se pudo guardar el mapeo");
      return;
    }
    await load();
  }

  async function validateMapping() {
    setBusy(true);
    setErr(null);
    const body: Record<string, string> = {};
    for (const [k, v] of Object.entries(mapping)) {
      body[k] = v;
    }
    const res = await fetchWithSupabaseSession(`/api/campanas/${campaignId}/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ variable_mapping_json: body }),
    });
    const json = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string };
    setBusy(false);
    if (!res.ok || !json.success) {
      setErr(json.error ?? "Validación fallida");
      return;
    }
    await load();
  }

  async function launch() {
    setBusy(true);
    setErr(null);
    const res = await fetchWithSupabaseSession(`/api/campanas/${campaignId}/launch`, {
      method: "POST",
    });
    const json = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string };
    setBusy(false);
    if (!res.ok || !json.success) {
      setErr(json.error ?? "No se pudo iniciar envío");
      return;
    }
    await load();
  }

  async function cancelSend() {
    const confirmMsg =
      "¿Cancelar esta campaña?\n\n" +
      "• Esto NO borra mensajes ya enviados.\n" +
      "• Solo detiene envíos pendientes (en cola o por enviar).\n" +
      "• Los destinatarios ya enviados/respondidos/fallidos se conservan.\n" +
      "• Esta acción no se puede deshacer.";
    if (typeof window !== "undefined" && !window.confirm(confirmMsg)) {
      return;
    }
    setBusy(true);
    const res = await fetchWithSupabaseSession(`/api/campanas/${campaignId}/cancel`, {
      method: "POST",
    });
    setBusy(false);
    if (!res.ok) {
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      setErr(json.error ?? "No se pudo cancelar");
      return;
    }
    await load();
  }

  if (loading || !campaign) {
    return (
      <div className={`text-sm text-slate-500 ${isModal ? "p-4" : "p-6"}`}>Cargando…</div>
    );
  }

  const canImport = campaign.status === "draft" || campaign.status === "ready";
  /** Tras validación exitosa el backend pasa a `ready`; envío solo en ese estado. */
  const canLaunch = campaign.status === "ready";
  const canEditButtonActions = String(campaign.status ?? "") !== "cancelled";
  const lockButtonActionsSection = savingButtonActions || !canEditButtonActions;

  const statusBadgeClass = (() => {
    const s = String(campaign.status ?? "").toLowerCase();
    if (s === "completed") return "border-emerald-200 bg-emerald-50 text-emerald-700";
    if (s === "sending") return "border-[#4FAEB2]/30 bg-[#4FAEB2]/10 text-[#3F8E91]";
    if (s === "ready") return "border-amber-200 bg-amber-50 text-amber-800";
    if (s === "cancelled") return "border-red-200 bg-red-50 text-red-700";
    return "border-slate-200 bg-slate-50 text-slate-600";
  })();

  return (
    <div className={`space-y-5 ${isModal ? "" : "p-6"}`}>
      {!isModal && (
        <div>
          <Link
            href="/dashboard/campanas"
            className="inline-flex items-center gap-1 text-sm font-semibold text-[#3F8E91] transition-colors hover:text-[#4FAEB2]"
          >
            ← Campañas
          </Link>
          <div className="mt-3 flex items-center gap-2">
            <span
              aria-hidden="true"
              className="inline-block h-1.5 w-1.5 rounded-full bg-[#4FAEB2] shadow-[0_0_0_3px_rgba(79,174,178,0.18)]"
            />
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#4FAEB2]">
              Campaña
            </p>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-2">
            <h1 className="text-lg font-semibold tracking-tight text-slate-900 sm:text-xl">
              {String(campaign.name)}
            </h1>
            <span
              className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-semibold capitalize ${statusBadgeClass}`}
            >
              <span
                aria-hidden="true"
                className={`h-1.5 w-1.5 rounded-full ${
                  String(campaign.status) === "completed"
                    ? "bg-emerald-500"
                    : String(campaign.status) === "sending"
                    ? "bg-[#4FAEB2]"
                    : String(campaign.status) === "ready"
                    ? "bg-amber-500"
                    : String(campaign.status) === "cancelled"
                    ? "bg-red-500"
                    : "bg-slate-400"
                }`}
              />
              {String(campaign.status)}
            </span>
          </div>
          <p className="mt-1 text-xs text-slate-500">
            Plantilla{" "}
            <span className="font-semibold text-slate-700">{String(campaign.template_name)}</span>{" "}
            <span className="text-slate-400">({String(campaign.template_language)})</span>
          </p>
        </div>
      )}

      {err ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {err}
        </div>
      ) : null}

      {headerImageError ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {headerImageError}
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-4">
        {[
          { label: "Total", val: campaign.total_count, accent: "slate" },
          { label: "Enviados", val: campaign.sent_count, accent: "emerald" },
          { label: "Fallidos", val: campaign.failed_count, accent: "red" },
          { label: "Respondieron", val: campaign.replied_count, accent: "turquesa" },
        ].map(({ label, val, accent }) => {
          const cfg = {
            slate: { border: "border-slate-200", text: "text-slate-900", eyebrow: "text-slate-500" },
            emerald: {
              border: "border-emerald-200",
              text: "text-emerald-700",
              eyebrow: "text-emerald-600",
            },
            red: { border: "border-red-200", text: "text-red-700", eyebrow: "text-red-600" },
            turquesa: {
              border: "border-[#4FAEB2]/30",
              text: "text-[#3F8E91]",
              eyebrow: "text-[#4FAEB2]",
            },
          }[accent] ?? { border: "border-slate-200", text: "text-slate-900", eyebrow: "text-slate-500" };
          return (
            <div
              key={label}
              className={`rounded-2xl border bg-white p-4 shadow-sm ${cfg.border}`}
            >
              <p
                className={`text-[10px] font-semibold uppercase tracking-[0.14em] ${cfg.eyebrow}`}
              >
                {label}
              </p>
              <p className={`mt-1 text-2xl font-bold tabular-nums ${cfg.text}`}>
                {Number(val ?? 0)}
              </p>
            </div>
          );
        })}
      </div>

      <section className="space-y-3 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm ring-1 ring-[#4FAEB2]/15">
        <div className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="inline-block h-1.5 w-1.5 rounded-full bg-[#4FAEB2] shadow-[0_0_0_3px_rgba(79,174,178,0.18)]"
          />
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#4FAEB2]">
            Importación (.xlsx / .csv)
          </h2>
        </div>
        <input
          type="file"
          accept=".xlsx,.xls,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          disabled={!canImport || busy}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void uploadFile(f);
          }}
          className="block text-sm text-slate-600"
        />
        <p className="text-xs text-slate-500">Máximo 5.000 filas / 5 MB.</p>
        {templateHasHeaderImage ? (
          <p className="text-xs text-slate-600">
            <strong>Imagen de cabecera (Meta):</strong> agregá una columna <code className="rounded bg-slate-100 px-1">header_image_url</code>{" "}
            en el Excel con una URL <strong>https</strong> pública. En esta fase todas las filas válidas deben usar la
            misma URL.
          </p>
        ) : null}
      </section>

      {placeholderSlots.length > 0 ? (
        <section className="space-y-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm ring-1 ring-[#4FAEB2]/15">
          <div>
            <div className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className="inline-block h-1.5 w-1.5 rounded-full bg-[#4FAEB2] shadow-[0_0_0_3px_rgba(79,174,178,0.18)]"
              />
              <h2 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#4FAEB2]">
                Mapeo de variables
              </h2>
            </div>
            <p className="mt-1 text-xs text-slate-500">
              Cada variable del <strong>body</strong> de la plantilla debe corresponder a una columna del Excel. Si el
              nombre de la columna coincide exactamente con la variable, se selecciona sola.
            </p>
          </div>

          {excelColumns.length === 0 ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              Importá un archivo (.xlsx / .csv) para listar las columnas disponibles en los selectores.
            </div>
          ) : null}

          <div className="overflow-hidden rounded-xl border border-slate-200">
            <table className="min-w-full divide-y divide-slate-100 text-sm">
              <thead className="bg-slate-50/70 text-left text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">
                <tr>
                  <th className="px-3 py-2">Variable en plantilla</th>
                  <th className="px-3 py-2">Columna del Excel</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {placeholderSlots.map((slot) => (
                  <tr key={slot} className="transition-colors hover:bg-[#4FAEB2]/[0.04]">
                    <td className="whitespace-nowrap px-3 py-2 font-mono text-slate-700">{`{{${slot}}}`}</td>
                    <td className="px-3 py-2">
                      <select
                        className="w-full max-w-md rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm shadow-sm transition-colors hover:border-[#4FAEB2]/60 focus:border-[#4FAEB2] focus:outline-none focus:ring-2 focus:ring-[#4FAEB2]/20 disabled:bg-slate-50 disabled:text-slate-400"
                        disabled={!canImport || busy}
                        value={mapping[slot] ?? ""}
                        onChange={(e) =>
                          setMapping((m) => ({
                            ...m,
                            [slot]: e.target.value,
                          }))
                        }
                      >
                        <option value="">— Elegí columna —</option>
                        {excelColumns.map((col) => (
                          <option key={col} value={col}>
                            {col}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              disabled={busy || !canImport}
              onClick={() => void saveMapping()}
              className="rounded-lg border border-slate-200 bg-white px-3.5 py-1.5 text-xs font-semibold text-slate-700 shadow-sm transition-colors hover:border-[#4FAEB2]/60 hover:text-[#3F8E91] disabled:opacity-50"
            >
              Guardar mapeo
            </button>
            <button
              type="button"
              disabled={busy || !canImport}
              onClick={() => void validateMapping()}
              className="rounded-lg bg-[#4FAEB2] px-4 py-1.5 text-xs font-semibold text-white shadow-sm shadow-[#4FAEB2]/25 transition-colors hover:bg-[#3F8E91] disabled:opacity-50"
            >
              Validar destinatarios
            </button>
          </div>

          {campaign.status !== "ready" && placeholderSlots.length > 0 ? (
            <p className="text-xs text-slate-500">
              Cuando la validación sea correcta, el estado pasará a <strong>ready</strong> y podrás usar{" "}
              <strong>Enviar ahora</strong>.
            </p>
          ) : null}

          {previewText ? (
            <div className="rounded-xl border border-[#4FAEB2]/30 bg-[#4FAEB2]/5 p-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#4FAEB2]">
                Vista previa (primera fila del Excel)
              </p>
              <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-white px-3 py-2 text-xs text-slate-700 ring-1 ring-slate-100">
                {previewText}
              </pre>
            </div>
          ) : placeholderSlots.length > 0 && excelColumns.length > 0 ? (
            <p className="text-xs text-slate-500">
              Completá el mapeo y/o revisá que la primera fila tenga datos para ver la vista previa sin placeholders.
            </p>
          ) : null}
        </section>
      ) : null}

      {/* ETQ-CAMP-FIX-4: si la template NO tiene variables, igual hace falta pasar por /validate
          para marcar la campaña como ready y habilitar "Enviar ahora". Antes este bloque solo
          existia dentro de la sección de mapeo, que se ocultaba cuando placeholders=0. */}
      {placeholderSlots.length === 0 && campaign.status !== "ready" && campaign.status !== "sending" && campaign.status !== "completed" && campaign.status !== "cancelled" ? (
        <section className="space-y-3 rounded-2xl border border-amber-200 bg-amber-50/40 p-5 shadow-sm">
          <div className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500 shadow-[0_0_0_3px_rgba(245,158,11,0.18)]"
            />
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-700">
              Listo para validar
            </h2>
          </div>
          <p className="text-sm text-slate-700">
            Esta plantilla no tiene variables <code className="rounded bg-slate-100 px-1 text-xs">{`{{var}}`}</code> en el body, así que no hay mapeo a configurar.
            Igual hace falta marcar la campaña como lista antes de enviar.
          </p>
          {campaign.status === "draft" ? (
            <p className="text-xs text-slate-500">
              Al pulsar el botón el backend valida los destinatarios y el estado pasa de <strong>draft</strong> a <strong>ready</strong>. Recién entonces se habilita <strong>Enviar ahora</strong>.
            </p>
          ) : null}
          <div className="flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              disabled={busy || !canImport}
              onClick={() => void validateMapping()}
              className="rounded-lg bg-[#4FAEB2] px-4 py-1.5 text-xs font-semibold text-white shadow-sm shadow-[#4FAEB2]/25 transition-colors hover:bg-[#3F8E91] disabled:opacity-50"
            >
              Marcar campaña como lista para enviar
            </button>
          </div>
        </section>
      ) : null}

      {quickReplyTemplateButtons.length > 0 ? (
        <section className="space-y-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm ring-1 ring-[#4FAEB2]/15">
          <div className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="inline-block h-1.5 w-1.5 rounded-full bg-[#4FAEB2] shadow-[0_0_0_3px_rgba(79,174,178,0.18)]"
            />
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#4FAEB2]">
              Acciones de botones
            </h2>
          </div>
          <p className="text-xs text-slate-600">
            Configurá qué hace cada respuesta rápida de la plantilla cuando el cliente la toca. El valor{" "}
            <strong>ID / payload</strong> debe coincidir con el que envía WhatsApp en{" "}
            <code className="rounded bg-slate-100 px-1">button.payload</code> /{" "}
            <code className="rounded bg-slate-100 px-1">interactive.button_reply.id</code> (en Meta podés ver el payload
            real del clic).
          </p>
          {!canEditButtonActions ? (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              Las campañas canceladas no permiten guardar acciones de botones. Para otras campañas podés corregir el
              ID/payload y el flujo aunque el envío ya haya terminado.
            </p>
          ) : null}
          {buttonActionsFeedback?.kind === "success" ? (
            <div
              className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900"
              role="status"
            >
              {buttonActionsFeedback.message}
            </div>
          ) : null}
          {buttonActionsFeedback?.kind === "error" ? (
            <div
              className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
              role="alert"
            >
              {buttonActionsFeedback.message}
            </div>
          ) : null}
          <div className="space-y-4">
            {buttonActionRows.map((row, idx) => (
              <div
                key={`${row.button_label}-${idx}`}
                className="rounded-xl border border-slate-200 bg-slate-50/70 p-3 text-sm"
              >
                <div className="font-medium text-slate-800">{row.button_label}</div>
                <label className="mt-2 block text-xs text-slate-600">
                  ID / payload del botón (Meta)
                  <input
                    className="mt-1 w-full rounded border border-slate-300 px-2 py-1 font-mono text-xs disabled:bg-slate-100"
                    disabled={lockButtonActionsSection}
                    value={row.button_id}
                    onChange={(e) => {
                      const v = e.target.value;
                      setButtonActionsFeedback(null);
                      setButtonActionRows((prev) =>
                        prev.map((r, i) => (i === idx ? { ...r, button_id: v } : r))
                      );
                    }}
                  />
                </label>
                <label className="mt-2 block text-xs text-slate-600">
                  Acción
                  <select
                    className="mt-1 w-full rounded border border-slate-300 px-2 py-1 disabled:bg-slate-100"
                    disabled={lockButtonActionsSection}
                    value={row.action_type}
                    onChange={(e) => {
                      const v = e.target.value as typeof row.action_type;
                      setButtonActionsFeedback(null);
                      setButtonActionRows((prev) =>
                        prev.map((r, i) => (i === idx ? { ...r, action_type: v } : r))
                      );
                    }}
                  >
                    <option value="none">Sin acción adicional</option>
                    <option value="start_flow">Iniciar flujo</option>
                    <option value="send_text">Enviar texto</option>
                  </select>
                </label>
                {row.action_type === "start_flow" ? (
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    <label className="block text-xs text-slate-600">
                      Flujo
                      <select
                        className="mt-1 w-full rounded border border-slate-300 px-2 py-1 disabled:bg-slate-100"
                        disabled={lockButtonActionsSection}
                        value={row.flow_code}
                        onChange={(e) => {
                          const fc = e.target.value;
                          setButtonActionsFeedback(null);
                          setButtonActionRows((prev) =>
                            prev.map((r, i) =>
                              i === idx ? { ...r, flow_code: fc, start_node_code: "" } : r
                            )
                          );
                          void ensureNodesLoaded(fc);
                        }}
                      >
                        <option value="">— Elegí un flujo —</option>
                        {flowCatalog.map((f) => (
                          <option key={f.flow_code} value={f.flow_code}>
                            {f.label} ({f.flow_code})
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="block text-xs text-slate-600">
                      Nodo inicial (opcional)
                      <select
                        className="mt-1 w-full rounded border border-slate-300 px-2 py-1 disabled:bg-slate-100"
                        disabled={lockButtonActionsSection}
                        value={row.start_node_code}
                        onFocus={() => void ensureNodesLoaded(row.flow_code)}
                        onChange={(e) => {
                          const nc = e.target.value;
                          setButtonActionsFeedback(null);
                          setButtonActionRows((prev) =>
                            prev.map((r, i) => (i === idx ? { ...r, start_node_code: nc } : r))
                          );
                        }}
                      >
                        <option value="">— Por defecto (primer nodo activo) —</option>
                        {(nodeOptionsByFlow[row.flow_code.trim()] ?? []).map((n) => (
                          <option key={n.node_code} value={n.node_code}>
                            {n.node_code}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                ) : null}
                {row.action_type === "send_text" ? (
                  <label className="mt-2 block text-xs text-slate-600">
                    Texto a enviar
                    <textarea
                      className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-sm disabled:bg-slate-100"
                      disabled={lockButtonActionsSection}
                      rows={3}
                      value={row.text_body}
                      onChange={(e) => {
                        const v = e.target.value;
                        setButtonActionsFeedback(null);
                        setButtonActionRows((prev) =>
                          prev.map((r, i) => (i === idx ? { ...r, text_body: v } : r))
                        );
                      }}
                    />
                  </label>
                ) : null}
              </div>
            ))}
          </div>
          <button
            type="button"
            disabled={savingButtonActions || busy || !canEditButtonActions}
            onClick={() => void saveButtonActions()}
            className="rounded-lg border border-[#4FAEB2]/45 bg-white px-4 py-2 text-sm font-semibold text-[#3F8E91] shadow-sm transition-colors hover:bg-[#4FAEB2]/10 disabled:opacity-50"
          >
            {savingButtonActions ? "Guardando…" : "Guardar acciones de botones"}
          </button>
        </section>
      ) : null}

      <div className="flex flex-wrap items-center justify-end gap-2">
        <button
          type="button"
          disabled={
            busy ||
            !["draft", "ready", "sending"].includes(String(campaign.status ?? ""))
          }
          onClick={() => void cancelSend()}
          className="inline-flex items-center gap-1.5 rounded-lg border border-red-300 bg-white px-4 py-2 text-sm font-semibold text-red-700 transition-colors hover:bg-red-50 disabled:opacity-50"
          title="Detiene envíos pendientes. No borra mensajes ya enviados."
        >
          Cancelar envío
        </button>
        <button
          type="button"
          disabled={busy || !canLaunch || campaign.total_count === 0}
          onClick={() => void launch()}
          className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-emerald-700 disabled:opacity-50"
        >
          Enviar ahora
        </button>
      </div>

      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm ring-1 ring-[#4FAEB2]/15">
        <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-3">
          <span
            aria-hidden="true"
            className="inline-block h-1.5 w-1.5 rounded-full bg-[#4FAEB2] shadow-[0_0_0_3px_rgba(79,174,178,0.18)]"
          />
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#4FAEB2]">
            Destinatarios (primeras filas)
          </h2>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-100 text-xs">
            <thead className="bg-slate-50/70 text-left text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">
              <tr>
                <th className="px-3 py-2">#</th>
                <th className="px-3 py-2">Teléfono</th>
                <th className="px-3 py-2">Estado</th>
                <th className="px-3 py-2">wa_id</th>
                <th className="px-3 py-2">Respuesta</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {(recipients as Record<string, unknown>[]).map((r) => (
                <tr
                  key={String(r.id)}
                  className="transition-colors hover:bg-[#4FAEB2]/[0.04]"
                >
                  <td className="px-3 py-2 tabular-nums">{Number(r.row_number)}</td>
                  <td className="px-3 py-2 font-mono text-[11px]">{String(r.phone_e164)}</td>
                  <td className="px-3 py-2 capitalize text-slate-600">{String(r.status)}</td>
                  <td className="max-w-[140px] truncate px-3 py-2 font-mono text-[10px] text-slate-400">
                    {r.provider_message_id ? String(r.provider_message_id) : "—"}
                  </td>
                  <td className="px-3 py-2 text-slate-600">
                    {r.first_reply_at ? String(r.first_reply_at).slice(0, 19) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm ring-1 ring-[#4FAEB2]/15">
        <button
          type="button"
          className="flex w-full items-center justify-between px-4 py-3 text-left transition-colors hover:bg-[#4FAEB2]/[0.04]"
          onClick={() => setShowEvents((v) => !v)}
        >
          <div className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="inline-block h-1.5 w-1.5 rounded-full bg-[#4FAEB2] shadow-[0_0_0_3px_rgba(79,174,178,0.18)]"
            />
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#4FAEB2]">
              Eventos ({events.length})
            </h2>
          </div>
          <span className="text-[#4FAEB2]">{showEvents ? "▼" : "▶"}</span>
        </button>
        {showEvents ? (
          <ul className="divide-y divide-slate-100 border-t border-slate-100 px-4 py-2 text-xs text-slate-700">
            {events.map((ev) => (
              <li key={ev.id} className="py-2">
                <span className="font-semibold text-slate-900">{ev.event_type}</span>{" "}
                <span className="text-slate-400">· {ev.created_at.slice(0, 19)}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </div>
  );
}
