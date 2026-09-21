"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { SorteoCuponOrdenRow } from "@/lib/sorteos/types";
import SorteoCuponesPagoCell from "@/components/sorteos/SorteoCuponesPagoCell";
import SorteoCuponesImpresionCell from "@/components/sorteos/SorteoCuponesImpresionCell";
import SorteoCuponesAnularCell from "@/components/sorteos/SorteoCuponesAnularCell";

/** Sobre este umbral, "Imprimir todos los filtrados" pide confirmación. */
const CONFIRM_TODOS_THRESHOLD = 300;

function formatGs(n: number) {
  return `${n.toLocaleString("es-PY")} ₲`;
}

function formatFecha(iso: string) {
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

function openPrintWindow(url: string) {
  // Nueva pestaña: mantiene la lista de cupones abierta detrás.
  window.open(url, "_blank", "noopener");
}

export default function SorteoCuponesBatchPrintClient({
  rows,
  selectedSorteoId,
  estadoParam,
  qParam,
  totalCount,
}: {
  rows: SorteoCuponOrdenRow[];
  /** Sorteo del filtro actual; null cuando se eligió "Todos los sorteos". */
  selectedSorteoId: string | null;
  estadoParam?: string;
  qParam?: string;
  totalCount: number;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [cuponDesde, setCuponDesde] = useState("");
  const [cuponHasta, setCuponHasta] = useState("");

  const visibleIds = useMemo(() => rows.map((r) => r.entrada_id), [rows]);
  const allVisibleSelected =
    visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  const someVisibleSelected = visibleIds.some((id) => selected.has(id));

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAllVisible() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        for (const id of visibleIds) next.delete(id);
      } else {
        for (const id of visibleIds) next.add(id);
      }
      return next;
    });
  }

  function printUrl(sorteoId: string, extra: Record<string, string>): string {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(extra)) {
      if (v) p.set(k, v);
    }
    const qs = p.toString();
    return `/sorteos/${encodeURIComponent(sorteoId)}/imprimir-cupones${qs ? `?${qs}` : ""}`;
  }

  function handleImprimirSeleccionados() {
    const ids = [...selected];
    if (ids.length === 0) return;
    // Todos los seleccionados deben pertenecer al mismo sorteo (la ruta de impresión es por sorteo).
    const bySorteo = new Map<string, string[]>();
    for (const r of rows) {
      if (!selected.has(r.entrada_id)) continue;
      const list = bySorteo.get(r.sorteo_id) ?? [];
      list.push(r.entrada_id);
      bySorteo.set(r.sorteo_id, list);
    }
    if (bySorteo.size > 1) {
      window.alert(
        "Seleccionaste cupones de más de un sorteo. Para imprimir en tanda, elegí cupones de un solo sorteo (usá el filtro Sorteo)."
      );
      return;
    }
    const [sorteoId, entradaIds] = [...bySorteo.entries()][0];
    openPrintWindow(printUrl(sorteoId, { entrada_ids: entradaIds.join(",") }));
  }

  function handleImprimirRango() {
    if (!selectedSorteoId) {
      window.alert("Elegí un sorteo específico en el filtro para imprimir por rango.");
      return;
    }
    const d = cuponDesde.trim();
    const h = cuponHasta.trim();
    if (!/^[0-9]+$/.test(d) || !/^[0-9]+$/.test(h)) {
      window.alert("Ingresá un rango numérico válido (desde y hasta).");
      return;
    }
    openPrintWindow(
      printUrl(selectedSorteoId, {
        cupon_desde: d,
        cupon_hasta: h,
        estado: estadoParam ?? "",
      })
    );
  }

  function handleImprimirTodosFiltrados() {
    if (!selectedSorteoId) {
      window.alert("Elegí un sorteo específico en el filtro para imprimir todos los resultados.");
      return;
    }
    if (
      totalCount > CONFIRM_TODOS_THRESHOLD &&
      !window.confirm(
        `Vas a abrir la impresión de todos los cupones filtrados (${totalCount.toLocaleString(
          "es-PY"
        )} órdenes). Puede tardar. ¿Continuar?`
      )
    ) {
      return;
    }
    openPrintWindow(
      printUrl(selectedSorteoId, { estado: estadoParam ?? "", q: qParam ?? "" })
    );
  }

  const selectedCount = selected.size;

  return (
    <div className="space-y-4">
      {/* Barra de impresión por tandas */}
      <div className="rounded-2xl border border-[#4FAEB2]/45 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-end gap-3">
          <button
            type="button"
            onClick={handleImprimirSeleccionados}
            disabled={selectedCount === 0}
            className="rounded-xl bg-[#4FAEB2] px-4 py-2.5 text-sm font-semibold text-white shadow-sm shadow-[#4FAEB2]/25 transition-colors hover:bg-[#3F8E91] disabled:opacity-50 disabled:pointer-events-none"
          >
            Imprimir seleccionados ({selectedCount})
          </button>

          <div className="flex items-end gap-2 border-l border-slate-200 pl-3">
            <label className="flex flex-col gap-1">
              <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">
                Cupón desde
              </span>
              <input
                inputMode="numeric"
                value={cuponDesde}
                onChange={(e) => setCuponDesde(e.target.value.replace(/[^0-9]/g, ""))}
                placeholder="0001"
                className="w-[110px] rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-[#4FAEB2] focus:outline-none focus:ring-2 focus:ring-[#4FAEB2]/20"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">
                Cupón hasta
              </span>
              <input
                inputMode="numeric"
                value={cuponHasta}
                onChange={(e) => setCuponHasta(e.target.value.replace(/[^0-9]/g, ""))}
                placeholder="0100"
                className="w-[110px] rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-[#4FAEB2] focus:outline-none focus:ring-2 focus:ring-[#4FAEB2]/20"
              />
            </label>
            <button
              type="button"
              onClick={handleImprimirRango}
              disabled={!selectedSorteoId}
              title={!selectedSorteoId ? "Elegí un sorteo específico" : undefined}
              className="rounded-xl border border-[#4FAEB2]/50 bg-white px-4 py-2.5 text-sm font-semibold text-[#3F8E91] shadow-sm transition-colors hover:bg-[#4FAEB2]/5 disabled:opacity-50 disabled:pointer-events-none"
            >
              Imprimir rango
            </button>
          </div>

          <button
            type="button"
            onClick={handleImprimirTodosFiltrados}
            disabled={!selectedSorteoId}
            title={!selectedSorteoId ? "Elegí un sorteo específico" : undefined}
            className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 shadow-sm transition-colors hover:border-[#4FAEB2]/60 hover:bg-[#4FAEB2]/5 hover:text-[#3F8E91] disabled:opacity-50 disabled:pointer-events-none"
          >
            Imprimir todos los filtrados ({totalCount.toLocaleString("es-PY")})
          </button>
        </div>
        <p className="mt-2 text-xs text-slate-500">
          La impresión por tandas abre la pantalla de impresión en una pestaña nueva. No modifica datos
          ni marca cupones como impresos. El botón «Imprimir» de cada fila sigue funcionando igual.
          {!selectedSorteoId
            ? " Para rango / todos, elegí un sorteo específico en el filtro de arriba."
            : ""}
        </p>
      </div>

      {/* Tabla */}
      <div className="overflow-hidden rounded-2xl border border-[#4FAEB2]/45 bg-white shadow-sm">
        {rows.length === 0 ? (
          <div className="py-16 text-center text-gray-400 text-sm">No hay órdenes con cupones</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1180px]">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50/80">
                  <th className="px-4 py-3 text-left">
                    <input
                      type="checkbox"
                      aria-label="Seleccionar todos los visibles"
                      checked={allVisibleSelected}
                      ref={(el) => {
                        if (el) el.indeterminate = !allVisibleSelected && someVisibleSelected;
                      }}
                      onChange={toggleAllVisible}
                      className="h-4 w-4 rounded border-slate-300"
                    />
                  </th>
                  <th className="px-5 py-3 text-left text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-500">Nº orden</th>
                  <th className="px-5 py-3 text-left text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-500">Sorteo</th>
                  <th className="px-5 py-3 text-left text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-500">Cliente</th>
                  <th className="px-5 py-3 text-left text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-500">Cédula</th>
                  <th className="px-5 py-3 text-left text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-500">Teléfono</th>
                  <th className="px-5 py-3 text-left text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-500">Ciudad</th>
                  <th className="px-5 py-3 text-left text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-500">Cantidad</th>
                  <th className="px-5 py-3 text-right text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-500">Monto</th>
                  <th className="px-5 py-3 text-left text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-500">Cupones</th>
                  <th className="px-5 py-3 text-left text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-500">Impresión</th>
                  <th className="px-5 py-3 text-left text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-500">Pago</th>
                  <th className="px-5 py-3 text-left text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-500">Fecha</th>
                  <th className="px-5 py-3 text-left text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-500">Chat</th>
                  <th className="px-5 py-3 text-left text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-500">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r) => {
                  const checked = selected.has(r.entrada_id);
                  const anulada = String(r.estado_pago ?? "").trim() === "anulado";
                  return (
                    <tr
                      key={r.entrada_id}
                      className={
                        anulada
                          ? "bg-slate-50 text-slate-400 line-through decoration-slate-300"
                          : checked
                            ? "bg-[#4FAEB2]/5"
                            : "hover:bg-slate-50/80"
                      }
                    >
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          aria-label={`Seleccionar orden ${r.numero_orden}`}
                          checked={checked}
                          onChange={() => toggleOne(r.entrada_id)}
                          className="h-4 w-4 rounded border-slate-300"
                        />
                      </td>
                      <td className="px-5 py-3 text-sm font-mono font-semibold text-slate-800">{r.numero_orden}</td>
                      <td className="px-5 py-3 text-sm text-slate-800">{r.sorteo_nombre}</td>
                      <td className="px-5 py-3 text-sm text-slate-800">{r.nombre_participante}</td>
                      <td className="px-5 py-3 text-sm font-mono text-slate-600">{r.documento ?? "—"}</td>
                      <td className="px-5 py-3 text-sm font-mono text-slate-700">{r.whatsapp_numero}</td>
                      <td className="px-5 py-3 text-sm text-slate-700">{r.ciudad ?? "-"}</td>
                      <td className="px-5 py-3 text-sm text-slate-800">{r.cantidad_boletos}</td>
                      <td className="px-5 py-3 text-sm text-right tabular-nums text-slate-800">
                        {formatGs(r.monto_total)}
                        {r.promo_nombre ? (
                          <div className="text-[11px] font-normal text-slate-500 mt-0.5">{r.promo_nombre}</div>
                        ) : null}
                      </td>
                      <td className="px-5 py-3 text-sm font-mono text-slate-800">{r.numeros_cupon.join(", ")}</td>
                      <td className="px-5 py-3 text-sm">
                        <SorteoCuponesImpresionCell
                          sorteoId={r.sorteo_id}
                          entradaId={r.entrada_id}
                          cuponesImpresosAt={r.cupones_impresos_at}
                        />
                      </td>
                      <SorteoCuponesPagoCell entradaId={r.entrada_id} estadoPago={r.estado_pago} />
                      <td className="px-5 py-3 text-sm text-slate-600 whitespace-nowrap">{formatFecha(r.created_at)}</td>
                      <td className="px-5 py-3 text-sm">
                        {r.chat_conversation_id ? (
                          <Link
                            href={`/dashboard/conversaciones?conversationId=${encodeURIComponent(r.chat_conversation_id)}`}
                            className="text-[#4FAEB2] hover:underline"
                          >
                            Abrir
                          </Link>
                        ) : (
                          "—"
                        )}
                      </td>
                      <SorteoCuponesAnularCell
                        entradaId={r.entrada_id}
                        numeroOrden={r.numero_orden}
                        nombreParticipante={r.nombre_participante}
                        cantidadBoletos={r.cantidad_boletos}
                        numerosCupon={r.numeros_cupon}
                        estadoPago={r.estado_pago}
                      />
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
