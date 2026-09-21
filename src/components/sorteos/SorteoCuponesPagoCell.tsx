"use client";

import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";
import type { SorteoEntradaEstadoPago } from "@/lib/sorteos/types";

type Props = {
  entradaId: string;
  estadoPago: SorteoEntradaEstadoPago | string;
};

function badgeClasses(estado: string): string {
  const base = "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap";
  if (estado === "pendiente_revision") {
    return `${base} bg-red-600 text-white shadow-sm`;
  }
  if (estado === "confirmado") {
    return `${base} bg-emerald-600 text-white`;
  }
  if (estado === "rechazado") {
    return `${base} bg-red-700 text-white`;
  }
  if (estado === "pendiente") {
    return `${base} bg-amber-100 text-amber-900 border border-amber-200`;
  }
  if (estado === "anulado") {
    return `${base} bg-slate-200 text-slate-600 border border-slate-300`;
  }
  return `${base} bg-slate-100 text-slate-700 border border-slate-200`;
}

/** Etiqueta en columna Pago: `confirmado` se muestra como «Aprobado» solo aquí. */
function labelForColumn(estado: string): string {
  if (estado === "pendiente_revision") return "Pendiente revisión";
  if (estado === "pendiente") return "Pendiente";
  if (estado === "confirmado") return "Aprobado";
  if (estado === "rechazado") return "Rechazado";
  if (estado === "anulado") return "Anulada";
  return estado;
}

export default function SorteoCuponesPagoCell({ entradaId, estadoPago }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const estado = String(estadoPago ?? "").trim();

  const closeAll = useCallback(() => {
    setOpen(false);
    setBusy(false);
  }, []);

  const patchEstado = useCallback(
    async (next: "confirmado" | "rechazado") => {
      setBusy(true);
      setErrorMsg(null);
      try {
        const res = await fetchWithSupabaseSession(
          `/api/sorteos/cupones/${encodeURIComponent(entradaId)}/estado-pago`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ estado_pago: next }),
          }
        );
        const json = (await res.json().catch(() => ({}))) as {
          success?: boolean;
          error?: string;
        };
        if (!res.ok || !json.success) {
          setErrorMsg(json.error ?? `Error ${res.status}`);
          return;
        }
        setToast(
          next === "confirmado" ? "Pago aprobado correctamente" : "Pago rechazado correctamente"
        );
        window.setTimeout(() => setToast(null), 4000);
        closeAll();
        router.refresh();
      } catch (e: unknown) {
        setErrorMsg(e instanceof Error ? e.message : "Error de red");
      } finally {
        setBusy(false);
      }
    },
    [entradaId, router, closeAll]
  );

  const interactive = estado === "pendiente_revision";

  return (
    <td className="px-5 py-3 text-sm relative">
      {toast ? (
        <div
          className="fixed bottom-4 right-4 z-[100] rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-900 shadow-lg"
          role="status"
        >
          {toast}
        </div>
      ) : null}

      {interactive ? (
        <>
          <button
            type="button"
            className={`${badgeClasses(estado)} cursor-pointer hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-red-400`}
            onClick={() => {
              setErrorMsg(null);
              setOpen(true);
            }}
            disabled={busy}
          >
            {labelForColumn(estado)}
          </button>

          {open ? (
            <div
              className="fixed inset-0 z-[90] flex items-center justify-center bg-black/40 p-4"
              role="dialog"
              aria-modal="true"
              aria-labelledby="cupon-pago-dialog-title"
              onClick={() => !busy && closeAll()}
            >
              <div
                className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-5 shadow-xl"
                onClick={(e) => e.stopPropagation()}
              >
                <h2 id="cupon-pago-dialog-title" className="text-base font-semibold text-slate-800">
                  ¿Qué querés hacer con este pago?
                </h2>
                <p className="mt-2 text-sm text-slate-600">
                  Podés aprobar el pago (quedará confirmado en el sistema) o rechazarlo.
                </p>
                {errorMsg ? (
                  <p className="mt-3 text-sm text-red-700 bg-red-50 border border-red-100 rounded px-2 py-1.5">
                    {errorMsg}
                  </p>
                ) : null}
                <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                  <button
                    type="button"
                    disabled={busy}
                    className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                    onClick={() => void patchEstado("confirmado")}
                  >
                    Aprobar
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
                    onClick={() => void patchEstado("rechazado")}
                  >
                    Rechazar
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                    onClick={closeAll}
                  >
                    Cancelar
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </>
      ) : (
        <span className={badgeClasses(estado)}>{labelForColumn(estado)}</span>
      )}
    </td>
  );
}
