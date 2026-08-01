import "server-only";

import type { SorteoTicketEntradaDbSnapshot } from "@/lib/sorteos/sorteo-ticket-admin";
import type { EnsureSorteoOrderCreatedData } from "@/lib/sorteos/sorteo-order-from-chat";

function norm(v: string | undefined | null): string {
  return typeof v === "string" ? v.trim() : "";
}

/** Separa cupones desde texto tipo "0020", "0020, 0021", "0020\n0021". */
export function parseCuponesFromString(raw: string | undefined | null): string[] {
  const s = norm(raw);
  if (!s) return [];
  const parts = s
    .split(/[\n,;|]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

const CUPON_FLOW_KEYS = [
  "sorteo_cupones",
  "sorteo_cupones_texto",
  "numeros_cupon_lineas",
  "numeros_cupon",
  "numeros_cupones",
  "cupones",
  "cupones_generados",
  "nros_cupones",
  "nros_cupon",
  "tus_numeros",
  "tus_numeros_generados",
  "numeros_generados",
] as const;

function cuponesFromFlowData(flowData: Record<string, string>): string[] {
  for (const k of CUPON_FLOW_KEYS) {
    const v = parseCuponesFromString(flowData[k]);
    if (v.length > 0) return v;
  }
  return [];
}

function cuponesFromOrderResult(orderResult: EnsureSorteoOrderCreatedData): string[] {
  return orderResult.cupones.map((c) => norm(c.numero_cupon)).filter(Boolean);
}

function cuponesFromPayloadSnapshot(payload: Record<string, unknown> | null | undefined): string[] {
  if (!payload) return [];
  const raw = payload["cupones"];
  if (Array.isArray(raw)) {
    return raw.map((x) => String(x).trim()).filter(Boolean);
  }
  if (typeof raw === "string") {
    return parseCuponesFromString(raw);
  }
  return [];
}

const ORDEN_FLOW_KEYS = [
  "numero_orden",
  "id_orden",
  "ID_orden",
  "sorteo_orden_codigo",
  "numero_de_orden",
  "id_tu_orden",
  "orden_id",
  "order_id",
] as const;

function numeroOrdenFromFlow(flowData: Record<string, string>): string {
  for (const k of ORDEN_FLOW_KEYS) {
    const v = norm(flowData[k]);
    if (v) return v;
  }
  return "";
}

function numeroOrdenFromPayload(payload: Record<string, unknown> | null | undefined): string {
  if (!payload) return "";
  const raw = payload["numero_orden"];
  if (raw == null) return "";
  return String(raw).trim();
}

const SORTEO_NOMBRE_KEYS = ["sorteo_nombre", "sorteo_name", "nombre_sorteo"] as const;

function sorteoNombreFromFlow(flowData: Record<string, string>): string {
  for (const k of SORTEO_NOMBRE_KEYS) {
    const v = norm(flowData[k]);
    if (v) return v;
  }
  return "";
}

function sorteoNombreFromPayload(payload: Record<string, unknown> | null | undefined): string {
  if (!payload) return "";
  const v = payload["sorteo_nombre"];
  return typeof v === "string" ? v.trim() : "";
}

function buildNombreCompletoFromParts(flowData: Record<string, string>): string {
  const n = norm(flowData["nombre"]);
  const a = norm(flowData["apellido"]);
  const joined = [n, a].filter(Boolean).join(" ").trim();
  if (joined) return joined;
  return (
    norm(flowData["nombre_completo"]) ||
    norm(flowData["nombre_y_apellido"]) ||
    norm(flowData["cliente_nombre"]) ||
    norm(flowData["participante"]) ||
    ""
  );
}

function documentoFromFlow(flowData: Record<string, string>): string {
  return (
    norm(flowData["cedula"]) ||
    norm(flowData["cliente_documento"]) ||
    norm(flowData["documento"]) ||
    norm(flowData["ci"]) ||
    norm(flowData["ruc"]) ||
    ""
  );
}

function telefonoFromFlow(flowData: Record<string, string>): string {
  return (
    norm(flowData["telefono"]) ||
    norm(flowData["celular"]) ||
    norm(flowData["whatsapp"]) ||
    norm(flowData["phone"]) ||
    ""
  );
}

function ciudadFromFlow(flowData: Record<string, string>): string {
  return (
    norm(flowData["ciudad"]) ||
    norm(flowData["localidad"]) ||
    norm(flowData["ubicacion"]) ||
    norm(flowData["cliente_ciudad"]) ||
    ""
  );
}

export type SorteoTicketNormalizedRenderFields = {
  clienteNombre: string;
  documento: string;
  telefono: string;
  ciudad: string;
  numeroOrden: string;
  sorteoNombre: string;
  cupones: string[];
};

export type SorteoTicketRenderSourceUsed =
  | "entrada_db"
  | "order_result"
  | "payload_snapshot"
  | "flow_data";

/**
 * Prioridad (ticket PNG):
 * 1. sorteo_entradas + sorteo_cupones (`entradaDb`)
 * 2. orderResult (RPC / buildOrderResultFromEntradaId)
 * 3. payload_snapshot (último delivery u histórico)
 * 4. chat_flow_data / merge
 * 5. catálogo sorteo (solo nombre)
 */
export function buildSorteoTicketRenderData(input: {
  entradaDb: SorteoTicketEntradaDbSnapshot | null;
  flowData: Record<string, string>;
  orderResult: EnsureSorteoOrderCreatedData;
  sorteoNombreCatalog: string;
  payloadSnapshot?: Record<string, unknown> | null;
}): {
  fields: SorteoTicketNormalizedRenderFields;
  sourceUsed: SorteoTicketRenderSourceUsed;
} {
  const { entradaDb, flowData, orderResult, sorteoNombreCatalog, payloadSnapshot } = input;

  let cupones: string[] = [];
  let cupSource: SorteoTicketRenderSourceUsed = "flow_data";
  if (entradaDb && entradaDb.cupones.length > 0) {
    cupones = [...entradaDb.cupones];
    cupSource = "entrada_db";
  } else {
    const fromOrder = cuponesFromOrderResult(orderResult);
    if (fromOrder.length > 0) {
      cupones = fromOrder;
      cupSource = "order_result";
    } else {
      const fromPay = cuponesFromPayloadSnapshot(payloadSnapshot);
      if (fromPay.length > 0) {
        cupones = fromPay;
        cupSource = "payload_snapshot";
      } else {
        cupones = cuponesFromFlowData(flowData);
        cupSource = "flow_data";
      }
    }
  }

  let numeroOrden = "";
  let ordSource: SorteoTicketRenderSourceUsed = "flow_data";
  if (entradaDb?.numeroOrdenStr?.trim()) {
    numeroOrden = entradaDb.numeroOrdenStr.trim();
    ordSource = "entrada_db";
  } else {
    const noFromOrder = orderResult.numeroOrden;
    if (typeof noFromOrder === "number" && Number.isFinite(noFromOrder) && noFromOrder > 0) {
      numeroOrden = String(noFromOrder);
      ordSource = "order_result";
    } else if (noFromOrder != null && String(noFromOrder).trim() !== "") {
      numeroOrden = String(noFromOrder).trim();
      ordSource = "order_result";
    } else {
      const fromPay = numeroOrdenFromPayload(payloadSnapshot);
      if (fromPay) {
        numeroOrden = fromPay;
        ordSource = "payload_snapshot";
      } else {
        numeroOrden = numeroOrdenFromFlow(flowData);
        ordSource = "flow_data";
      }
    }
  }

  let sorteoNombre = "";
  let nomSorteoSource: SorteoTicketRenderSourceUsed = "flow_data";
  if (entradaDb?.sorteoNombre?.trim()) {
    sorteoNombre = entradaDb.sorteoNombre.trim();
    nomSorteoSource = "entrada_db";
  } else if (norm(orderResult.sorteoNombre)) {
    sorteoNombre = norm(orderResult.sorteoNombre);
    nomSorteoSource = "order_result";
  } else {
    const fromPay = sorteoNombreFromPayload(payloadSnapshot);
    if (fromPay) {
      sorteoNombre = fromPay;
      nomSorteoSource = "payload_snapshot";
    } else {
      sorteoNombre = sorteoNombreFromFlow(flowData);
      nomSorteoSource = sorteoNombre ? "flow_data" : "flow_data";
    }
  }
  if (!sorteoNombre) {
    sorteoNombre = norm(sorteoNombreCatalog);
    nomSorteoSource = "flow_data";
  }

  const clienteNombre = (
    entradaDb?.clienteNombre?.trim() ||
    buildNombreCompletoFromParts(flowData)
  ).trim();
  const documento = (entradaDb?.documento?.trim() || documentoFromFlow(flowData)).trim();
  const telefono = (entradaDb?.telefono?.trim() || telefonoFromFlow(flowData)).trim();
  /** Ciudad: se captura en el flujo (nodo `ciudad`) → chat_flow_data. `sorteo_entradas` no la guarda. */
  const ciudad = ciudadFromFlow(flowData).trim();

  const sourceUsed: SorteoTicketRenderSourceUsed = entradaDb
    ? "entrada_db"
    : cupSource === "order_result" ||
        ordSource === "order_result" ||
        nomSorteoSource === "order_result"
      ? "order_result"
      : cupSource === "payload_snapshot" ||
          ordSource === "payload_snapshot" ||
          nomSorteoSource === "payload_snapshot"
        ? "payload_snapshot"
        : "flow_data";

  const fields: SorteoTicketNormalizedRenderFields = {
    clienteNombre,
    documento,
    telefono,
    ciudad,
    numeroOrden,
    sorteoNombre,
    cupones,
  };

  return { fields, sourceUsed };
}

export function buildSorteoTicketRenderLogPayload(input: {
  fields: SorteoTicketNormalizedRenderFields;
  sourceUsed: SorteoTicketRenderSourceUsed;
}): Record<string, unknown> {
  const f = input.fields;
  return {
    sourceUsed: input.sourceUsed,
    numeroOrden: Boolean(f.numeroOrden.trim()),
    cuponesCount: f.cupones.length,
    clienteNombre: Boolean(f.clienteNombre.trim()),
    documento: Boolean(f.documento.trim()),
    telefono: Boolean(f.telefono.trim()),
    ciudad: Boolean(f.ciudad.trim()),
    sorteoNombre: Boolean(f.sorteoNombre.trim()),
  };
}
