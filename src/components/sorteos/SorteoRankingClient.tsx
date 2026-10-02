"use client";

import { useCallback, useMemo, useState } from "react";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";
import { paraguayNationalSignificantDigits } from "@/lib/chat/wa-phone";
import type {
  SorteoCompradorCompraRow,
  SorteoCompradorRankingRow,
  SorteoEntradaEstadoPago,
} from "@/lib/sorteos/types";

type Props = {
  rows: SorteoCompradorRankingRow[];
  selectedSorteoId: string | null;
  /** Dígitos nacionales de los participantes ya bloqueados (para marcar filas). */
  bloqueadosDigits: string[];
};

const GS = new Intl.NumberFormat("es-PY");
function formatGs(n: number): string {
  return `${GS.format(Math.round(n || 0))} ₲`;
}

function formatFecha(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("es-PY", { day: "2-digit", month: "2-digit", year: "numeric" });
}

const ESTADO_META: Record<SorteoEntradaEstadoPago, { label: string; chip: string }> = {
  pendiente: { label: "Pendiente", chip: "border-slate-200 bg-slate-50 text-slate-600" },
  pendiente_revision: { label: "En revisión", chip: "border-amber-200 bg-amber-50 text-amber-700" },
  confirmado: { label: "Confirmado", chip: "border-emerald-200 bg-emerald-50 text-emerald-700" },
  rechazado: { label: "Rechazado", chip: "border-rose-200 bg-rose-50 text-rose-700" },
  anulado: { label: "Anulado", chip: "border-slate-200 bg-slate-100 text-slate-500" },
};
function estadoMeta(v: string) {
  return (
    ESTADO_META[v as SorteoEntradaEstadoPago] ?? {
      label: v,
      chip: "border-slate-200 bg-slate-50 text-slate-600",
    }
  );
}

