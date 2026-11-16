"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "@/lib/api/fetch-with-supabase-session";

type Kind =
  | "interactuaron"
  | "no_compraron"
  | "compraron"
  | "comprobante_pendiente"
  | "tocaron_boton"
  | "respondieron_campana"
  | "compraron_otro_sorteo"
  | "abandonaron";
type Period = "hoy" | "ayer" | "ultimos_7" | "ultimos_30" | "sorteo_actual" | "todo" | "personalizado";
type Sorteo = { id: string; nombre: string; estado: string; created_at: string };
type Campaign = { id: string; name: string; status: string; created_at: string };
type Row = { telefono: string; nombre: string; ultimo: string | null; detalle: string | null };

const KINDS: Array<{ k: Kind; title: string; desc: string; icon: string }> = [
  { k: "no_compraron", title: "Escribieron y no compraron", desc: "Hablaron con el bot y no tienen compra", icon: "🛒" },
  { k: "interactuaron", title: "Escribieron al bot", desc: "Cualquiera que mandó un mensaje", icon: "💬" },
  { k: "compraron", title: "Compraron", desc: "Con compra confirmada", icon: "✅" },
  { k: "comprobante_pendiente", title: "Comprobante pendiente", desc: "Pagaron y falta aprobar", icon: "⏳" },
  { k: "tocaron_boton", title: "Tocaron el botón de una campaña", desc: "Ej: Escuchar audio", icon: "👆" },
  { k: "respondieron_campana", title: "Respondieron una campaña", desc: "Contestaron un envío masivo", icon: "↩️" },
  { k: "compraron_otro_sorteo", title: "Compraron en otro sorteo y no en este", desc: "Ej: compraron el anterior y todavía no el actual", icon: "🔁" },
  { k: "abandonaron", title: "Eligieron un combo y no compraron", desc: "Quedaron a mitad de la compra", icon: "🧺" },
];

const PERIODS: Array<{ p: Period; label: string }> = [
  { p: "hoy", label: "Hoy" },
  { p: "ayer", label: "Ayer" },
  { p: "ultimos_7", label: "Últimos 7 días" },
  { p: "ultimos_30", label: "Últimos 30 días" },
  { p: "sorteo_actual", label: "Sorteo actual" },
  { p: "todo", label: "Todo" },
  { p: "personalizado", label: "Elegir fechas" },
];

const usesSorteo = (k: Kind) =>
  k === "no_compraron" || k === "compraron" || k === "comprobante_pendiente" || k === "abandonaron";
const usesBoletas = (k: Kind) => k === "compraron" || k === "comprobante_pendiente" || k === "compraron_otro_sorteo";
const usesPendientesToggle = (k: Kind) => k === "no_compraron" || k === "abandonaron" || k === "compraron_otro_sorteo";
/** Este tipo mira sorteos completos: el período no se usa. */
const usesPeriod = (k: Kind) => k !== "compraron_otro_sorteo";
const usesCampaign = (k: Kind) => k === "tocaron_boton" || k === "respondieron_campana";
/** Períodos por días: se les puede poner hora de inicio y de fin. */
const periodConHora = (p: Period) =>
  p === "hoy" || p === "ayer" || p === "ultimos_7" || p === "ultimos_30" || p === "personalizado";

const inputCls =
  "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 focus:border-[#4FAEB2] focus:outline-none focus:ring-2 focus:ring-[#4FAEB2]/20";

function fmtFecha(s: string | null): string {
  return s || "—";
}

const HORAS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0"));
const MINUTOS = Array.from({ length: 12 }, (_, i) => String(i * 5).padStart(2, "0")).concat("59");

/**
 * Hora como dos desplegables (hora y minutos). El `<input type="time">` del navegador se completaba
 * con los minutos de la hora actual al elegir solo la hora (ej. 10 → 10:15) sin que se notara.
 * `value` es "HH:MM" o "" (sin hora).
 */
