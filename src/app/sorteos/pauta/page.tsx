"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";

type Resumen = {
  personas: number;
  compraron: number;
  boletas: number;
  monto: number;
  conversion: number;
};
type Anuncio = {
  ad_id: string;
  headline: string | null;
  desde: string;
  hasta: string;
  personas: number;
  compraron: number;
  boletas: number;
  monto: number;
  conversion: number;
};
type Dia = { dia: string; entraron: number; compraron: number; boletas: number };
type Comprador = {
  nombre: string;
  telefono: string | null;
  boletas: number;
  monto: number;
  cuando: string;
  ad_id: string;
};
type Respuesta = {
  sorteo: { id: string; nombre: string } | null;
  resumen: Resumen | null;
  porAnuncio: Anuncio[];
  porDia: Dia[];
  compradores: Comprador[];
};

const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
/** 'YYYY-MM-DD' → '20 oct' sin pasar por Date (evita corrimientos de zona horaria). */
function diaCorto(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  return `${Number(m[3])} ${MESES[Number(m[2]) - 1] ?? ""}`;
}
const fmtInt = (n: number) => (Math.round(Number(n) || 0)).toLocaleString("es-PY");
const fmtGs = (n: number) => "Gs " + fmtInt(n);
const fmtPct = (n: number) => ((Number(n) || 0) * 100).toFixed(1).replace(".", ",") + "%";
const shortAd = (id: string) => (id ? "#" + id.slice(-6) : "—");

async function pedir<T>(url: string): Promise<T> {
  const res = await fetchWithSupabaseSession(url, { cache: "no-store" });
  const json = (await res.json().catch(() => ({}))) as { success?: boolean; data?: T; error?: string };
  if (!res.ok || !json.success || json.data === undefined) {
    throw new Error(json.error || "Error al cargar.");
  }
  return json.data;
}

function Tile({ label, valor, sub }: { label: string; valor: string; sub: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</span>
      <span className="text-2xl font-bold tabular-nums text-slate-900">{valor}</span>
      <span className="text-xs text-slate-500">{sub}</span>
    </div>
  );
}

