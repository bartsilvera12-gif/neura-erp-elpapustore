"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { getSorteos } from "@/lib/sorteos/actions";
import type { SorteosVentasKpis } from "@/lib/sorteos/ventas-kpis";
import type { Sorteo } from "@/lib/sorteos/types";

function formatGs(n: number) {
  const s = Math.round(n).toLocaleString("es-PY", { maximumFractionDigits: 0 });
  return `Gs. ${s}`;
}

function formatFecha(iso: string | null) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("es-PY", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

type EstadoMeta = { label: string; chip: string; dot: string };
const ESTADO_META: Record<string, EstadoMeta> = {
  activo: {
    label: "Activo",
    chip: "border-emerald-200 bg-emerald-50 text-emerald-700",
    dot: "bg-emerald-500",
  },
  pausado: {
    label: "Pausado",
    chip: "border-amber-200 bg-amber-50 text-amber-700",
    dot: "bg-amber-500",
  },
  cerrado: {
    label: "Cerrado",
    chip: "border-slate-200 bg-slate-50 text-slate-600",
    dot: "bg-slate-400",
  },
  finalizado: {
    label: "Finalizado",
    chip: "border-[#4FAEB2]/30 bg-[#4FAEB2]/10 text-[#3F8E91]",
    dot: "bg-[#4FAEB2]",
  },
};

function estadoMeta(value: string): EstadoMeta {
  return (
    ESTADO_META[value] ?? {
      label: value,
      chip: "border-slate-200 bg-slate-50 text-slate-600",
      dot: "bg-slate-400",
    }
  );
}

// ── Iconos ────────────────────────────────────────────────────────────────────

type IconProps = { className?: string };

const IconTicket = ({ className = "h-4 w-4" }: IconProps) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
    <path d="M3 7v2a2 2 0 0 1 0 4v2a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-2a2 2 0 0 1 0-4V7a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2z" />
    <line x1="13" y1="5" x2="13" y2="7" />
    <line x1="13" y1="11" x2="13" y2="13" />
    <line x1="13" y1="17" x2="13" y2="19" />
  </svg>
);

const IconCoins = ({ className = "h-4 w-4" }: IconProps) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
    <line x1="12" y1="1" x2="12" y2="23" />
    <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
  </svg>
);

const IconWallet = ({ className = "h-4 w-4" }: IconProps) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
    <path d="M20 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2z" />
    <path d="M16 14h.01" />
    <path d="M20 7V5a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v2" />
  </svg>
);

const IconTrophy = ({ className = "h-4 w-4" }: IconProps) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
    <path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6" />
    <path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18" />
    <path d="M4 22h16" />
    <path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22" />
    <path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22" />
    <path d="M18 2H6v7a6 6 0 0 0 12 0V2Z" />
  </svg>
);

const IconPlus = ({ className = "h-4 w-4" }: IconProps) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
    <path d="M12 5v14M5 12h14" />
  </svg>
);

// ── KPI card ──────────────────────────────────────────────────────────────────

type KpiAccent = "neutral" | "featured";

