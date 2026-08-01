import Link from "next/link";
import {
  fetchSorteoCuponesOrdenesServer,
  fetchSorteosListServer,
  pickDefaultSorteoId,
  type SorteoEntradasListParams,
} from "@/lib/sorteos/server-queries";
import type { SorteoEntradaEstadoPago } from "@/lib/sorteos/types";
import SorteoCuponesEstadoPagoFilter from "@/components/sorteos/SorteoCuponesEstadoPagoFilter";
import SorteoCuponesBatchPrintClient from "@/components/sorteos/SorteoCuponesBatchPrintClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Sp = Record<string, string | string[] | undefined>;

function pickStr(sp: Sp, key: string): string | undefined {
  const v = sp[key];
  if (typeof v === "string") return v;
  if (Array.isArray(v) && v[0]) return v[0];
  return undefined;
}

function buildQuery(
  sp: Sp,
  patch: Record<string, string | null | undefined>
): string {
  const p = new URLSearchParams();
  const base: Record<string, string | undefined> = {
    page: pickStr(sp, "page"),
    q: pickStr(sp, "q"),
    sorteo_id: pickStr(sp, "sorteo_id"),
    estado: pickStr(sp, "estado"),
  };
  for (const [k, v] of Object.entries({ ...base, ...patch })) {
    if (v && v.length > 0) p.set(k, v);
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}

export default async function SorteoCuponesPage({
  searchParams,
}: {
  searchParams?: Sp | Promise<Sp>;
}) {
  const sp = await Promise.resolve(searchParams ?? {});
  const page = Math.max(1, parseInt(pickStr(sp, "page") ?? "1", 10) || 1);
  const q = pickStr(sp, "q")?.trim() || undefined;
  const sorteoId = pickStr(sp, "sorteo_id")?.trim() || undefined;
  const estadoRaw = pickStr(sp, "estado")?.trim();
  /** Cupones: solo estos tres estados en el filtro (sin `pendiente`). */
  const estadoPago: SorteoEntradaEstadoPago | undefined =
    estadoRaw === "pendiente_revision" || estadoRaw === "confirmado" || estadoRaw === "rechazado"
      ? estadoRaw
      : undefined;

  // Selector de sorteo: por defecto el sorteo actual (activo más reciente) para no
  // escanear todo el histórico. `all` = ver todos (opt-in explícito).
  const { sorteos } = await fetchSorteosListServer();
  const defaultSorteoId = pickDefaultSorteoId(sorteos);
  const selectedSorteoId =
    sorteoId === "all" ? null : sorteoId ?? defaultSorteoId ?? null;
  const selectValue = sorteoId === "all" ? "all" : sorteoId ?? defaultSorteoId ?? "all";

  const listParams: SorteoEntradasListParams = {
    page,
    limit: 50,
    q: q ?? null,
    sorteoId: selectedSorteoId,
    estadoPago: estadoPago ?? null,
  };

  const {
    data: rows,
    error: queryError,
    total_count,
    page: pageOut,
    limit,
    transient_error,
  } = await fetchSorteoCuponesOrdenesServer(listParams);

  const totalPages = Math.max(1, Math.ceil(total_count / limit));
  const qsBase = sp;

  return (
    <div className="space-y-6">
      {/* Breadcrumb */}
      <nav className="flex items-center gap-2 text-xs text-slate-500">
        <Link href="/sorteos" className="font-medium text-slate-500 transition-colors hover:text-[#4FAEB2]">
          Sorteos
        </Link>
        <span aria-hidden className="text-slate-300">/</span>
        <span className="font-semibold text-slate-700">Cupones</span>
      </nav>

      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="inline-block h-2 w-2 shrink-0 rounded-full bg-[#4FAEB2] shadow-[0_0_0_3px_rgba(79,174,178,0.18)]"
            />
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#4FAEB2]">
              Sorteos · Cupones
            </p>
          </div>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">Cupones</h1>
          <p className="mt-1 text-sm text-slate-500">Órdenes con números de cupón generados</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex w-full flex-wrap gap-1 rounded-2xl border border-[#4FAEB2]/45 bg-white p-1.5 shadow-sm sm:w-fit">
        <Link
          href="/sorteos"
          className="rounded-xl px-4 py-2 text-sm font-semibold text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700"
        >
          Sorteos
        </Link>
        <Link
          href="/sorteos/entradas"
          className="rounded-xl px-4 py-2 text-sm font-semibold text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700"
        >
          Entradas
        </Link>
        <span className="rounded-xl bg-[#4FAEB2] px-4 py-2 text-sm font-semibold text-white shadow-md shadow-[#4FAEB2]/30">
          Cupones
        </span>
        <Link
          href="/sorteos/tickets"
          className="rounded-xl px-4 py-2 text-sm font-semibold text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700"
        >
          Tickets
        </Link>
      </div>

      {/* Filtros */}
      <form
        method="get"
        className="rounded-2xl border border-[#4FAEB2]/45 bg-white p-5 shadow-sm"
      >
        <div className="flex items-center gap-2">
          <span aria-hidden="true" className="block h-5 w-1 rounded-full bg-[#4FAEB2]" />
          <h3 className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-600">
            <span aria-hidden="true" className="inline-block h-1.5 w-1.5 rounded-full bg-[#4FAEB2]" />
            Filtros
          </h3>
        </div>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">Buscar</span>
            <input
              name="q"
              defaultValue={q ?? ""}
              placeholder="Nombre, doc, teléfono…"
              className="w-[220px] rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm transition-colors placeholder:text-slate-400 hover:border-[#4FAEB2]/60 focus:border-[#4FAEB2] focus:outline-none focus:ring-2 focus:ring-[#4FAEB2]/20"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">Sorteo</span>
            <select
              name="sorteo_id"
              defaultValue={selectValue}
              className="w-[260px] rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm transition-colors hover:border-[#4FAEB2]/60 focus:border-[#4FAEB2] focus:outline-none focus:ring-2 focus:ring-[#4FAEB2]/20"
            >
              {sorteos.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.nombre}
                  {s.estado === "activo" ? " (activo)" : ""}
                </option>
              ))}
              <option value="all">Todos los sorteos</option>
            </select>
          </label>
          <SorteoCuponesEstadoPagoFilter />
          <button
            type="submit"
            className="rounded-xl bg-[#4FAEB2] px-4 py-2.5 text-sm font-semibold text-white shadow-sm shadow-[#4FAEB2]/25 transition-colors hover:bg-[#3F8E91]"
          >
            Filtrar
          </button>
          <Link
            href="/sorteos/cupones"
            className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 shadow-sm transition-colors hover:border-[#4FAEB2]/60 hover:bg-[#4FAEB2]/5 hover:text-[#3F8E91]"
          >
            Limpiar
          </Link>
        </div>
      </form>

      {transient_error ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          La base de datos está saturada momentáneamente. Reintentá en unos segundos o usá filtros.
        </div>
      ) : null}

      {queryError ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <strong>Error al cargar cupones:</strong> {queryError}
        </div>
      ) : null}

      <div className="text-sm text-slate-600">
        Mostrando página {pageOut} de {totalPages} · {total_count} órdenes con cupón · hasta {limit} por página
      </div>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        {pageOut > 1 ? (
          <Link
            href={`/sorteos/cupones${buildQuery(qsBase, { page: String(pageOut - 1) })}`}
            className="inline-flex items-center gap-1 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 shadow-sm transition-colors hover:border-[#4FAEB2]/60 hover:bg-[#4FAEB2]/5 hover:text-[#3F8E91]"
          >
            ← Anterior
          </Link>
        ) : null}
        {pageOut < totalPages ? (
          <Link
            href={`/sorteos/cupones${buildQuery(qsBase, { page: String(pageOut + 1) })}`}
            className="inline-flex items-center gap-1 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 shadow-sm transition-colors hover:border-[#4FAEB2]/60 hover:bg-[#4FAEB2]/5 hover:text-[#3F8E91]"
          >
            Siguiente →
          </Link>
        ) : null}
      </div>

      <SorteoCuponesBatchPrintClient
        rows={rows}
        selectedSorteoId={selectedSorteoId}
        estadoParam={estadoPago}
        qParam={q}
        totalCount={total_count}
      />
    </div>
  );
}