function HoraSelect({
  label,
  value,
  minutoDefecto,
  onChange,
}: {
  label: string;
  value: string;
  minutoDefecto: string;
  onChange: (v: string) => void;
}) {
  const [h, m] = value ? value.split(":") : ["", minutoDefecto];
  const sel =
    "rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm text-slate-800 focus:border-[#4FAEB2] focus:outline-none focus:ring-2 focus:ring-[#4FAEB2]/20";
  return (
    <label className="space-y-1">
      <span className="block text-[11px] text-slate-500">{label}</span>
      <span className="flex items-center gap-1">
        <select className={sel} value={h} onChange={(e) => onChange(e.target.value ? `${e.target.value}:${m}` : "")}>
          <option value="">--</option>
          {HORAS.map((x) => (
            <option key={x} value={x}>
              {x}
            </option>
          ))}
        </select>
        <span className="text-sm text-slate-500">:</span>
        <select
          className={sel}
          value={m}
          disabled={!h}
          onChange={(e) => onChange(h ? `${h}:${e.target.value}` : "")}
        >
          {MINUTOS.map((x) => (
            <option key={x} value={x}>
              {x}
            </option>
          ))}
        </select>
      </span>
    </label>
  );
}

/** Selección múltiple de sorteos como fichas (tocar = sumar/sacar). */
function SorteoChips({
  sorteos,
  value,
  onChange,
}: {
  sorteos: Sorteo[];
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {sorteos.map((s) => {
        const on = value.includes(s.id);
        return (
          <button
            key={s.id}
            type="button"
            onClick={() => onChange(on ? value.filter((x) => x !== s.id) : [...value, s.id])}
            className={`rounded-full border px-3 py-1.5 text-xs font-semibold ${
              on ? "border-[#4FAEB2] bg-[#4FAEB2] text-white" : "border-slate-300 bg-white text-slate-700 hover:border-[#4FAEB2]"
            }`}
          >
            {on ? "✓ " : ""}
            {s.nombre} {s.estado === "activo" ? "(activo)" : `(${s.estado})`}
          </button>
        );
      })}
    </div>
  );
}

