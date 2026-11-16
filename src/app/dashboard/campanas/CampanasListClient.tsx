"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";
import { FancySelect } from "@/app/dashboard/proyectos/components/FancySelect";
import EdgeScrollArea from "@/components/ui/EdgeScrollArea";
import CampanaNuevoModal from "./components/CampanaNuevoModal";
import CampanaDetalleModal from "./components/CampanaDetalleModal";

type CampaignRow = {
  id: string;
  name: string;
  channel_id: string;
  provider: string;
  template_name: string;
  template_language: string;
  template_category: string | null;
  status: string;
  total_count: number;
  sent_count: number;
  failed_count: number;
  replied_count: number;
  created_at: string;
};

function statusConfig(status: string): { cls: string; dot: string; label: string } {
  const s = (status ?? "").toLowerCase();
  if (s === "completed")
    return {
      cls: "border-emerald-200 bg-emerald-50 text-emerald-700",
      dot: "bg-emerald-500",
      label: "Completada",
    };
  if (s === "sending")
    return {
      cls: "border-[#4FAEB2]/30 bg-[#4FAEB2]/10 text-[#3F8E91]",
      dot: "bg-[#4FAEB2]",
      label: "Enviando",
    };
  if (s === "ready")
    return {
      cls: "border-amber-200 bg-amber-50 text-amber-800",
      dot: "bg-amber-500",
      label: "Lista",
    };
  if (s === "draft")
    return {
      cls: "border-slate-200 bg-slate-50 text-slate-600",
      dot: "bg-slate-400",
      label: "Borrador",
    };
  if (s === "cancelled")
    return {
      cls: "border-red-200 bg-red-50 text-red-700",
      dot: "bg-red-500",
      label: "Cancelada",
    };
  return {
    cls: "border-slate-200 bg-slate-50 text-slate-600",
    dot: "bg-slate-400",
    label: status || "—",
  };
}

function categoryConfig(category: string | null): { cls: string; label: string } {
  const c = (category ?? "").toUpperCase();
  if (c === "MARKETING")
    return { cls: "border-violet-200 bg-violet-50 text-violet-700", label: "Marketing" };
  if (c === "UTILITY")
    return { cls: "border-sky-200 bg-sky-50 text-sky-700", label: "Utilidad" };
  if (c === "AUTHENTICATION")
    return { cls: "border-amber-200 bg-amber-50 text-amber-800", label: "Autenticación" };
  return { cls: "border-slate-200 bg-slate-50 text-slate-500", label: category || "—" };
}