export default function SorteoRankingClient({ rows, selectedSorteoId, bloqueadosDigits }: Props) {
  const [openPhone, setOpenPhone] = useState<string | null>(null);
  const [comprasByPhone, setComprasByPhone] = useState<Record<string, SorteoCompradorCompraRow[]>>({});
  const [loadingPhone, setLoadingPhone] = useState<string | null>(null);
  const [errByPhone, setErrByPhone] = useState<Record<string, string>>({});

  // Estado de bloqueo por dígitos nacionales (se actualiza al bloquear/desbloquear).
  const [blockedSet, setBlockedSet] = useState<Set<string>>(
    () => new Set(bloqueadosDigits.map((d) => d.trim()).filter(Boolean))
  );
  const [dialog, setDialog] = useState<{ phone: string; nombre: string; blocking: boolean } | null>(null);
  const [motivo, setMotivo] = useState("");
  const [dialogBusy, setDialogBusy] = useState(false);
  const [dialogErr, setDialogErr] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const isBlocked = useCallback(
    (phone: string) => blockedSet.has(paraguayNationalSignificantDigits(phone)),
    [blockedSet]
  );

  const toggle = useCallback(
    async (phone: string) => {
      if (openPhone === phone) {
        setOpenPhone(null);
        return;
      }
      setOpenPhone(phone);
      if (comprasByPhone[phone]) return;

      setLoadingPhone(phone);
      setErrByPhone((e) => ({ ...e, [phone]: "" }));
      try {
        const sp = new URLSearchParams({ whatsapp: phone });
        if (selectedSorteoId) sp.set("sorteo_id", selectedSorteoId);
        const res = await fetchWithSupabaseSession(`/api/sorteos/ranking/compras?${sp.toString()}`, {
          cache: "no-store",
        });
        const json = (await res.json()) as {
          success?: boolean;
          data?: SorteoCompradorCompraRow[];
          error?: string;
        };
        if (!res.ok || !json.success) {
          throw new Error(json.error?.trim() || `No se pudo cargar (${res.status})`);
        }
        setComprasByPhone((m) => ({ ...m, [phone]: json.data ?? [] }));
      } catch (e) {
        setErrByPhone((er) => ({
          ...er,
          [phone]: e instanceof Error ? e.message : "Error al cargar las compras",
        }));
      } finally {
        setLoadingPhone(null);
      }
    },
    [openPhone, comprasByPhone, selectedSorteoId]
  );

  const confirmBloqueo = useCallback(async () => {
    if (!dialog) return;
    setDialogBusy(true);
    setDialogErr(null);
    try {
      const accion = dialog.blocking ? "bloquear" : "desbloquear";
      const res = await fetchWithSupabaseSession(`/api/sorteos/participantes/bloqueo`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ whatsapp: dialog.phone, accion, motivo }),
      });
      const json = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string };
      if (!res.ok || !json.success) {
        throw new Error(json.error?.trim() || `Error ${res.status}`);
      }
      const digits = paraguayNationalSignificantDigits(dialog.phone);
      setBlockedSet((prev) => {
        const next = new Set(prev);
        if (dialog.blocking) next.add(digits);
        else next.delete(digits);
        return next;
      });
      setToast(
        dialog.blocking
          ? `${dialog.nombre || dialog.phone} quedó bloqueado · no podrá comprar más`
          : `${dialog.nombre || dialog.phone} fue desbloqueado`
      );
      window.setTimeout(() => setToast(null), 6000);
      setDialog(null);
      setMotivo("");
    } catch (e) {
      setDialogErr(e instanceof Error ? e.message : "Error de red");
    } finally {
      setDialogBusy(false);
    }
  }, [dialog, motivo]);

  const rankByPhone = useMemo(() => {
    const m = new Map<string, number>();
    rows.forEach((r, i) => m.set(r.whatsapp_numero, i + 1));
    return m;
  }, [rows]);

  if (rows.length === 0) {
    return (
      <div className="rounded-2xl border border-[#4FAEB2]/45 bg-white px-4 py-12 text-center text-sm text-slate-400 shadow-sm">
        No hay compradores para mostrar con estos filtros.
      </div>
    );
  }

  return (
    <>
      {toast ? (
        <div
          className="fixed bottom-4 right-4 z-[100] rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-900 shadow-lg"
          role="status"
        >
          {toast}
        </div>
      ) : null}

      <div className="overflow-hidden rounded-2xl border border-[#4FAEB2]/45 bg-white shadow-sm">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50/80 text-left text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-500">
              <tr>
                <th className="px-4 py-3">#</th>
                <th className="px-4 py-3">Comprador</th>
                <th className="px-4 py-3 text-right">Compras</th>
                <th className="px-4 py-3 text-right">Boletas</th>
                <th className="px-4 py-3 text-right">Monto total</th>
                <th className="px-4 py-3">Última compra</th>
                <th className="px-4 py-3 text-right">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r) => (
                <RankingRow
                  key={r.whatsapp_numero}
                  rank={rankByPhone.get(r.whatsapp_numero) ?? 0}
                  row={r}
                  blocked={isBlocked(r.whatsapp_numero)}
                  isOpen={openPhone === r.whatsapp_numero}
                  loading={loadingPhone === r.whatsapp_numero}
                  err={errByPhone[r.whatsapp_numero]}
                  compras={comprasByPhone[r.whatsapp_numero] ?? []}
                  onToggle={() => void toggle(r.whatsapp_numero)}
                  onBloqueoClick={(blocking) =>
                    setDialog({ phone: r.whatsapp_numero, nombre: r.nombre_participante, blocking })
                  }
                />
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {dialog ? (
        <div
          className="fixed inset-0 z-[90] flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          onClick={() => !dialogBusy && setDialog(null)}
        >
          <div
            className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-base font-semibold text-slate-800">
              {dialog.blocking ? "Bloquear participante" : "Desbloquear participante"}
            </h2>
            <p className="mt-2 text-sm text-slate-600">
              {dialog.nombre || "—"} · {dialog.phone}
            </p>
            {dialog.blocking ? (
              <ul className="mt-3 space-y-1.5 text-sm text-slate-700">
                <li>• No podrá comprar más por ninguna vía (bot, cupón manual o n8n).</li>
                <li>• Su historial y comprobantes anteriores quedan intactos.</li>
                <li className="text-slate-500">• Podés desbloquearlo cuando quieras.</li>
              </ul>
            ) : (
              <p className="mt-3 text-sm text-slate-700">
                Volverá a poder comprar normalmente.
              </p>
            )}

            {dialog.blocking ? (
              <label className="mt-4 flex flex-col gap-1.5">
                <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">
                  Motivo (opcional, queda en el registro interno)
                </span>
                <input
                  value={motivo}
                  onChange={(e) => setMotivo(e.target.value)}
                  maxLength={500}
                  placeholder="Ej.: operaciones sospechosas"
                  className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm placeholder:text-slate-400 focus:border-[#4FAEB2] focus:outline-none focus:ring-2 focus:ring-[#4FAEB2]/20"
                />
              </label>
            ) : null}

            {dialogErr ? (
              <p className="mt-3 rounded border border-red-100 bg-red-50 px-2 py-1.5 text-sm text-red-700">
                {dialogErr}
              </p>
            ) : null}

            <div className="mt-5 flex flex-col gap-2 sm:flex-row">
              <button
                type="button"
                disabled={dialogBusy}
                onClick={() => void confirmBloqueo()}
                className={`rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50 ${
                  dialog.blocking ? "bg-red-600 hover:bg-red-700" : "bg-[#4FAEB2] hover:bg-[#3F8E91]"
                }`}
              >
                {dialogBusy
                  ? "Guardando…"
                  : dialog.blocking
                    ? "Sí, bloquear"
                    : "Sí, desbloquear"}
              </button>
              <button
                type="button"
                disabled={dialogBusy}
                onClick={() => setDialog(null)}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

function RankingRow({
  rank,
  row,
  blocked,
  isOpen,
  loading,
  err,
  compras,
  onToggle,
  onBloqueoClick,
}: {
  rank: number;
  row: SorteoCompradorRankingRow;
  blocked: boolean;
  isOpen: boolean;
  loading: boolean;
  err?: string;
  compras: SorteoCompradorCompraRow[];
  onToggle: () => void;
  onBloqueoClick: (blocking: boolean) => void;
}) {
  return (
    <>
      <tr className={`transition-colors hover:bg-[#4FAEB2]/5 ${blocked ? "bg-rose-50/40" : ""}`}>
        <td className="px-4 py-3 text-sm font-semibold text-slate-400">{rank}</td>
        <td className="px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="font-medium text-slate-800">{row.nombre_participante || "—"}</span>
            {blocked ? (
              <span className="inline-flex items-center rounded-full border border-rose-200 bg-rose-50 px-2 py-0.5 text-[10px] font-semibold text-rose-700">
                Bloqueado
              </span>
            ) : null}
          </div>
          <div className="text-xs text-slate-500">
            {row.whatsapp_numero}
            {row.documento ? ` · CI ${row.documento}` : ""}
          </div>
        </td>
        <td className="px-4 py-3 text-right font-mono text-slate-700">{row.compras}</td>
        <td className="px-4 py-3 text-right font-mono font-semibold text-slate-800">
          {row.total_boletos}
        </td>
        <td className="px-4 py-3 text-right font-mono font-semibold text-[#3F8E91]">
          {formatGs(row.total_monto)}
        </td>
        <td className="px-4 py-3 text-xs text-slate-600">{formatFecha(row.ultima_compra)}</td>
        <td className="px-4 py-3">
          <div className="flex flex-wrap justify-end gap-1.5">
            <button
              type="button"
              onClick={onToggle}
              className="inline-flex items-center rounded-lg border border-[#4FAEB2]/30 bg-[#4FAEB2]/8 px-2.5 py-1 text-[11px] font-semibold text-[#3F8E91] transition-colors hover:bg-[#4FAEB2]/12"
            >
              {isOpen ? "Ocultar" : "Ver compras"}
            </button>
            {blocked ? (
              <button
                type="button"
                onClick={() => onBloqueoClick(false)}
                className="inline-flex items-center rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-700 transition-colors hover:bg-slate-50"
              >
                Desbloquear
              </button>
            ) : (
              <button
                type="button"
                onClick={() => onBloqueoClick(true)}
                className="inline-flex items-center rounded-lg border border-red-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-red-700 transition-colors hover:border-red-300 hover:bg-red-50"
              >
                Bloquear
              </button>
            )}
          </div>
        </td>
      </tr>
      {isOpen ? (
        <tr className="bg-slate-50/60">
          <td colSpan={7} className="px-4 py-3">
            {loading ? (
              <div className="py-3 text-sm text-slate-500">Cargando compras…</div>
            ) : err ? (
              <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
                {err}
              </div>
            ) : compras.length === 0 ? (
              <div className="py-3 text-sm text-slate-400">Sin compras para mostrar.</div>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
                <table className="min-w-full text-sm">
                  <thead className="bg-slate-50 text-left text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-500">
                    <tr>
                      <th className="px-3 py-2">Orden</th>
                      <th className="px-3 py-2">Sorteo</th>
                      <th className="px-3 py-2 text-right">Boletas</th>
                      <th className="px-3 py-2 text-right">Monto</th>
                      <th className="px-3 py-2">Estado</th>
                      <th className="px-3 py-2">Fecha</th>
                      <th className="px-3 py-2 text-right">Comprobante</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {compras.map((c) => {
                      const meta = estadoMeta(c.estado_pago);
                      return (
                        <tr key={c.entrada_id}>
                          <td className="px-3 py-2 font-mono font-semibold text-slate-800">
                            {c.numero_orden ?? "—"}
                          </td>
                          <td className="px-3 py-2 text-slate-600">{c.sorteo_nombre}</td>
                          <td className="px-3 py-2 text-right font-mono text-slate-700">
                            {c.cantidad_boletos}
                          </td>
                          <td className="px-3 py-2 text-right font-mono text-slate-700">
                            {formatGs(c.monto_total)}
                          </td>
                          <td className="px-3 py-2">
                            <span
                              className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${meta.chip}`}
                            >
                              {meta.label}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-xs text-slate-600">
                            {formatFecha(c.created_at)}
                          </td>
                          <td className="px-3 py-2 text-right">
                            {c.comprobante_url ? (
                              <a
                                href={c.comprobante_url}
                                target="_blank"
                                rel="noreferrer"
                                className="font-medium text-[#4FAEB2] hover:underline"
                              >
                                Ver comprobante
                              </a>
                            ) : (
                              <span className="text-slate-400">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </td>
        </tr>
      ) : null}
    </>
  );
}
