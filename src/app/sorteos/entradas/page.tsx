import Link from "next/link";
import {
  fetchSorteoEntradasServer,
  fetchSorteosListServer,
  pickDefaultSorteoId,
  type SorteoEntradasListParams,
} from "@/lib/sorteos/server-queries";
import type { SorteoEntradaEstadoPago } from "@/lib/sorteos/types";

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

function formatGs(n: number) {
  return `${n.toLocaleString("es-PY")} ₲`;
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

function estadoPagoLabel(e: string) {
  if (e === "pendiente_revision") return "Pendiente revisión";
  if (e === "pendiente") return "Pendiente";
  if (e === "confirmado") return "Confirmado";
  if (e === "rechazado") return "Rechazado";
  return e;
}

function precioFuenteLabel(v: string | null | undefined) {
  if (v === "promo") return "Promo";
  if (v === "lista") return "Lista";
  return "—";
}

export default async function SorteoEntradasPage({
  searchParams,
}: {
  searchParams?: Sp | Promise<Sp>;
}) {
  const sp = await Promise.resolve(searchParams ?? {});
  const page = Math.max(1, parseInt(pickStr(sp, "page") ?? "1", 10) || 1);
  const q = pickStr(sp, "q")?.trim() || undefined;
  const sorteoId = pickStr(sp, "sorteo_id")?.trim() || undefined;
  const estadoRaw = pickStr(sp, "estado")?.trim();
  const estadoPago: SorteoEntradaEstadoPago | undefined =
    estadoRaw === "pendiente" ||
    estadoRaw === "pendiente_revision" ||
    estadoRaw === "confirmado" ||
    estadoRaw === "rechazado"
      ? estadoRaw
      : undefined;

  // Selector de sorteo. Por defecto carga el sorteo actual (activo más reciente) para
  // evitar escanear todo el histórico. `all` = ver todos (opt-in explícito).
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
  } = await fetchSorteoEntradasServer(listParams);

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
        <span className="font-semibold text-slate-700">Entradas</span>
      </nav>

      {/* Header */}
      <div>
        <div className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="inline-block h-2 w-2 shrink-0 rounded-full bg-[#4FAEB2] shadow-[0_0_0_3px_rgba(79,174,178,0.18)]"
          />
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#4FAEB2]">
            Sorteos · Entradas
          </p>
        </div>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">Entradas</h1>
        <p className="mt-1 text-sm text-slate-500">Compras registradas por participante</p>
      </div>

      {/* Tabs */}
      <div className="flex w-full flex-wrap gap-1 rounded-2xl border border-[#4FAEB2]/45 bg-white p-1.5 shadow-sm sm:w-fit">
        <Link
          href="/sorteos"
          className="rounded-xl px-4 py-2 text-sm font-semibold text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700"
        >
          Sorteos
        </Link>
        <span className="rounded-xl bg-[#4FAEB2] px-4 py-2 text-sm font-semibold text-white shadow-md shadow-[#4FAEB2]/30">
          Entradas
        </span>
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
          <label className="flex flex-col gap-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">Estado pago</span>
            <select
              name="estado"
              defaultValue={estadoRaw ?? ""}
              className="w-[14rem] appearance-none rounded-xl border border-slate-200 bg-white bg-[length:14px_14px] bg-[right_0.7rem_center] bg-no-repeat px-3 py-2 pr-8 text-sm font-medium text-slate-700 shadow-sm transition-colors hover:border-[#4FAEB2]/60 focus:border-[#4FAEB2] focus:outline-none focus:ring-2 focus:ring-[#4FAEB2]/20"
              style={{
                backgroundImage:
                  "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke='%234FAEB2' stroke-width='2.5'><path stroke-linecap='round' stroke-linejoin='round' d='M6 9l6 6 6-6'/></svg>\")",
              }}
            >
              <option value="">Todos</option>
              <option value="pendiente_revision">Pendiente revisión</option>
              <option value="pendiente">Pendiente</option>
              <option value="confirmado">Confirmado</option>
              <option value="rechazado">Rechazado</option>
            </select>
          </label>
          <button
            type="submit"
            className="rounded-xl bg-[#4FAEB2] px-4 py-2.5 text-sm font-semibold text-white shadow-sm shadow-[#4FAEB2]/25 transition-colors hover:bg-[#3F8E91]"
          >
            Filtrar
          </button>
          <Link
            href="/sorteos/entradas"
            className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 shadow-sm transition-colors hover:border-[#4FAEB2]/60 hover:bg-[#4FAEB2]/5 hover:text-[#3F8E91]"
          >
            Limpiar
          </Link>
        </div>
      </form>

      {transient_error ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          La base de datos está saturada momentáneamente. Reintentá en unos segundos o usá filtros para reducir resultados.
        </div>
      ) : null}

      {queryError ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <strong>Error al cargar entradas:</strong> {queryError}
        </div>
      ) : null}

      <div className="text-sm text-slate-600">
        Mostrando página {pageOut} de {totalPages} · {total_count} entradas en total · hasta {limit} por página
      </div>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        {pageOut > 1 ? (
          <Link
            href={`/sorteos/entradas${buildQuery(qsBase, { page: String(pageOut - 1) })}`}
            className="inline-flex items-center gap-1 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 shadow-sm transition-colors hover:border-[#4FAEB2]/60 hover:bg-[#4FAEB2]/5 hover:text-[#3F8E91]"
          >
            ← Anterior
          </Link>
        ) : null}
        {pageOut < totalPages ? (
          <Link
            href={`/sorteos/entradas${buildQuery(qsBase, { page: String(pageOut + 1) })}`}
            className="inline-flex items-center gap-1 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 shadow-sm transition-colors hover:border-[#4FAEB2]/60 hover:bg-[#4FAEB2]/5 hover:text-[#3F8E91]"
          >
            Siguiente →
          </Link>
        ) : null}
      </div>

      <div className="overflow-hidden rounded-2xl border border-[#4FAEB2]/45 bg-white shadow-sm">
        {rows.length === 0 && !queryError ? (
          <div className="py-16 text-center text-gray-400 text-sm">No hay entradas</div>
        ) : rows.length === 0 ? null : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[960px]">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50/80">
                  <th className="px-5 py-3 text-left text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-500">Nº orden</th>
                  <th className="px-5 py-3 text-left text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-500">Sorteo</th>
                  <th className="px-5 py-3 text-left text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-500">Participante</th>
                  <th className="px-5 py-3 text-left text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-500">Documento</th>
                  <th className="px-5 py-3 text-right text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-500">Cant.</th>
                  <th className="px-5 py-3 text-right text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-500">Monto</th>
                  <th className="px-5 py-3 text-left text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-500 min-w-[140px]">
                    Promo / fuente
                  </th>
                  <th className="px-5 py-3 text-left text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-500">Pago</th>
                  <th className="px-5 py-3 text-left text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-500">Fecha pago</th>
                  <th className="px-5 py-3 text-left text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-500">Validado</th>
                  <th className="px-5 py-3 text-left text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-500">Creado</th>
                  <th className="px-5 py-3 text-left text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-500">Comprobante</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r) => (
                  <tr key={r.id} className="hover:bg-slate-50/80">
                    <td className="px-5 py-3 text-sm font-mono font-semibold text-slate-800">
                      {typeof r.numero_orden === "number" ? r.numero_orden : "—"}
                    </td>
                    <td className="px-5 py-3 text-sm text-slate-800">
                      {(r.sorteos as { nombre?: string } | undefined)?.nombre ?? "—"}
                    </td>
                    <td className="px-5 py-3 text-sm">{r.nombre_participante}</td>
                    <td className="px-5 py-3 text-sm font-mono text-slate-600">{r.documento ?? "—"}</td>
                    <td className="px-5 py-3 text-sm text-right tabular-nums">{r.cantidad_boletos}</td>
                    <td className="px-5 py-3 text-sm text-right tabular-nums">{formatGs(r.monto_total)}</td>
                    <td className="px-5 py-3 text-sm">
                      <div className="text-xs font-medium text-slate-700">
                        {precioFuenteLabel(r.precio_fuente ?? null)}
                      </div>
                      {r.promo_nombre ? (
                        <div className="text-xs text-slate-500 mt-0.5 leading-snug">{r.promo_nombre}</div>
                      ) : null}
                      {typeof r.precio_regular_referencia === "number" &&
                      r.precio_regular_referencia > 0 &&
                      r.precio_fuente === "promo" ? (
                        <div className="text-[11px] text-slate-400 mt-0.5 line-through tabular-nums">
                          Ref. lista {formatGs(r.precio_regular_referencia)}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-5 py-3 text-sm">{estadoPagoLabel(r.estado_pago)}</td>
                    <td className="px-5 py-3 text-sm whitespace-nowrap">{formatFecha(r.fecha_pago)}</td>
                    <td className="px-5 py-3 text-sm">{r.validado_por ?? "—"}</td>
                    <td className="px-5 py-3 text-sm whitespace-nowrap">{formatFecha(r.created_at)}</td>
                    <td className="px-5 py-3 text-sm">
                      {r.comprobante_url?.trim() ? (
                        <a
                          href={r.comprobante_url.trim()}
                          target="_blank"
                          rel="noreferrer"
                          className="text-[#4FAEB2] hover:underline font-medium"
                        >
                          Abrir
                        </a>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