export default function CampanasListClient() {
  const [rows, setRows] = useState<CampaignRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [busqueda, setBusqueda] = useState("");
  const [filtroEstado, setFiltroEstado] = useState<string>("");
  const [filtroProveedor, setFiltroProveedor] = useState<string>("");

  const [nuevoOpen, setNuevoOpen] = useState(false);
  const [detalleId, setDetalleId] = useState<string | null>(null);

  const cargar = async () => {
    setLoading(true);
    const res = await fetchWithSupabaseSession("/api/campanas", { cache: "no-store" });
    const json = (await res.json().catch(() => ({}))) as {
      success?: boolean;
      data?: CampaignRow[];
      error?: string;
    };
    if (!res.ok || !json.success) {
      setErr(json.error ?? "No se pudo cargar");
      setLoading(false);
      return;
    }
    setRows(json.data ?? []);
    setLoading(false);
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await fetchWithSupabaseSession("/api/campanas", { cache: "no-store" });
      const json = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        data?: CampaignRow[];
        error?: string;
      };
      if (cancelled) return;
      if (!res.ok || !json.success) {
        setErr(json.error ?? "No se pudo cargar");
        setLoading(false);
        return;
      }
      setRows(json.data ?? []);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const proveedoresDisponibles = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) {
      if (r.provider) set.add(r.provider);
    }
    return Array.from(set).sort();
  }, [rows]);

  const estadosDisponibles = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) {
      if (r.status) set.add(r.status);
    }
    return Array.from(set).sort();
  }, [rows]);

  const filtrados = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    return rows.filter((r) => {
      if (filtroEstado && r.status !== filtroEstado) return false;
      if (filtroProveedor && r.provider !== filtroProveedor) return false;
      if (!q) return true;
      const t = [r.name, r.template_name, r.template_category, r.provider, r.status]
        .join(" ")
        .toLowerCase();
      return t.includes(q);
    });
  }, [rows, busqueda, filtroEstado, filtroProveedor]);

  const totalEnviados = useMemo(
    () => rows.reduce((s, r) => s + (r.sent_count ?? 0), 0),
    [rows]
  );
  const totalRespondieron = useMemo(
    () => rows.reduce((s, r) => s + (r.replied_count ?? 0), 0),
    [rows]
  );

  const hayFiltros = busqueda || filtroEstado || filtroProveedor;

  if (loading) {
    return (
      <div className="space-y-4 p-6">
        <div className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="inline-block h-1.5 w-1.5 rounded-full bg-[#4FAEB2] shadow-[0_0_0_3px_rgba(79,174,178,0.18)]"
          />
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#4FAEB2]">
            Marketing · Campañas
          </p>
        </div>
        <h1 className="text-lg font-semibold tracking-tight text-slate-900">Campañas WhatsApp</h1>
        <div className="animate-pulse py-16 text-center text-sm text-slate-400">
          Cargando campañas…
        </div>
      </div>
    );
  }

  if (err) {
    return (
      <div className="space-y-4 p-6">
        <h1 className="text-lg font-semibold tracking-tight text-slate-900">Campañas WhatsApp</h1>
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {err}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 p-6">
      {/* Encabezado */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="inline-block h-1.5 w-1.5 rounded-full bg-[#4FAEB2] shadow-[0_0_0_3px_rgba(79,174,178,0.18)]"
            />
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#4FAEB2]">
              Marketing · Campañas
            </p>
          </div>
          <h1 className="mt-0.5 text-lg font-semibold tracking-tight text-slate-900">
            Campañas WhatsApp
          </h1>
          <p className="text-xs text-slate-500">
            Envíos masivos con plantillas aprobadas (Meta / YCloud).
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
        <Link
          href="/dashboard/campanas/audiencias"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-[#4FAEB2]/40 bg-white px-3 py-1.5 text-xs font-semibold text-[#3F8E91] shadow-sm transition-colors hover:bg-[#4FAEB2]/10"
        >
          Audiencias
        </Link>
        <Link
          href="/dashboard/campanas/plantillas"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-[#4FAEB2]/40 bg-white px-3 py-1.5 text-xs font-semibold text-[#3F8E91] shadow-sm transition-colors hover:bg-[#4FAEB2]/10"
        >
          Plantillas de Meta
        </Link>
        <button
          type="button"
          onClick={() => setNuevoOpen(true)}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-[#4FAEB2] px-3 py-1.5 text-xs font-semibold text-white shadow-sm shadow-[#4FAEB2]/25 transition-colors hover:bg-[#3F8E91] active:scale-95"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            className="h-3.5 w-3.5"
            aria-hidden="true"
          >
            <path d="M10.75 4.75a.75.75 0 0 0-1.5 0v4.5h-4.5a.75.75 0 0 0 0 1.5h4.5v4.5a.75.75 0 0 0 1.5 0v-4.5h4.5a.75.75 0 0 0 0-1.5h-4.5v-4.5Z" />
          </svg>
          Nueva campaña
        </button>
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm ring-1 ring-[#4FAEB2]/15">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">
            Total campañas
          </p>
          <p className="mt-1 text-2xl font-bold tabular-nums text-slate-900">{rows.length}</p>
        </div>
        <div className="rounded-2xl border border-emerald-200 bg-white p-4 shadow-sm">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-emerald-600">
            Mensajes enviados
          </p>
          <p className="mt-1 text-2xl font-bold tabular-nums text-emerald-700">
            {totalEnviados.toLocaleString("es-PY")}
          </p>
        </div>
        <div className="rounded-2xl border border-[#4FAEB2]/30 bg-white p-4 shadow-sm ring-1 ring-[#4FAEB2]/10">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#4FAEB2]">
            Respondieron
          </p>
          <p className="mt-1 text-2xl font-bold tabular-nums text-[#3F8E91]">
            {totalRespondieron.toLocaleString("es-PY")}
          </p>
        </div>
      </div>

      {/* Filtros */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white p-2.5 shadow-sm">
        <div className="relative min-w-[200px] flex-1">
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-[#4FAEB2]"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
              fill="currentColor"
              className="h-4 w-4"
            >
              <path
                fillRule="evenodd"
                d="M9 3.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11ZM2 9a7 7 0 1 1 12.452 4.391l3.328 3.329a.75.75 0 1 1-1.06 1.06l-3.329-3.328A7 7 0 0 1 2 9Z"
                clipRule="evenodd"
              />
            </svg>
          </span>
          <input
            type="text"
            placeholder="Buscar por nombre, plantilla, proveedor…"
            value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)}
            className="w-full rounded-lg border border-slate-200 bg-white py-1.5 pl-9 pr-3 text-xs text-slate-900 shadow-sm transition-colors placeholder:text-slate-400 hover:border-[#4FAEB2]/60 focus:border-[#4FAEB2] focus:outline-none focus:ring-2 focus:ring-[#4FAEB2]/20"
          />
        </div>
        <FancySelect
          size="sm"
          className="min-w-[150px] shrink-0"
          ariaLabel="Filtrar por estado"
          placeholder="Todos los estados"
          value={filtroEstado}
          onChange={(v) => setFiltroEstado(v)}
          options={[
            { value: "", label: "Todos los estados" },
            ...estadosDisponibles.map((s) => ({
              value: s,
              label: statusConfig(s).label,
            })),
          ]}
        />
        <FancySelect
          size="sm"
          className="min-w-[150px] shrink-0"
          ariaLabel="Filtrar por proveedor"
          placeholder="Todos los proveedores"
          value={filtroProveedor}
          onChange={(v) => setFiltroProveedor(v)}
          options={[
            { value: "", label: "Todos los proveedores" },
            ...proveedoresDisponibles.map((p) => ({ value: p, label: p })),
          ]}
        />
        {hayFiltros && (
          <button
            onClick={() => {
              setBusqueda("");
              setFiltroEstado("");
              setFiltroProveedor("");
            }}
            className="shrink-0 rounded-lg border border-transparent px-2.5 py-1.5 text-[11px] font-medium text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700"
          >
            Limpiar filtros
          </button>
        )}
      </div>

      <p className="text-xs text-slate-500">
        <span className="font-semibold tabular-nums text-slate-700">{filtrados.length}</span> de{" "}
        <span className="font-semibold tabular-nums text-slate-700">{rows.length}</span> campañas
      </p>

      {/* Tabla */}
      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm ring-1 ring-[#4FAEB2]/15">
        {filtrados.length === 0 ? (
          <div className="py-16 text-center text-sm text-slate-400">
            {rows.length === 0
              ? "No hay campañas todavía."
              : "No se encontraron campañas con los filtros aplicados."}
          </div>
        ) : (
          <EdgeScrollArea>
            <table className="w-full min-w-[900px] text-sm">
              <thead className="border-b border-slate-200 bg-slate-50/70">
                <tr>
                  {[
                    "Nombre",
                    "Proveedor",
                    "Plantilla",
                    "Categoría",
                    "Estado",
                    "Total",
                    "Enviados",
                    "Fallidos",
                    "Respondieron",
                  ].map((h, i) => (
                    <th
                      key={h}
                      className={`whitespace-nowrap px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500 ${
                        i >= 5 ? "text-right" : "text-left"
                      }`}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filtrados.map((r) => {
                  const st = statusConfig(r.status);
                  return (
                    <tr
                      key={r.id}
                      className="group cursor-pointer transition-colors hover:bg-[#4FAEB2]/[0.04]"
                      onClick={() => setDetalleId(r.id)}
                    >
                      <td className="px-3 py-2.5">
                        <p className="font-semibold tracking-tight text-slate-900">{r.name}</p>
                      </td>
                      <td className="px-3 py-2.5">
                        <span className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-slate-50 px-2 py-0.5 font-mono text-[11px] font-medium text-slate-600">
                          {r.provider}
                        </span>
                      </td>
                      <td className="px-3 py-2.5">
                        <span className="font-medium text-slate-700">{r.template_name}</span>{" "}
                        <span className="text-[11px] text-slate-400">
                          ({r.template_language})
                        </span>
                      </td>
                      <td className="px-3 py-2.5">
                        {(() => {
                          const cat = categoryConfig(r.template_category);
                          return (
                            <span
                              className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-semibold ${cat.cls}`}
                            >
                              {cat.label}
                            </span>
                          );
                        })()}
                      </td>
                      <td className="px-3 py-2.5">
                        <span
                          className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${st.cls}`}
                        >
                          <span
                            aria-hidden="true"
                            className={`h-1.5 w-1.5 rounded-full ${st.dot}`}
                          />
                          {st.label}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums font-semibold text-slate-800">
                        {r.total_count}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums font-semibold text-emerald-700">
                        {r.sent_count}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums font-semibold text-red-600">
                        {r.failed_count}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums font-semibold text-[#3F8E91]">
                        {r.replied_count}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </EdgeScrollArea>
        )}
      </div>

      <CampanaNuevoModal
        open={nuevoOpen}
        onClose={() => setNuevoOpen(false)}
        onCreated={(id) => {
          setNuevoOpen(false);
          void cargar();
          setDetalleId(id);
        }}
      />
      <CampanaDetalleModal
        id={detalleId}
        open={detalleId !== null}
        onClose={() => {
          setDetalleId(null);
          void cargar();
        }}
      />
    </div>
  );
}