export default function AudienciasClient() {
  const [sorteos, setSorteos] = useState<Sorteo[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);

  const [kinds, setKinds] = useState<Kind[]>(["no_compraron"]);
  const [period, setPeriod] = useState<Period>("sorteo_actual");
  const [desde, setDesde] = useState("");
  const [hasta, setHasta] = useState("");
  const [horaDesde, setHoraDesde] = useState("");
  const [horaHasta, setHoraHasta] = useState("");
  const [sorteoIds, setSorteoIds] = useState<string[]>([]);
  const [campaignId, setCampaignId] = useState("");
  const [excluirPendientes, setExcluirPendientes] = useState(true);
  const [excluir, setExcluir] = useState("");
  const [agregar, setAgregar] = useState("");
  const [sorteoAnteriorIds, setSorteoAnteriorIds] = useState<string[]>([]);
  const [boletasMin, setBoletasMin] = useState("");
  const [boletasMax, setBoletasMax] = useState("");
  const [excluirHoras, setExcluirHoras] = useState("");

  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<{ total: number; rows: Row[] } | null>(null);
  const [exporting, setExporting] = useState(false);
  const [targetCampaign, setTargetCampaign] = useState("");
  const [loadingInto, setLoadingInto] = useState(false);
  const [okMsg, setOkMsg] = useState<{ text: string; campaignId?: string } | null>(null);

  useEffect(() => {
    void (async () => {
      const r = await apiFetch("/api/campanas/audiencias");
      const j = await r.json().catch(() => ({}));
      if (!j.success) return setErr(j.error ?? "No se pudieron cargar los sorteos y campañas");
      setSorteos(j.data.sorteos ?? []);
      setCampaigns(j.data.campaigns ?? []);
      const activo = (j.data.sorteos ?? []).find((s: Sorteo) => s.estado === "activo") ?? j.data.sorteos?.[0];
      if (activo) setSorteoIds([activo.id]);
      const anterior = (j.data.sorteos ?? []).find((s: Sorteo) => s.id !== activo?.id);
      if (anterior) setSorteoAnteriorIds([anterior.id]);
      if (j.data.campaigns?.[0]) setCampaignId(j.data.campaigns[0].id);
    })();
  }, []);

  const algun = (fn: (k: Kind) => boolean) => kinds.some(fn);
  const conOtroSorteo = kinds.includes("compraron_otro_sorteo");
  const conPeriodo = algun(usesPeriod);
  const conSorteo = algun(usesSorteo) || (conPeriodo && period === "sorteo_actual");

  function toggleKind(k: Kind) {
    setKinds((prev) => (prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]));
  }

  const filters = useMemo(
    () => ({
      kinds,
      period,
      desde: period === "personalizado" ? desde : null,
      hasta: period === "personalizado" ? hasta : null,
      hora_desde: periodConHora(period) ? horaDesde : "",
      hora_hasta: periodConHora(period) ? horaHasta : "",
      sorteo_ids:
        kinds.some(usesSorteo) || kinds.includes("compraron_otro_sorteo") || period === "sorteo_actual"
          ? sorteoIds
          : [],
      sorteo_anterior_ids: kinds.includes("compraron_otro_sorteo") ? sorteoAnteriorIds : [],
      campaign_id: kinds.some(usesCampaign) ? campaignId : null,
      excluir_pendientes: excluirPendientes,
      excluir_telefonos: excluir,
      agregar_telefonos: agregar,
      boletas_min: kinds.some(usesBoletas) ? boletasMin.trim() : "",
      boletas_max: kinds.some(usesBoletas) ? boletasMax.trim() : "",
      excluir_campana_horas: excluirHoras.trim(),
    }),
    [
      kinds,
      period,
      desde,
      hasta,
      horaDesde,
      horaHasta,
      sorteoIds,
      sorteoAnteriorIds,
      campaignId,
      excluirPendientes,
      excluir,
      agregar,
      boletasMin,
      boletasMax,
      excluirHoras,
    ]
  );

  useEffect(() => {
    setResult(null);
    setOkMsg(null);
  }, [filters]);

  async function calcular() {
    setLoading(true);
    setErr(null);
    setOkMsg(null);
    try {
      const r = await apiFetch("/api/campanas/audiencias", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(filters),
      });
      const j = await r.json();
      if (!j.success) throw new Error(j.error ?? "No se pudo calcular");
      setResult(j.data);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Error");
    } finally {
      setLoading(false);
    }
  }

  async function fetchExcel(): Promise<Blob> {
    const r = await apiFetch("/api/campanas/audiencias/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(filters),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error ?? "No se pudo generar el Excel");
    }
    return r.blob();
  }

  async function descargar() {
    setExporting(true);
    setErr(null);
    try {
      const blob = await fetchExcel();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `audiencia_${kinds.join("+")}_${new Date().toISOString().slice(0, 10)}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Error");
    } finally {
      setExporting(false);
    }
  }

  async function cargarEnCampana() {
    if (!targetCampaign) return;
    setLoadingInto(true);
    setErr(null);
    setOkMsg(null);
    try {
      const blob = await fetchExcel();
      const fd = new FormData();
      fd.append("file", new File([blob], `audiencia_${kinds.join("+")}.xlsx`, { type: blob.type }));
      fd.append("phone_column", "telefono");
      const r = await apiFetch(`/api/campanas/${targetCampaign}/import`, { method: "POST", body: fd });
      const j = await r.json();
      if (!j.success) throw new Error(j.error ?? "La campaña no aceptó la lista");
      const valid = j.data?.valid_count ?? j.data?.valid ?? result?.total;
      setOkMsg({
        text: `Cargados ${Number(valid ?? 0).toLocaleString("es-PY")} destinatarios en la campaña. Entrá, validá y enviá.`,
        campaignId: targetCampaign,
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Error");
    } finally {
      setLoadingInto(false);
    }
  }

  const editableCampaigns = campaigns.filter((c) => c.status === "draft" || c.status === "ready");

  return (
    <div className="mx-auto max-w-6xl space-y-5 p-4 sm:p-6">
      <div>
        <Link href="/dashboard/campanas" className="text-xs font-medium text-[#3F8E91] hover:underline">
          ← Campañas
        </Link>
        <h1 className="mt-1 text-lg font-bold text-slate-900">Audiencias</h1>
        <p className="text-xs text-slate-500">
          Armá listas de números según lo que hicieron (escribieron, compraron, no compraron…) y usalas en una campaña sin armar el Excel a mano.
        </p>
      </div>

      <section className="space-y-5 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="space-y-2">
          <p className="text-xs font-semibold text-slate-600">1. ¿A quiénes?</p>
          <p className="text-[11px] text-slate-500">
            Podés marcar varios: la lista es la suma de todos, sin repetir personas. Ej: Compraron + Comprobante pendiente.
          </p>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {KINDS.map((o) => {
              const on = kinds.includes(o.k);
              return (
                <button
                  key={o.k}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggleKind(o.k)}
                  className={`flex items-start gap-3 rounded-xl border-2 p-3 text-left transition-colors ${
                    on ? "border-[#4FAEB2] bg-[#4FAEB2]/10" : "border-slate-200 hover:border-[#4FAEB2]/60"
                  }`}
                >
                  <span className="text-xl leading-none">{o.icon}</span>
                  <span className="flex-1">
                    <span className="block text-sm font-semibold text-slate-800">{o.title}</span>
                    <span className="block text-[11px] text-slate-500">{o.desc}</span>
                  </span>
                  <span
                    className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px] font-bold ${
                      on ? "border-[#4FAEB2] bg-[#4FAEB2] text-white" : "border-slate-300 bg-white"
                    }`}
                  >
                    {on ? "✓" : ""}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {conPeriodo && (
          <div className="space-y-2">
            <p className="text-xs font-semibold text-slate-600">2. ¿Cuándo?</p>
            <div className="flex flex-wrap gap-2">
              {PERIODS.map((o) => (
                <button
                  key={o.p}
                  type="button"
                  onClick={() => setPeriod(o.p)}
                  className={`rounded-full border px-3 py-1.5 text-xs font-semibold ${
                    period === o.p ? "border-[#4FAEB2] bg-[#4FAEB2] text-white" : "border-slate-300 bg-white text-slate-700 hover:border-[#4FAEB2]"
                  }`}
                >
                  {o.label}
                </button>
              ))}
            </div>
            {period === "personalizado" && (
              <div className="grid max-w-md grid-cols-2 gap-2">
                <label className="space-y-1">
                  <span className="text-[11px] text-slate-500">Desde</span>
                  <input type="date" className={inputCls} value={desde} onChange={(e) => setDesde(e.target.value)} />
                </label>
                <label className="space-y-1">
                  <span className="text-[11px] text-slate-500">Hasta</span>
                  <input type="date" className={inputCls} value={hasta} onChange={(e) => setHasta(e.target.value)} />
                </label>
              </div>
            )}
            {periodConHora(period) && (
              <div className="space-y-1">
                <div className="flex max-w-md flex-wrap items-end gap-2">
                  <HoraSelect label="Desde la hora (opcional)" value={horaDesde} minutoDefecto="00" onChange={setHoraDesde} />
                  <HoraSelect label="Hasta la hora (opcional)" value={horaHasta} minutoDefecto="59" onChange={setHoraHasta} />
                  {(horaDesde || horaHasta) && (
                    <button
                      type="button"
                      onClick={() => {
                        setHoraDesde("");
                        setHoraHasta("");
                      }}
                      className="pb-2 text-xs font-semibold text-[#3F8E91] hover:underline"
                    >
                      Quitar horas
                    </button>
                  )}
                </div>
                <p className="text-[11px] text-slate-500">
                  Ej: Ayer de 18:00 a 23:59. La hora de fin incluye ese minuto. Con varios días, la hora de inicio vale para el primer día y la de fin
                  para el último. Vacío = el día completo.
                </p>
              </div>
            )}
            <p className="text-[11px] text-slate-500">
              El período es cuándo hicieron lo elegido: escribir, comprar, mandar el comprobante, elegir el combo o tocar el
              botón. En &quot;no compraron&quot; la compra se mira en los sorteos elegidos. Horario de Paraguay.
            </p>
          </div>
        )}

        {conOtroSorteo && (
          <div className="space-y-3">
            <p className="text-xs font-semibold text-slate-600">
              {conPeriodo ? "3." : "2."} Compraron en otro sorteo y no en este
            </p>
            <div className="space-y-1">
              <span className="text-xs font-semibold text-slate-600">Compraron en (uno o varios)</span>
              <SorteoChips sorteos={sorteos} value={sorteoAnteriorIds} onChange={setSorteoAnteriorIds} />
            </div>
            <div className="space-y-1">
              <span className="text-xs font-semibold text-slate-600">Y todavía no compraron en (uno o varios)</span>
              <SorteoChips sorteos={sorteos} value={sorteoIds} onChange={setSorteoIds} />
            </div>
            <p className="text-[11px] text-slate-500">Se miran los sorteos completos, sin importar la fecha.</p>
          </div>
        )}

        {conSorteo && !conOtroSorteo && (
          <div className="space-y-1">
            <span className="text-xs font-semibold text-slate-600">Sorteos (uno o varios)</span>
            <SorteoChips sorteos={sorteos} value={sorteoIds} onChange={setSorteoIds} />
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          {algun(usesCampaign) && (
            <label className="space-y-1">
              <span className="text-xs font-semibold text-slate-600">Campaña</span>
              <select className={inputCls} value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
                {campaigns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {algun(usesPendientesToggle) && (
            <label className="flex items-center gap-2 self-end pb-2 text-xs text-slate-700">
              <input type="checkbox" checked={excluirPendientes} onChange={(e) => setExcluirPendientes(e.target.checked)} />
              No incluir a los que mandaron comprobante (ya pagaron)
            </label>
          )}
          {algun(usesBoletas) && (
            <div className="space-y-1">
              <span className="text-xs font-semibold text-slate-600">Boletas compradas (opcional)</span>
              <div className="grid grid-cols-2 gap-2">
                <input
                  type="number"
                  min={1}
                  inputMode="numeric"
                  className={inputCls}
                  placeholder="Mínimo"
                  value={boletasMin}
                  onChange={(e) => setBoletasMin(e.target.value)}
                />
                <input
                  type="number"
                  min={1}
                  inputMode="numeric"
                  className={inputCls}
                  placeholder="Máximo"
                  value={boletasMax}
                  onChange={(e) => setBoletasMax(e.target.value)}
                />
              </div>
              <span className="block text-[11px] text-slate-500">
                Suma de todas sus compras. Ej: mínimo 50 para los que compran mucho, máximo 1 para los que compraron una sola.
              </span>
            </div>
          )}
        </div>

        <label className="block max-w-md space-y-1">
          <span className="text-xs font-semibold text-slate-600">No incluir a quienes recibieron una campaña en las últimas… (opcional)</span>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={1}
              max={720}
              inputMode="numeric"
              className={`${inputCls} w-28`}
              placeholder="Ej: 24"
              value={excluirHoras}
              onChange={(e) => setExcluirHoras(e.target.value)}
            />
            <span className="text-xs text-slate-600">horas</span>
          </div>
          <span className="block text-[11px] text-slate-500">Para no mandarle dos campañas seguidas a la misma persona. Vacío = no se saca a nadie.</span>
        </label>

        <label className="block space-y-1">
          <span className="text-xs font-semibold text-slate-600">Agregar números a mano (opcional)</span>
          <textarea
            className={`${inputCls} min-h-[56px]`}
            value={agregar}
            placeholder="Se suman a la lista (por ejemplo tu número para recibir la prueba). Separados por coma o renglón. Ej: 0981772872, 0971977833"
            onChange={(e) => setAgregar(e.target.value)}
          />
          <span className="text-[11px] text-slate-500">Entran siempre, aunque no cumplan los filtros, y salen primeros en la lista.</span>
        </label>

        <label className="block space-y-1">
          <span className="text-xs font-semibold text-slate-600">Excluir números (opcional)</span>
          <textarea
            className={`${inputCls} min-h-[56px]`}
            value={excluir}
            placeholder="Números internos o de prueba, separados por coma o renglón. Ej: 0981260483, 0983111000"
            onChange={(e) => setExcluir(e.target.value)}
          />
        </label>

        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => void calcular()}
            disabled={loading}
            className="rounded-lg bg-[#4FAEB2] px-5 py-2 text-sm font-semibold text-white shadow-sm hover:bg-[#3F8E91] disabled:opacity-50"
          >
            {loading ? "Calculando…" : "Calcular audiencia"}
          </button>
        </div>
      </section>

      {err && <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{err}</p>}
      {okMsg && (
        <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {okMsg.text}{" "}
          {okMsg.campaignId && (
            <Link href={`/dashboard/campanas/${okMsg.campaignId}`} className="font-semibold underline">
              Ir a la campaña
            </Link>
          )}
        </p>
      )}

      {result && (
        <section className="space-y-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Personas en la audiencia</p>
              <p className="text-3xl font-bold tabular-nums text-slate-900">{result.total.toLocaleString("es-PY")}</p>
              {result.total > 15000 && (
                <p className="text-[11px] text-amber-700">Una campaña admite hasta 15.000: se usan los 15.000 más recientes.</p>
              )}
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <button
                type="button"
                onClick={() => void descargar()}
                disabled={exporting || result.total === 0}
                className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                {exporting ? "Generando…" : "Descargar Excel"}
              </button>
              <div className="flex items-end gap-2">
                <label className="space-y-1">
                  <span className="text-[11px] text-slate-500">Cargar en campaña (borrador o lista)</span>
                  <select className={inputCls} value={targetCampaign} onChange={(e) => setTargetCampaign(e.target.value)}>
                    <option value="">Elegí la campaña…</option>
                    {editableCampaigns.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  onClick={() => void cargarEnCampana()}
                  disabled={loadingInto || !targetCampaign || result.total === 0}
                  className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                >
                  {loadingInto ? "Cargando…" : "Cargar"}
                </button>
              </div>
            </div>
          </div>
          {editableCampaigns.length === 0 && (
            <p className="text-[11px] text-slate-500">
              No hay campañas en borrador. Creá una en Campañas → Nueva campaña y volvé para cargarle esta lista.
            </p>
          )}
          <p className="text-[11px] text-slate-500">
            Cargar en una campaña reemplaza los destinatarios que tenga. Vista previa de los primeros {Math.min(50, result.rows.length)}:
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2">Teléfono</th>
                  <th className="px-3 py-2">Nombre</th>
                  <th className="px-3 py-2">Última actividad</th>
                  <th className="px-3 py-2">Detalle</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((r) => (
                  <tr key={r.telefono} className="border-t border-slate-100">
                    <td className="px-3 py-1.5 font-mono text-xs">{r.telefono}</td>
                    <td className="px-3 py-1.5 text-xs">{r.nombre || "—"}</td>
                    <td className="px-3 py-1.5 text-xs text-slate-600">{fmtFecha(r.ultimo)}</td>
                    <td className="px-3 py-1.5 text-xs text-slate-600">{r.detalle ?? ""}</td>
                  </tr>
                ))}
                {result.rows.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-3 py-6 text-center text-sm text-slate-500">
                      Nadie cumple esos filtros.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
