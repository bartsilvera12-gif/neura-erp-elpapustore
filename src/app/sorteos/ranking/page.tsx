import Link from "next/link";
import {
  fetchSorteoCompradoresRankingServer,
  fetchSorteosListServer,
  pickDefaultSorteoId,
} from "@/lib/sorteos/server-queries";
import { fetchBloqueadosNationalDigitsCurrentEmpresa } from "@/lib/sorteos/participante-bloqueo";
import SorteoRankingClient from "@/components/sorteos/SorteoRankingClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Sp = Record<string, string | string[] | undefined>;

function pickStr(sp: Sp, key: string): string | undefined {
  const v = sp[key];
  if (typeof v === "string") return v;
  if (Array.isArray(v) && v[0]) return v[0];
  return undefined;
}

const TOP_OPTIONS = [50, 100, 200] as const;

export default async function SorteoRankingPage({
  searchParams,
}: {
  searchParams?: Sp | Promise<Sp>;
}) {
  const sp = await Promise.resolve(searchParams ?? {});
  const q = pickStr(sp, "q")?.trim() || undefined;
  const sorteoParam = pickStr(sp, "sorteo_id")?.trim() || undefined;
  const topRaw = parseInt(pickStr(sp, "top") ?? "100", 10);
  const top = TOP_OPTIONS.includes(topRaw as (typeof TOP_OPTIONS)[number]) ? topRaw : 100;

  const { sorteos } = await fetchSorteosListServer();
  const defaultSorteoId = pickDefaultSorteoId(sorteos);
  // Por defecto el sorteo actual; `all` = todos los sorteos (opt-in).
  const selectedSorteoId = sorteoParam === "all" ? null : sorteoParam ?? defaultSorteoId ?? null;
  const selectValue = sorteoParam === "all" ? "all" : sorteoParam ?? defaultSorteoId ?? "all";

  const [{ data: rows, error, truncated }, bloqueadosDigits] = await Promise.all([
    fetchSorteoCompradoresRankingServer({
      sorteoId: selectedSorteoId,
      limit: top,
      q: q ?? null,
    }),
    fetchBloqueadosNationalDigitsCurrentEmpresa(),
  ]);

  return (
    <div className="space-y-6">
      {/* Breadcrumb */}
      <nav className="flex items-center gap-2 text-xs text-slate-500">
        <Link href="/sorteos" className="font-medium text-slate-500 transition-colors hover:text-[#4FAEB2]">
          Sorteos
        </Link>
        <span aria-hidden className="text-slate-300">/</span>
        <span className="font-semibold text-slate-700">Ranking</span>
      </nav>

      {/* Header */}
      <div>
        <div className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="inline-block h-2 w-2 shrink-0 rounded-full bg-[#4FAEB2] shadow-[0_0_0_3px_rgba(79,174,178,0.18)]"
          />
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#4FAEB2]">
            Sorteos · Ranking
          </p>
        </div>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">
          Ranking de compradores
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          Quiénes más compraron, con cantidad de compras, boletas y monto. Abrí cada comprador para
          revisar sus comprobantes.
        </p>
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
        <span className="rounded-xl bg-[#4FAEB2] px-4 py-2 text-sm font-semibold text-white shadow-md shadow-[#4FAEB2]/30">
          Ranking
        </span>
      </div>

      {/* Filtros */}
      <form method="get" className="rounded-2xl border border-[#4FAEB2]/45 bg-white p-5 shadow-sm">
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
              placeholder="Nombre, doc o teléfono…"
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
            <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">Mostrar</span>
            <select
              name="top"
              defaultValue={String(top)}
              className="w-[130px] rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm transition-colors hover:border-[#4FAEB2]/60 focus:border-[#4FAEB2] focus:outline-none focus:ring-2 focus:ring-[#4FAEB2]/20"
            >
              {TOP_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  Top {n}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            className="rounded-xl bg-[#4FAEB2] px-4 py-2.5 text-sm font-semibold text-white shadow-sm shadow-[#4FAEB2]/25 transition-colors hover:bg-[#3F8E91]"
          >
            Filtrar
          </button>
          <Link
            href="/sorteos/ranking"
            className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 shadow-sm transition-colors hover:border-[#4FAEB2]/60 hover:bg-[#4FAEB2]/5 hover:text-[#3F8E91]"
          >
            Limpiar
          </Link>
        </div>
        <p className="mt-3 text-xs text-slate-400">
          Cuenta compras confirmadas y en revisión (no suma anuladas ni rechazadas). Agrupa por
          número de WhatsApp.
        </p>
      </form>

      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <strong>Error al cargar el ranking:</strong> {error}
        </div>
      ) : null}

      {truncated ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          Hay muchísimas compras y el ranking se calculó sobre una muestra; puede estar incompleto.
        </div>
      ) : null}

      <div className="text-sm text-slate-600">{rows.length} compradores</div>

      <SorteoRankingClient
        rows={rows}
        selectedSorteoId={selectedSorteoId}
        bloqueadosDigits={bloqueadosDigits}
      />
    </div>
  );
}
