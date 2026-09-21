"use client";

import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";

type Props = {
  entradaId: string;
  numeroOrden: number;
  nombreParticipante: string;
  cantidadBoletos: number;
  numerosCupon: string[];
  estadoPago: string;
};

/**
 * Anular venta: la orden deja de contar, sus cupones salen del sorteo y el cupo se libera.
 *
 * No hay deshacer, así que el diálogo dice exactamente qué va a pasar —incluidos los números
 * que se queman— antes de confirmar.
 */
export default function SorteoCuponesAnularCell({
  entradaId,
  numeroOrden,
  nombreParticipante,
  cantidadBoletos,
  numerosCupon,
  estadoPago,
}: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [motivo, setMotivo] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const yaAnulada = String(estadoPago ?? "").trim() === "anulado";

  const closeAll = useCallback(() => {
    setOpen(false);
    setBusy(false);
    setMotivo("");
    setErrorMsg(null);
  }, []);

  const anular = useCallback(async () => {
    setBusy(true);
    setErrorMsg(null);
    try {
      const res = await fetchWithSupabaseSession(
        `/api/sorteos/cupones/${encodeURIComponent(entradaId)}/anular`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ motivo }),
        }
      );
      const json = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        error?: string;
        data?: { cupones_anulados?: number; boletos_liberados?: number };
      };
      if (!res.ok || !json.success) {
        setErrorMsg(json.error ?? `Error ${res.status}`);
        return;
      }
      const cup = json.data?.cupones_anulados ?? 0;
      const bol = json.data?.boletos_liberados ?? 0;
      setToast(
        `Venta ${numeroOrden} anulada · ${cup} cupón${cup === 1 ? "" : "es"} fuera del sorteo · ${bol} boleto${bol === 1 ? "" : "s"} de cupo liberado${bol === 1 ? "" : "s"}`
      );
      window.setTimeout(() => setToast(null), 6000);
      closeAll();
      router.refresh();
    } catch (e: unknown) {
      setErrorMsg(e instanceof Error ? e.message : "Error de red");
    } finally {
      setBusy(false);
    }
  }, [entradaId, motivo, numeroOrden, router, closeAll]);

  return (
    <td className="px-5 py-3 text-sm">
      {toast ? (
        <div
          className="fixed bottom-4 right-4 z-[100] rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-900 shadow-lg"
          role="status"
        >
          {toast}
        </div>
      ) : null}

      {yaAnulada ? (
        <span className="inline-flex items-center rounded-full border border-slate-200 bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-500 whitespace-nowrap">
          Anulada
        </span>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          disabled={busy}
          className="rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-semibold text-red-700 shadow-sm transition-colors hover:border-red-300 hover:bg-red-50 disabled:opacity-50"
        >
          Anular venta
        </button>
      )}

      {open ? (
        <div
          className="fixed inset-0 z-[90] flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="anular-venta-title"
          onClick={() => !busy && closeAll()}
        >
          <div
            className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="anular-venta-title" className="text-base font-semibold text-slate-800">
              Anular la venta Nº {numeroOrden}
            </h2>
            <p className="mt-2 text-sm text-slate-600">
              {nombreParticipante} · {cantidadBoletos} boleto{cantidadBoletos === 1 ? "" : "s"}
            </p>

            <ul className="mt-3 space-y-1.5 text-sm text-slate-700">
              <li>• Sus cupones dejan de participar del sorteo y no se imprimen para la urna.</li>
              <li>
                • Se liberan {cantidadBoletos} boleto{cantidadBoletos === 1 ? "" : "s"} de cupo
                para volver a vender.
              </li>
              <li>• La venta sale de los totales de recaudación.</li>
              <li className="text-slate-500">
                • Los números{" "}
                <span className="font-mono text-slate-700">
                  {numerosCupon.slice(0, 8).join(", ")}
                  {numerosCupon.length > 8 ? ` +${numerosCupon.length - 8}` : ""}
                </span>{" "}
                quedan quemados: no se le asignan a nadie más, porque esta persona ya tiene su
                boleta con esos números.
              </li>
            </ul>

            <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              Esto no se puede deshacer desde el panel.
            </p>

            <label className="mt-4 flex flex-col gap-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">
                Motivo (opcional, queda en el registro interno)
              </span>
              <input
                value={motivo}
                onChange={(e) => setMotivo(e.target.value)}
                maxLength={500}
                placeholder="Ej.: pago rechazado por el banco"
                className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm placeholder:text-slate-400 focus:border-[#4FAEB2] focus:outline-none focus:ring-2 focus:ring-[#4FAEB2]/20"
              />
            </label>

            {errorMsg ? (
              <p className="mt-3 rounded border border-red-100 bg-red-50 px-2 py-1.5 text-sm text-red-700">
                {errorMsg}
              </p>
            ) : null}

            <div className="mt-5 flex flex-col gap-2 sm:flex-row">
              <button
                type="button"
                disabled={busy}
                onClick={() => void anular()}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                {busy ? "Anulando…" : "Sí, anular la venta"}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={closeAll}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </td>
  );
}