function KpiCard({
  label,
  value,
  sub,
  icon,
  accent = "neutral",
}: {
  label: string;
  value: string;
  sub?: string;
  icon: React.ReactNode;
  accent?: KpiAccent;
}) {
  const chipCls =
    accent === "featured"
      ? "border-[#4FAEB2]/30 bg-[#4FAEB2]/12 text-[#4FAEB2]"
      : "border-slate-200 bg-slate-50 text-slate-500";

  const cardCls =
    accent === "featured"
      ? "relative overflow-hidden rounded-2xl border border-[#4FAEB2]/55 bg-gradient-to-br from-white via-white to-[#4FAEB2]/8 p-4 shadow-[0_4px_18px_rgba(79,174,178,0.08)]"
      : "relative overflow-hidden rounded-2xl border border-[#4FAEB2]/45 bg-white p-4 shadow-[0_1px_2px_rgba(15,23,42,0.04)]";

  return (
    <div className={cardCls}>
      {accent === "featured" ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-[3px] bg-gradient-to-r from-[#4FAEB2] via-[#4FAEB2]/70 to-[#4FAEB2]/30"
        />
      ) : null}
      <div className="flex items-start justify-between gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">
          {label}
        </p>
        <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border ${chipCls}`}>
          {icon}
        </span>
      </div>
      <p
        className={`mt-2 text-2xl font-semibold tabular-nums tracking-tight ${
          accent === "featured" ? "text-[#3F8E91]" : "text-slate-900"
        }`}
      >
        {value}
      </p>
      {sub ? <p className="mt-1 text-[11px] text-slate-500">{sub}</p> : null}
    </div>
  );
}

// ── Tabs ──────────────────────────────────────────────────────────────────────

function NavTabs() {
  return (
    <div className="flex w-full flex-wrap gap-1 rounded-2xl border border-[#4FAEB2]/45 bg-white p-1.5 shadow-sm sm:w-fit">
      <span className="rounded-xl bg-[#4FAEB2] px-4 py-2 text-sm font-semibold text-white shadow-md shadow-[#4FAEB2]/30">
        Sorteos
      </span>
      <Link
        href="/sorteos/entradas"
        className="rounded-xl px-4 py-2 text-sm font-semibold text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700"
      >
        Entradas
      </Link>
      <Link
        href="/sorteos/cupones"
        className="rounded-xl px-4 py-2 text-sm font-semibold text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700"
      >
        Cupones
      </Link>
      <Link
        href="/sorteos/tickets"
        className="rounded-xl px-4 py-2 text-sm font-semibold text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700"
      >
        Tickets
      </Link>
      <Link
        href="/sorteos/ranking"
        className="rounded-xl px-4 py-2 text-sm font-semibold text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700"
      >
        Ranking
      </Link>
    </div>
  );
}

// ── Componente principal ──────────────────────────────────────────────────────

export default function SorteosListClient({ ventasKpis }: { ventasKpis: SorteosVentasKpis }) {
  const [rows, setRows] = useState<Sorteo[]>([]);
  const [cargando, setCargando] = useState(true);
  const [finalizandoId, setFinalizandoId] = useState<string | null>(null);

  useEffect(() => {
    getSorteos()
      .then(setRows)
      .catch(() => setRows([]))
      .finally(() => setCargando(false));
  }, []);

  async function finalizarSorteo(id: string) {
    if (
      !window.confirm(
        "¿Seguro que querés finalizar este sorteo? No se borrarán entradas, cupones ni tickets."
      )
    ) {
      return;
    }
    setFinalizandoId(id);
    try {
      const res = await fetch(`/api/sorteos/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ estado: "finalizado" }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        window.alert(`No se pudo finalizar el sorteo${j?.error ? `: ${j.error}` : "."}`);
        return;
      }
      setRows((prev) => prev.map((r) => (r.id === id ? { ...r, estado: "finalizado" } : r)));
    } catch {
      window.alert("No se pudo finalizar el sorteo (error de red).");
    } finally {
      setFinalizandoId(null);
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="inline-block h-2 w-2 shrink-0 rounded-full bg-[#4FAEB2] shadow-[0_0_0_3px_rgba(79,174,178,0.18)]"
            />
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#4FAEB2]">
              Sorteos
            </p>
          </div>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">Sorteos</h1>
          <p className="mt-1 text-sm text-slate-500">Gestión de sorteos y boletos</p>
        </div>
        <Link
          href="/sorteos/nuevo"
          className="inline-flex shrink-0 items-center gap-1.5 self-start rounded-xl bg-[#4FAEB2] px-4 py-2.5 text-sm font-semibold text-white shadow-sm shadow-[#4FAEB2]/25 transition-colors hover:bg-[#3F8E91]"
        >
          <IconPlus />
          Nuevo sorteo
        </Link>
      </div>

      <NavTabs />

      {/* KPIs */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="Boletos hoy"
          value={ventasKpis.boletosHoy.toLocaleString("es-PY")}
          sub="Vendidos hoy"
          icon={<IconTicket />}
        />
        <KpiCard
          label="Boletos del sorteo"
          value={ventasKpis.boletosSorteo.toLocaleString("es-PY")}
          sub={ventasKpis.sorteoNombre ? `${ventasKpis.sorteoNombre} · desde el inicio` : "Desde el inicio del sorteo"}
          icon={<IconTrophy />}
        />
        <KpiCard
          label="Monto hoy"
          value={formatGs(ventasKpis.montoHoy)}
          sub="Ingresos de hoy"
          icon={<IconWallet />}
        />
        <KpiCard
          label="Monto del sorteo"
          value={formatGs(ventasKpis.montoSorteo)}
          sub={ventasKpis.sorteoNombre ? `${ventasKpis.sorteoNombre} · desde el inicio` : "Ingresos desde el inicio del sorteo"}
          icon={<IconCoins />}
          accent="featured"
        />
      </div>

      {/* Tabla */}
      <div className="overflow-hidden rounded-2xl border border-[#4FAEB2]/45 bg-white shadow-sm">
        <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-5 py-3">
          <div className="flex items-center gap-2">
            <span aria-hidden="true" className="block h-5 w-1 rounded-full bg-[#4FAEB2]" />
            <h2 className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-600">
              <span aria-hidden="true" className="inline-block h-1.5 w-1.5 rounded-full bg-[#4FAEB2]" />
              Sorteos
            </h2>
          </div>
          <span className="inline-flex items-center gap-1 rounded-full border border-[#4FAEB2]/30 bg-[#4FAEB2]/10 px-2.5 py-0.5 text-[11px] font-semibold text-[#3F8E91]">
            {rows.length}
          </span>
        </div>

        {cargando ? (
          <div className="flex items-center justify-center gap-3 py-16 text-sm text-slate-500">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-[#4FAEB2]" />
            Cargando sorteos…
          </div>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <span className="flex h-14 w-14 items-center justify-center rounded-2xl border border-[#4FAEB2]/25 bg-[#4FAEB2]/8 text-[#4FAEB2]">
              <IconTicket className="h-6 w-6" />
            </span>
            <p className="text-sm font-medium text-slate-700">No hay sorteos</p>
            <Link
              href="/sorteos/nuevo"
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#4FAEB2] hover:text-[#3F8E91] hover:underline"
            >
              Crear el primero →
            </Link>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50/80 text-left text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-500">
                <tr>
                  <th className="px-5 py-3">Nombre</th>
                  <th className="px-5 py-3">Estado</th>
                  <th className="px-5 py-3">Fecha sorteo</th>
                  <th className="px-5 py-3 text-right">Precio / boleto</th>
                  <th className="px-5 py-3 text-right">Máx.</th>
                  <th className="px-5 py-3 text-right">Vendidos</th>
                  <th className="px-5 py-3 text-right">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((s) => {
                  const meta = estadoMeta(s.estado);
                  return (
                    <tr key={s.id} className="transition-colors hover:bg-[#4FAEB2]/5">
                      <td className="px-5 py-3 text-sm font-semibold text-slate-900">{s.nombre}</td>
                      <td className="px-5 py-3">
                        <span
                          className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${meta.chip}`}
                        >
                          <span aria-hidden="true" className={`h-1 w-1 rounded-full ${meta.dot}`} />
                          {meta.label}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-sm text-slate-600">{formatFecha(s.fecha_sorteo)}</td>
                      <td className="px-5 py-3 text-right text-sm font-semibold tabular-nums text-slate-900">
                        {formatGs(s.precio_por_boleto)}
                      </td>
                      <td className="px-5 py-3 text-right text-sm tabular-nums text-slate-700">{s.max_boletos}</td>
                      <td className="px-5 py-3 text-right text-sm tabular-nums text-slate-700">
                        {s.total_boletos_vendidos}
                      </td>
                      <td className="px-5 py-3 text-right">
                        <div className="inline-flex items-center justify-end gap-2">
                          {/* Finalizar: tenant-only El Papu Store. Otros clientes no se tocan. */}
                          {s.estado === "activo" &&
                          process.env.NEXT_PUBLIC_NEURA_CLIENT_SCHEMA === "elpapustore_erp" ? (
                            <button
                              type="button"
                              onClick={() => finalizarSorteo(s.id)}
                              disabled={finalizandoId === s.id}
                              className="inline-flex items-center rounded-xl border border-rose-200 bg-white px-3 py-1.5 text-xs font-semibold text-rose-600 shadow-sm transition-colors hover:border-rose-400 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              {finalizandoId === s.id ? "Finalizando…" : "Finalizar"}
                            </button>
                          ) : null}
                          <Link
                            href={`/sorteos/${s.id}/editar`}
                            className="inline-flex items-center rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 shadow-sm transition-colors hover:border-[#4FAEB2]/60 hover:bg-[#4FAEB2]/5 hover:text-[#3F8E91]"
                          >
                            Editar
                          </Link>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