function GraficoDias({ dias }: { dias: Dia[] }) {
  const max = Math.max(1, ...dias.map((d) => d.entraron));
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-800">Entradas y compras por día</h2>
        <div className="flex items-center gap-3 text-[11px] text-slate-500">
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-sm bg-slate-300" /> Entraron
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-sm bg-emerald-500" /> Compraron
          </span>
        </div>
      </div>
      {dias.length === 0 ? (
        <p className="py-8 text-center text-sm text-slate-400">Todavía no entró nadie por pauta.</p>
      ) : (
        <div className="mt-4 flex items-end gap-2 overflow-x-auto pb-1">
          {dias.map((d) => {
            const he = Math.round((d.entraron / max) * 100);
            const hc = Math.round((d.compraron / max) * 100);
            return (
              <div key={d.dia} className="flex min-w-[42px] flex-1 flex-col items-center gap-1">
                <div className="flex h-36 w-full items-end justify-center gap-1">
                  <div
                    className="w-3.5 rounded-t bg-slate-300 sm:w-4"
                    style={{ height: `${d.entraron > 0 ? Math.max(he, 2) : 0}%` }}
                    title={`Entraron: ${d.entraron}`}
                  />
                  <div
                    className="w-3.5 rounded-t bg-emerald-500 sm:w-4"
                    style={{ height: `${d.compraron > 0 ? Math.max(hc, 2) : 0}%` }}
                    title={`Compraron: ${d.compraron}`}
                  />
                </div>
                <div className="text-[10px] tabular-nums text-slate-500">{diaCorto(d.dia)}</div>
                <div className="text-[10px] tabular-nums">
                  <span className="font-semibold text-slate-600">{d.entraron}</span>
                  <span className="text-slate-400"> / </span>
                  <span className="font-semibold text-emerald-600">{d.compraron}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function PautaPage() {
  const [data, setData] = useState<Respuesta | null>(null);
  const [cargando, setCargando] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    setCargando(true);
    setErr(null);
    try {
      setData(await pedir<Respuesta>("/api/sorteos/pauta"));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "No se pudo cargar.");
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const r = data?.resumen;

  return (
    <div className="mx-auto max-w-5xl space-y-5 px-4 py-5 sm:py-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-slate-900 sm:text-2xl">Ventas por pauta</h1>
          <p className="mt-1 text-sm text-slate-500">
            Cuántos de los que entraron por un anuncio de Meta compraron boletas.
            {data?.sorteo ? <> Sorteo: <span className="font-medium text-slate-700">{data.sorteo.nombre}</span>.</> : null}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void cargar()}
          disabled={cargando}
          className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 shadow-sm hover:bg-slate-50 disabled:opacity-50"
        >
          {cargando ? "Cargando…" : "↻ Actualizar"}
        </button>
      </div>

      {err && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{err}</div>
      )}

      {cargando && !data ? (
        <p className="text-sm text-slate-500">Cargando…</p>
      ) : !data?.sorteo ? (
        <div className="rounded-xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-500 shadow-sm">
          No hay un sorteo activo ahora mismo.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Tile label="Entraron por pauta" valor={fmtInt(r?.personas ?? 0)} sub="personas, clic en un anuncio" />
            <Tile
              label="Compraron"
              valor={fmtInt(r?.compraron ?? 0)}
              sub={`${fmtPct(r?.conversion ?? 0)} de conversión`}
            />
            <Tile label="Boletas vendidas" valor={fmtInt(r?.boletas ?? 0)} sub="atribuidas a la pauta" />
            <Tile label="Ingreso atribuido" valor={fmtGs(r?.monto ?? 0)} sub="compras confirmadas" />
          </div>

          <GraficoDias dias={data.porDia} />

          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <h2 className="text-sm font-semibold text-slate-800">Por anuncio</h2>
            <p className="mt-0.5 text-xs text-slate-500">Cada pauta, su período y cuánto convirtió. El ID es el del anuncio en Meta.</p>
            <div className="mt-3 overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="text-[10px] uppercase tracking-wide text-slate-500">
                  <tr className="border-b border-slate-200">
                    <th className="px-2 py-2 font-semibold">Anuncio</th>
                    <th className="px-2 py-2 font-semibold">Período</th>
                    <th className="px-2 py-2 text-right font-semibold">Entraron</th>
                    <th className="px-2 py-2 text-right font-semibold">Compraron</th>
                    <th className="px-2 py-2 text-right font-semibold">Conversión</th>
                    <th className="px-2 py-2 text-right font-semibold">Boletas</th>
                    <th className="px-2 py-2 text-right font-semibold">Ingreso</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.porAnuncio.map((a) => (
                    <tr key={a.ad_id} className="hover:bg-slate-50/60">
                      <td className="px-2 py-2">
                        <div className="font-medium text-slate-800">{a.headline || "Anuncio"}</div>
                        <div className="font-mono text-[11px] text-slate-400">{shortAd(a.ad_id)}</div>
                      </td>
                      <td className="whitespace-nowrap px-2 py-2 text-slate-600">
                        {a.desde === a.hasta ? diaCorto(a.desde) : `${diaCorto(a.desde)}–${diaCorto(a.hasta)}`}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums text-slate-700">{fmtInt(a.personas)}</td>
                      <td className="px-2 py-2 text-right tabular-nums font-semibold text-emerald-700">{fmtInt(a.compraron)}</td>
                      <td className="px-2 py-2 text-right tabular-nums text-slate-700">{fmtPct(a.conversion)}</td>
                      <td className="px-2 py-2 text-right tabular-nums text-slate-700">{fmtInt(a.boletas)}</td>
                      <td className="px-2 py-2 text-right tabular-nums font-semibold text-slate-800">{fmtGs(a.monto)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <h2 className="text-sm font-semibold text-slate-800">
              Quiénes compraron viniendo de pauta
              <span className="ml-2 text-xs font-normal text-slate-400">{data.compradores.length}</span>
            </h2>
            {data.compradores.length === 0 ? (
              <p className="py-6 text-center text-sm text-slate-400">Todavía nadie de la pauta compró.</p>
            ) : (
              <div className="mt-3 max-h-[460px] overflow-auto">
                <table className="min-w-full text-left text-sm">
                  <thead className="sticky top-0 z-10 bg-white text-[10px] uppercase tracking-wide text-slate-500">
                    <tr className="border-b border-slate-200">
                      <th className="px-2 py-2 font-semibold">Cliente</th>
                      <th className="px-2 py-2 text-right font-semibold">Boletas</th>
                      <th className="px-2 py-2 text-right font-semibold">Monto</th>
                      <th className="px-2 py-2 font-semibold">Cuándo</th>
                      <th className="px-2 py-2 font-semibold">Anuncio</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {data.compradores.map((c, i) => (
                      <tr key={`${c.telefono ?? c.nombre}-${i}`} className="hover:bg-slate-50/60">
                        <td className="px-2 py-2 font-medium text-slate-800">{c.nombre}</td>
                        <td className="px-2 py-2 text-right">
                          <span className="rounded-md bg-emerald-50 px-1.5 py-0.5 text-[11px] font-semibold text-emerald-700 tabular-nums">
                            {c.boletas}
                          </span>
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums text-slate-700">{fmtGs(c.monto)}</td>
                        <td className="whitespace-nowrap px-2 py-2 text-slate-600">{diaCorto(c.cuando)}</td>
                        <td className="px-2 py-2 font-mono text-[11px] text-slate-400">{shortAd(c.ad_id)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <p className="text-[11px] leading-relaxed text-slate-500">
            Cómo se mide: los anuncios Click-to-WhatsApp de Meta pegan el ID del anuncio al primer mensaje del
            cliente, que queda guardado en el chat. Cruzamos esos números con las compras confirmadas del sorteo
            hechas después del clic. Solo se cuentan los clics ocurridos durante este sorteo, y cada persona se
            cuenta una vez, en el último anuncio por el que entró. Se actualiza solo cada vez que abrís esta
            página.
          </p>
        </>
      )}
    </div>
  );
}
