import { fetchDataSchemaForEmpresaId, createServiceRoleClientWithDbSchema } from "@/lib/supabase/empresa-data-schema";
import { SUPABASE_APP_SCHEMA, type AppSupabaseClient } from "@/lib/supabase/schema";
import {
  ensureSorteoOrderViaDirectPostgres,
  fetchSorteoRowTicketFieldsFromPg,
  type DirectPgSorteoOk,
} from "@/lib/sorteos/sorteo-order-direct-pg";
import { getChatPostgresConnectionString } from "@/lib/supabase/chat-pg-pool";
import { flowTrace, summarizeFlowDataForTrace } from "@/lib/chat/flow-trace-log";
import {
  SORTEO_COMPROBANTE_ESTADO_VALIDACION_FIELD,
  SORTEO_COMPROBANTE_MOTIVO_VALIDACION_FIELD,
  SORTEO_COMPROBANTE_VALIDACION_ID_FIELD,
} from "@/lib/chat/comprobante-validation-types";
import { parseMoneyPy } from "@/lib/sorteos/parse-money-py";
import {
  propagateSorteoCantidadAliasesIntoCanonical,
  readSorteoCantidadNumericFromMap,
} from "@/lib/sorteos/sorteo-cantidad-fields";

/** Clave estable: mismo comprobante (media) en misma conversación y flujo → una sola orden. */
export function buildSorteoIdempotencyKey(
  conversationId: string,
  flowCode: string,
  mediaId: string
): string {
  return `${conversationId}:${flowCode}:${mediaId}`;
}

function norm(s: string | undefined): string {
  return (s ?? "").trim();
}

/** PostgREST no expone la RPC en cache / función ausente → fallback SQL directo. */
function isRpcUnavailableError(error: { message?: string; code?: string }): boolean {
  const m = (error.message ?? "").toLowerCase();
  const c = error.code ?? "";
  return (
    c === "PGRST202" ||
    m.includes("pgrst202") ||
    m.includes("could not find the function") ||
    m.includes("schema cache") ||
    (m.includes("function") && m.includes("does not exist"))
  );
}

function mapDirectPgOkToRpcRow(d: DirectPgSorteoOk): Record<string, unknown> {
  return {
    ok: true,
    idempotent: d.idempotent,
    entrada: {
      id: d.entradaId,
      numero_orden: d.numeroOrden,
      cantidad_boletos: d.cantidadBoletos,
      monto_total: d.montoTotal,
      promo_nombre: d.promoNombre,
      precio_fuente: d.precioFuente,
      estado_pago: d.estadoPago,
    },
    cupones: d.cupones,
  };
}

const FLOW_SORTEO_LOG = "[flow-sorteo]" as const;

/**
 * Contrato comercial estable por compra (misma flow_session_id).
 * Se escribe al elegir la opción de compra y se relee en comprobante → orden.
 */
export const SORTEO_COMPRA_FIELD = {
  snapCantidad: "sorteo_snap_cantidad",
  snapOpcionLabel: "sorteo_snap_opcion_label",
  snapMonto: "sorteo_snap_monto",
  snapPromoNombre: "sorteo_snap_promo_nombre",
  snapResumen: "sorteo_snap_resumen",
  cantidad: "cantidad",
  monto: "monto",
  optionLabelEn: "option_label",
  optionLabelEs: "opcion_label",
  promoNombre: "promo_nombre",
  resumenCompra: "resumen_compra",
} as const;

export type SorteoInteractiveOptionInput = {
  label: string;
  option_value: string;
  option_payload?: unknown;
};

function mergeEntryMap(entries: [string, string][]): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of entries) {
    const key = k.trim();
    if (!key) continue;
    out.set(key, v);
  }
  return out;
}

function getEntryCI(entries: [string, string][], name: string): string {
  const nl = name.toLowerCase();
  for (const [k, v] of entries) {
    if (k.trim().toLowerCase() === nl) return norm(v);
  }
  return "";
}

function getFirstEntry(entries: [string, string][], names: readonly string[]): string {
  for (const n of names) {
    const v = getEntryCI(entries, n);
    if (v) return v;
  }
  return "";
}

/**
 * Tras armar entries desde option_payload + augmentCantidad + augmentPricing + dedupe:
 * fija snapshot y alias canónicos para que resumen, confirmación y comprobante lean lo mismo.
 */
export function applySorteoInteractiveCommercialContract(
  entries: [string, string][],
  selected: SorteoInteractiveOptionInput
): [string, string][] {
  const qtyFromEntries = getFirstEntry(entries, [
    SORTEO_COMPRA_FIELD.snapCantidad,
    "sorteo_cantidad_opcion",
    "cantidad_boletos",
    "cantidad_boletas",
    "cantidad_numeros",
    "cantidad_entradas",
    SORTEO_COMPRA_FIELD.cantidad,
    "boletos",
    "boletas",
    "numeros",
    "entradas",
    "qty",
    "quantity",
  ]);

  let qty: number | null = null;
  if (qtyFromEntries) {
    const n = Number(qtyFromEntries.replace(",", "."));
    if (Number.isFinite(n) && n >= 1) qty = Math.trunc(n);
  }

  const op =
    selected.option_payload && typeof selected.option_payload === "object" && !Array.isArray(selected.option_payload)
      ? (selected.option_payload as Record<string, unknown>)
      : null;

  if (qty == null && op) {
    for (const k of [
      "cantidad",
      "cantidad_boletos",
      "cantidad_boletas",
      "cantidad_numeros",
      "cantidad_entradas",
      "qty",
      "quantity",
      "boletos",
      "boletas",
      "numeros",
      "entradas",
      "QTY",
      "Cantidad",
    ]) {
      const raw = op[k];
      if (raw == null) continue;
      const n = Number(String(raw).trim().replace(",", "."));
      if (Number.isFinite(n) && n >= 1) {
        qty = Math.trunc(n);
        break;
      }
    }
  }

  if (qty == null) {
    const ov = norm(selected.option_value);
    if (ov) {
      const n = Number(ov.replace(",", "."));
      if (Number.isFinite(n) && n >= 1) qty = Math.trunc(n);
      else {
        const lead = ov.match(/^(\d+)/);
        if (lead) {
          const n2 = Number(lead[1]);
          if (Number.isFinite(n2) && n2 >= 1) qty = Math.trunc(n2);
        }
      }
    }
  }

  if (qty == null) {
    qty = extractQtyFromFlowText(selected.label);
  }

  if (qty == null) {
    const textHint = getFirstEntry(entries, [
      SORTEO_COMPRA_FIELD.optionLabelEs,
      SORTEO_COMPRA_FIELD.optionLabelEn,
      "producto",
      "combo",
      "opcion",
      "descripcion",
    ]);
    qty = extractQtyFromFlowText(textHint);
  }

  const label =
    norm(selected.label) ||
    getFirstEntry(entries, [SORTEO_COMPRA_FIELD.optionLabelEs, SORTEO_COMPRA_FIELD.optionLabelEn]);

  const montoRaw = getFirstEntry(entries, [
    SORTEO_COMPRA_FIELD.snapMonto,
    "sorteo_monto_opcion",
    "monto_compra",
    "monto_promocional",
    SORTEO_COMPRA_FIELD.monto,
  ]);

  const promoNombre = getFirstEntry(entries, [
    SORTEO_COMPRA_FIELD.snapPromoNombre,
    SORTEO_COMPRA_FIELD.promoNombre,
    "promo",
    "nombre_promo",
  ]);

  const out = mergeEntryMap(entries);

  if (qty != null) {
    const s = String(qty);
    out.set(SORTEO_COMPRA_FIELD.snapCantidad, s);
    out.set(SORTEO_COMPRA_FIELD.cantidad, s);
    out.set("cantidad_boletos", s);
    out.set("sorteo_cantidad_opcion", s);
  }

  if (label) {
    out.set(SORTEO_COMPRA_FIELD.snapOpcionLabel, label);
    out.set(SORTEO_COMPRA_FIELD.optionLabelEs, label);
    out.set(SORTEO_COMPRA_FIELD.optionLabelEn, label);
  }

  if (montoRaw) {
    out.set(SORTEO_COMPRA_FIELD.snapMonto, montoRaw);
    const parsed = parseMoneyPy(montoRaw);
    if (parsed != null && parsed > 0) {
      const rounded = String(Math.round(parsed));
      const pf = norm(out.get("precio_fuente"));
      if (!pf) out.set("precio_fuente", "promo");
      out.set(SORTEO_COMPRA_FIELD.monto, rounded);
      out.set("monto_compra", rounded);
      out.set("monto_promocional", rounded);
      out.set("sorteo_monto_opcion", rounded);
    }
  }

  if (promoNombre) {
    out.set(SORTEO_COMPRA_FIELD.snapPromoNombre, promoNombre);
    out.set(SORTEO_COMPRA_FIELD.promoNombre, promoNombre);
  }

  const resumenParts: string[] = [];
  if (label) resumenParts.push(label);
  if (qty != null) resumenParts.push(`${qty} boletos`);
  if (montoRaw) resumenParts.push(`Gs ${montoRaw}`);
  const resumen = resumenParts.join(" · ");
  if (resumen) {
    out.set(SORTEO_COMPRA_FIELD.snapResumen, resumen);
    out.set(SORTEO_COMPRA_FIELD.resumenCompra, resumen);
  }

  if (qty == null) {
    flowTrace("sorteo_commercial_contract_qty_unresolved", {
      option_label: label || null,
      option_value: norm(selected.option_value) || null,
      payload_keys: op ? Object.keys(op).sort() : [],
      event: "interactive_option_post_contract",
    });
  }

  return [...out.entries()];
}

/** Copia snapshot → claves de trabajo si el flujo dejó huecos (p. ej. tras nodos intermedios). */
function mergeSnapshotKeysIntoPrepared(data: Record<string, string>): Record<string, string> {
  const d = { ...data };
  const sq = norm(d[SORTEO_COMPRA_FIELD.snapCantidad]);
  if (sq) {
    if (!norm(d[SORTEO_COMPRA_FIELD.cantidad])) d[SORTEO_COMPRA_FIELD.cantidad] = sq;
    if (!norm(d.cantidad_boletos)) d.cantidad_boletos = sq;
    if (!norm(d.sorteo_cantidad_opcion)) d.sorteo_cantidad_opcion = sq;
  }
  const sl = norm(d[SORTEO_COMPRA_FIELD.snapOpcionLabel]);
  if (sl) {
    if (!norm(d[SORTEO_COMPRA_FIELD.optionLabelEs])) d[SORTEO_COMPRA_FIELD.optionLabelEs] = sl;
    if (!norm(d[SORTEO_COMPRA_FIELD.optionLabelEn])) d[SORTEO_COMPRA_FIELD.optionLabelEn] = sl;
  }
  const sm = norm(d[SORTEO_COMPRA_FIELD.snapMonto]);
  if (sm) {
    const parsed = parseMoneyPy(sm);
    if (parsed != null && parsed > 0) {
      const rounded = String(Math.round(parsed));
      if (!norm(d.precio_fuente)) d.precio_fuente = "promo";
      if (!norm(d[SORTEO_COMPRA_FIELD.monto])) d[SORTEO_COMPRA_FIELD.monto] = rounded;
      if (!norm(d.monto_compra)) d.monto_compra = rounded;
      if (!norm(d.sorteo_monto_opcion)) d.sorteo_monto_opcion = rounded;
    }
  }
  const sp = norm(d[SORTEO_COMPRA_FIELD.snapPromoNombre]);
  if (sp && !norm(d[SORTEO_COMPRA_FIELD.promoNombre])) d[SORTEO_COMPRA_FIELD.promoNombre] = sp;
  const sr = norm(d[SORTEO_COMPRA_FIELD.snapResumen]);
  if (sr && !norm(d[SORTEO_COMPRA_FIELD.resumenCompra])) d[SORTEO_COMPRA_FIELD.resumenCompra] = sr;
  return d;
}

/**
 * Motivo legible cuando `parseSorteoParticipantFromFlowData` devuelve null (diagnóstico en logs).
 */
export function explainParseSorteoParticipantFailure(data: Record<string, string>): string {
  let foundKey: string | undefined;
  let rawVal: string | undefined;
  let qtyValid = readSorteoCantidadNumericFromMap(data) != null;
  if (!qtyValid) {
    const qtyKeys = [
      SORTEO_COMPRA_FIELD.snapCantidad,
      "sorteo_cantidad_opcion",
      "cantidad_boletos",
      SORTEO_COMPRA_FIELD.cantidad,
      "boletos",
      "qty",
    ] as const;
    for (const k of qtyKeys) {
      const v = norm(data[k]);
      if (!v) continue;
      foundKey = k;
      rawVal = v;
      const n = Number(v);
      if (Number.isFinite(n) && n >= 1) {
        qtyValid = true;
        break;
      }
    }
  }
  if (!qtyValid) {
    for (const k of [
      "sorteo_snap_resumen",
      SORTEO_COMPRA_FIELD.resumenCompra,
      "producto",
      "opcion_label",
      "option_label",
      "combo",
      "opcion",
      "descripcion",
    ] as const) {
      const q = extractQtyFromFlowText(data[k]);
      if (q != null) {
        qtyValid = true;
        break;
      }
    }
  }
  if (!qtyValid) {
    if (!foundKey) {
      return "cantidad: ninguna clave numérica ni texto con cantidad (producto/opcion_label/etc.)";
    }
    return `cantidad: clave "${foundKey}"="${rawVal}" no es número entero >= 1`;
  }
  const nombreCompleto =
    [
      norm(data["nombre"]) || norm(data["primer_nombre"]) || norm(data["primer nombre"]),
      norm(data["apellido"]) || norm(data["primer_apellido"]) || norm(data["primer apellido"]),
    ]
      .filter(Boolean)
      .join(" ")
      .trim() ||
    norm(data["nombre_y_apellido"]) ||
    norm(data["nombre_completo"]);
  if (!nombreCompleto) {
    return "nombre: falta (nombre/apellido o primer_nombre/primer_apellido) | nombre_y_apellido | nombre_completo";
  }
  return "desconocido";
}

/** Cantidad desde texto tipo "3 boletos", "Combo 5", "5", etc. */
export function extractQtyFromFlowText(s: string | undefined): number | null {
  const t = norm(s);
  if (!t) return null;
  const direct = Number(t.replace(",", "."));
  if (Number.isFinite(direct) && direct >= 1) return Math.trunc(direct);
  for (const re of [
    /^(\d+)\s*bolet/i,
    /^(\d+)\s*boleta/i,
    /^(\d+)\s*entrada/i,
    /^(\d+)\s*ticket/i,
    /(\d+)\s*bolet/i,
    /^(\d+)\b/,
  ]) {
    const m = t.match(re);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n >= 1) return Math.trunc(n);
    }
  }
  return null;
}

/**
 * Si el flujo guardó `Nombre`, `Cédula`, etc., expone también `nombre`, `cedula` para el parser.
 */
export function expandFlowDataCanonicalKeys(data: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = { ...data };
  for (const [k, v] of Object.entries(data)) {
    const tk = k.trim();
    if (!tk) continue;
    const val = String(v ?? "");
    if (!norm(val)) continue;
    const lk = tk.toLowerCase();
    if (!norm(out[lk])) out[lk] = val;
  }
  return out;
}

function flowDataHasResolvableQty(data: Record<string, string>): boolean {
  if (readSorteoCantidadNumericFromMap(data) != null) return true;
  const qtyKeys = [
    SORTEO_COMPRA_FIELD.snapCantidad,
    "sorteo_cantidad_opcion",
    "cantidad_boletos",
    SORTEO_COMPRA_FIELD.cantidad,
    "boletos",
    "qty",
  ] as const;
  for (const k of qtyKeys) {
    const v = norm(data[k]);
    if (!v) continue;
    const n = Number(v);
    if (Number.isFinite(n) && n >= 1) return true;
  }
  for (const k of [
    "sorteo_snap_resumen",
    SORTEO_COMPRA_FIELD.resumenCompra,
    "producto",
    "opcion_label",
    "option_label",
    "combo",
    "opcion",
    "descripcion",
  ] as const) {
    if (extractQtyFromFlowText(data[k]) != null) return true;
  }
  return false;
}

/**
 * Si no hay cantidad inferible del flujo, usa **1** como último recurso (evita órdenes vacías).
 */
export function applyCantidadFallbackOneIfMissing(data: Record<string, string>): Record<string, string> {
  let out = enrichFlowDataForSorteoParse({ ...data });
  if (flowDataHasResolvableQty(out)) return out;
  out = { ...out };
  out[SORTEO_COMPRA_FIELD.cantidad] = "1";
  out[SORTEO_COMPRA_FIELD.snapCantidad] = "1";
  out["cantidad_boletos"] = "1";
  out["sorteo_cantidad_opcion"] = "1";
  return out;
}

/**
 * Completa cantidad desde el texto visible de la opción si el payload no trajo cantidad explícita.
 */
export function enrichFlowDataForSorteoParse(data: Record<string, string>): Record<string, string> {
  if (flowDataHasResolvableQty(data)) return data;
  const out = { ...data };
  for (const k of [
    "sorteo_snap_resumen",
    SORTEO_COMPRA_FIELD.resumenCompra,
    "opcion_label",
    "option_label",
    "producto",
    "combo",
    "opcion",
    "descripcion",
  ] as const) {
    const q = extractQtyFromFlowText(out[k]);
    if (q != null) {
      out["sorteo_cantidad_opcion"] = String(q);
      out[SORTEO_COMPRA_FIELD.cantidad] = String(q);
      out[SORTEO_COMPRA_FIELD.snapCantidad] = String(q);
      break;
    }
  }
  return out;
}

export function prepareFlowDataForSorteoOrder(data: Record<string, string>): Record<string, string> {
  let d = expandFlowDataCanonicalKeys({ ...data });
  d = propagateSorteoCantidadAliasesIntoCanonical(d);
  d = mergeSnapshotKeysIntoPrepared(d);
  d = enrichFlowDataForSorteoParse(d);
  d = mergeSnapshotKeysIntoPrepared(d);
  return d;
}

/**
 * Lee campos típicos guardados vía save_as_field en el flujo (nombres flexibles).
 */
export function parseSorteoParticipantFromFlowData(data: Record<string, string>): {
  nombre_completo: string;
  cedula: string;
  ciudad: string;
  cantidad_boletos: number;
} | null {
  let qty = NaN;
  const fromMap = readSorteoCantidadNumericFromMap(data);
  if (fromMap != null) qty = fromMap;
  if (!Number.isFinite(qty) || qty < 1) {
    for (const k of [
      "sorteo_snap_resumen",
      SORTEO_COMPRA_FIELD.resumenCompra,
      "producto",
      "opcion_label",
      "option_label",
      "combo",
      "opcion",
      "descripcion",
    ]) {
      const q = extractQtyFromFlowText(data[k]);
      if (q != null) {
        qty = q;
        break;
      }
    }
  }
  if (!Number.isFinite(qty) || qty < 1) return null;

  const nombrePart =
    norm(data["nombre"]) ||
    norm(data["primer_nombre"]) ||
    norm(data["primer nombre"]);
  const apellidoPart =
    norm(data["apellido"]) ||
    norm(data["primer_apellido"]) ||
    norm(data["primer apellido"]);
  const fromNombreApellido = [nombrePart, apellidoPart].filter(Boolean).join(" ").trim();
  const nombreCompleto =
    fromNombreApellido ||
    norm(data["nombre_y_apellido"]) ||
    norm(data["nombre_completo"]);

  if (!nombreCompleto) return null;

  return {
    nombre_completo: nombreCompleto,
    cedula:
      norm(data["cedula"]) ||
      norm(data["cédula"]) ||
      norm(data["documento"]) ||
      norm(data["nro_documento"]) ||
      norm(data["numero_documento"]) ||
      norm(data["ci"]),
    ciudad: norm(data["ciudad"]),
    cantidad_boletos: qty,
  };
}

const PRECIO_REG_KEYS = ["precio_regular", "precio_regular_referencia", "precio_lista"] as const;

function parseFirstMoney(
  data: Record<string, string>,
  keys: readonly string[]
): number | null {
  for (const k of keys) {
    const v = norm(data[k]);
    if (!v) continue;
    const n = parseMoneyPy(v);
    if (n != null && n > 0) return Math.round(n);
  }
  return null;
}

/**
 * Monto y metadatos comerciales guardados en chat_flow_data al elegir una opción (JSON estructurado).
 *
 * No usa el campo genérico `monto` salvo si `precio_fuente` es `promo`, para que pasos del flujo
 * que rellenan `{{monto}}` con el total de lista no pisen el precio promocional guardado en
 * `monto_compra` / `monto_promocional`.
 */
export function parseSorteoPricingFromFlowData(data: Record<string, string>): {
  montoCompra: number | null;
  promoNombre: string;
  precioRegularReferencia: number | null;
} {
  const pf = norm(data["precio_fuente"]).toLowerCase();
  let montoCompra =
    parseFirstMoney(data, [
      SORTEO_COMPRA_FIELD.snapMonto,
      "sorteo_monto_opcion",
      "monto_compra",
      "monto_promocional",
    ]) ??
    null;
  if (montoCompra == null && pf === "promo") {
    montoCompra = parseFirstMoney(data, ["monto"]);
  }
  const promoNombre = norm(data["promo_nombre"]);
  let precioRegularReferencia: number | null = null;
  for (const k of PRECIO_REG_KEYS) {
    const v = norm(data[k]);
    if (!v) continue;
    const n = parseMoneyPy(v);
    if (n != null && n > 0) {
      precioRegularReferencia = Math.round(n);
      break;
    }
  }
  return { montoCompra, promoNombre, precioRegularReferencia };
}

export async function getSorteoIdForChatFlow(
  supabase: AppSupabaseClient,
  empresaId: string,
  flowCode: string
): Promise<string | null> {
  const fc = flowCode.trim();
  if (!fc) return null;
  const { data, error } = await supabase
    .from("chat_flows")
    .select("sorteo_id, updated_at")
    .eq("empresa_id", empresaId)
    .eq("flow_code", fc)
    .order("updated_at", { ascending: false })
    .limit(10);
  if (error || !data?.length) return null;
  const row = data.find((r) => {
    const sid = (r as { sorteo_id?: string | null }).sorteo_id;
    return typeof sid === "string" && sid.length > 0;
  }) as { sorteo_id?: string | null } | undefined;
  const sid = row?.sorteo_id;
  return typeof sid === "string" ? sid : null;
}

export type EnsureSorteoOrderFromChatInput = {
  empresaId: string;
  conversationId: string;
  flowCode: string;
  /** Sesión activa al armar la orden (solo traza; no altera RPC). */
  flowSessionId?: string | null;
  mediaId: string;
  whatsappNumero: string;
  comprobanteUrl: string;
  /** Mapa field_name → field_value desde chat_flow_data */
  flowData: Record<string, string>;
};

/** Datos reales devueltos tras crear o reutilizar orden + cupones (para `chat_flow_data` y plantillas `{{...}}`). */
export type EnsureSorteoOrderCreatedData = {
  idempotent: boolean;
  entradaId: string;
  numeroOrden: number;
  cupones: { id: string; numero_cupon: string }[];
  sorteoId: string;
  sorteoNombre: string;
  cantidadBoletos: number;
  montoTotal: number;
  promoNombre: string;
  precioFuente: string;
};

export type EnsureSorteoOrderFromChatResult =
  | {
      ok: true;
      skipped: true;
      reason: string;
      comprobanteEstado?: string;
      /** Copia de `sorteo_comprobante_motivo_validacion` en flow_data (si existe). */
      comprobanteMotivo?: string;
    }
  | ({ ok: true; skipped: false } & EnsureSorteoOrderCreatedData)
  | { ok: false; message: string };

/** Nombres de campo en `chat_flow_data` para el nodo de cierre tras comprobante (placeholders en texto). */
export const CHAT_FLOW_SORTEO_CONTEXT_FIELDS = {
  sorteo_entrada_id: "sorteo_entrada_id",
  numero_orden: "numero_orden",
  /** Cupones separados por coma (una línea) */
  numeros_cupon: "numeros_cupon",
  /** Un cupón por línea (mensaje multilínea en WhatsApp) */
  numeros_cupon_lineas: "numeros_cupon_lineas",
  sorteo_nombre: "sorteo_nombre",
  /** Cantidad de boletos de la orden (desde fila `sorteo_entradas`, no del paso previo del flujo) */
  orden_cantidad_boletos: "orden_cantidad_boletos",
  /** Monto total persistido en la orden (promo o lista) */
  orden_monto_total: "orden_monto_total",
  /** Promo asociada a la orden (si hubo) */
  sorteo_promo_nombre: "sorteo_promo_nombre",
  precio_fuente_orden: "precio_fuente_orden",
} as const;

/**
 * Filas para upsert en `chat_flow_data` después de `ensureSorteoOrderFromChat` exitoso.
 * Orden: solo llamar cuando la orden ya exista en DB.
 */
function sorteoOrderContextPairs(data: EnsureSorteoOrderCreatedData): [string, string][] {
  const nums = data.cupones
    .map((c) => c.numero_cupon)
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const comma = nums.join(", ");
  const lines = nums.join("\n");
  const no = String(data.numeroOrden);
  const F = CHAT_FLOW_SORTEO_CONTEXT_FIELDS;
  const pairs: [string, string][] = [
    [F.sorteo_entrada_id, data.entradaId],
    [F.numero_orden, no],
    ["sorteo_orden_codigo", no],
    [F.numeros_cupon, comma],
    [F.numeros_cupon_lineas, lines],
    ["sorteo_cupones_texto", comma],
    ["sorteo_cupones", comma],
    ["cantidad", String(data.cantidadBoletos)],
    [F.sorteo_nombre, data.sorteoNombre],
    [F.orden_cantidad_boletos, String(data.cantidadBoletos)],
    [F.orden_monto_total, String(data.montoTotal)],
    [F.precio_fuente_orden, data.precioFuente],
    ["id_orden", no],
    ["ID_orden", no],
    ["id_tu_orden", no],
    ["orden_id", no],
    ["order_id", no],
    ["id_de_orden", no],
    ["numero_de_orden", no],
    ["numeros_generados", comma],
    ["tus_numeros_generados", comma],
    ["tus_numeros", comma],
    ["numeros_cupones", comma],
    ["cupones", comma],
    ["cupones_generados", comma],
    ["nros_cupon", comma],
    ["nros_cupones", comma],
    ["cupones_lineas", lines],
  ];
  if (data.promoNombre.trim()) {
    pairs.push([F.sorteo_promo_nombre, data.promoNombre]);
  }
  return pairs;
}

export function buildChatFlowDataUpsertsForSorteoOrder(
  empresaId: string,
  conversationId: string,
  flowCode: string,
  flowSessionId: string,
  data: EnsureSorteoOrderCreatedData
): Array<{
  empresa_id: string;
  conversation_id: string;
  flow_code: string;
  flow_session_id: string;
  field_name: string;
  field_value: string;
}> {
  const fc = flowCode.trim();
  const sid = flowSessionId.trim();
  return sorteoOrderContextPairs(data).map(([field_name, field_value]) => ({
    empresa_id: empresaId,
    conversation_id: conversationId,
    flow_code: fc,
    flow_session_id: sid,
    field_name,
    field_value,
  }));
}

/**
 * Comprobante persistido al recibir imagen; la orden se arma en confirmación leyendo estos campos.
 */
export const SORTEO_COMPROBANTE_MEDIA_ID_FIELD = "sorteo_comprobante_media_id";
export const SORTEO_COMPROBANTE_URL_FIELD = "sorteo_comprobante_url";

export { optionPayloadFinalizesSorteoOrder } from "@/lib/sorteos/sorteo-option-payload";

export function resolveComprobanteUrlFromFlowData(data: Record<string, string>): string {
  const u = norm(data[SORTEO_COMPROBANTE_URL_FIELD]);
  if (u) return u;
  for (const [k, v] of Object.entries(data)) {
    const kn = k.toLowerCase();
    const val = norm(v);
    if (!val) continue;
    if ((kn.includes("comprobante") || kn.includes("voucher")) && /^https?:\/\//i.test(val)) return val;
  }
  return "";
}

/**
 * Completa URL/media del comprobante desde `chat_comprobante_validaciones` cuando hay `sorteo_comprobante_validacion_id`
 * pero faltan columnas en `chat_flow_data` (p. ej. tras saltos de nodo o sesión).
 */
export async function mergeComprobanteFromValidationRowIntoFlowData(
  supabase: AppSupabaseClient,
  empresaId: string,
  flowData: Record<string, string>
): Promise<Record<string, string>> {
  const url = resolveComprobanteUrlFromFlowData(flowData);
  const mediaId = norm(flowData[SORTEO_COMPROBANTE_MEDIA_ID_FIELD]);
  if (url && mediaId) return flowData;
  const vid = norm(flowData[SORTEO_COMPROBANTE_VALIDACION_ID_FIELD]);
  if (!vid || !/^[0-9a-f-]{36}$/i.test(vid)) return flowData;
  const { data: row, error } = await supabase
    .from("chat_comprobante_validaciones")
    .select("comprobante_url, comprobante_media_id")
    .eq("id", vid)
    .eq("empresa_id", empresaId)
    .maybeSingle();
  if (error || !row) return flowData;
  const out: Record<string, string> = { ...flowData };
  const ru = norm((row as { comprobante_url?: string | null }).comprobante_url ?? "");
  const rm = norm((row as { comprobante_media_id?: string | null }).comprobante_media_id ?? "");
  if (!url && ru) out[SORTEO_COMPROBANTE_URL_FIELD] = ru;
  if (!mediaId && rm) out[SORTEO_COMPROBANTE_MEDIA_ID_FIELD] = rm;
  return out;
}

/**
 * Cierra compra sorteo + cupones (RPC idempotente) cuando el cliente ya confirmó y existen datos + comprobante en sesión.
 */
export async function finalizeSorteoOrderFromConfirmedFlowData(
  supabase: AppSupabaseClient,
  input: {
    empresaId: string;
    conversationId: string;
    flowCode: string;
    flowSessionId: string;
    whatsappNumero: string;
    flowData: Record<string, string>;
  }
): Promise<EnsureSorteoOrderFromChatResult> {
  const mergedIn = await mergeComprobanteFromValidationRowIntoFlowData(
    supabase,
    input.empresaId,
    input.flowData
  );
  const url = resolveComprobanteUrlFromFlowData(mergedIn);
  const mediaId = norm(mergedIn[SORTEO_COMPROBANTE_MEDIA_ID_FIELD]);
  if (!url || !mediaId) {
    return { ok: true, skipped: true, reason: "sin_comprobante_en_sesion" };
  }
  const estVal = norm(mergedIn[SORTEO_COMPROBANTE_ESTADO_VALIDACION_FIELD]);
  const motVal = norm(mergedIn[SORTEO_COMPROBANTE_MOTIVO_VALIDACION_FIELD]);
  const estadoPermiteCierre =
    !estVal || estVal === "valido" || estVal === "aprobado_manual";
  if (estVal && !estadoPermiteCierre) {
    return {
      ok: true,
      skipped: true,
      reason: "comprobante_no_validado",
      comprobanteEstado: estVal,
      comprobanteMotivo: motVal || undefined,
    };
  }
  flowTrace("finalize_sorteo_order_invoke", {
    conversation_id: input.conversationId,
    flow_session_id: input.flowSessionId,
    flow_code: input.flowCode.trim(),
    has_comprobante_url: true,
    has_media_id: true,
  });
  return ensureSorteoOrderFromChat(supabase, {
    empresaId: input.empresaId,
    conversationId: input.conversationId,
    flowCode: input.flowCode,
    flowSessionId: input.flowSessionId,
    mediaId,
    whatsappNumero: input.whatsappNumero,
    comprobanteUrl: url,
    flowData: mergedIn,
  });
}

/** Texto por defecto si `chat_flows.sorteo_datos_incompletos_message` está vacío. */
export const SORTEO_DATOS_INCOMPLETOS_DEFAULT_MESSAGE =
  "Faltan datos para cerrar la compra. Revisá el resumen y tocá Confirmar de nuevo.";

export async function getSorteoDatosIncompletosMessage(
  supabase: AppSupabaseClient,
  empresaId: string,
  flowCode: string
): Promise<string> {
  const fc = flowCode.trim();
  if (!fc) return SORTEO_DATOS_INCOMPLETOS_DEFAULT_MESSAGE;
  const { data, error } = await supabase
    .from("chat_flows")
    .select("sorteo_datos_incompletos_message")
    .eq("empresa_id", empresaId)
    .eq("flow_code", fc)
    .maybeSingle();
  if (error || !data) return SORTEO_DATOS_INCOMPLETOS_DEFAULT_MESSAGE;
  const raw = (data as { sorteo_datos_incompletos_message?: string | null })
    .sorteo_datos_incompletos_message;
  const t = typeof raw === "string" ? raw.trim() : "";
  return t.length > 0 ? t : SORTEO_DATOS_INCOMPLETOS_DEFAULT_MESSAGE;
}

/**
 * Variables para `{{...}}` en el nodo que sigue al comprobante.
 * Incluye alias típicos de plantillas; el merge en memoria evita placeholders vacíos
 * por lag de lectura tras el upsert.
 */
export function buildSorteoOrderFlowVarOverrides(
  data: EnsureSorteoOrderCreatedData
): Record<string, string> {
  return Object.fromEntries(sorteoOrderContextPairs(data));
}

/**
 * Crea orden (sorteo_entradas) + cupones vía RPC atómica e idempotente.
 * Si el flow no tiene sorteo_id o faltan datos, hace skip sin error.
 * No exige `empresa_modulos.sorteos`: el vínculo explícito chat_flows.sorteo_id basta.
 */
export async function ensureSorteoOrderFromChat(
  supabase: AppSupabaseClient,
  input: EnsureSorteoOrderFromChatInput
): Promise<EnsureSorteoOrderFromChatResult> {
  const flowCode = input.flowCode.trim();
  const flowData = prepareFlowDataForSorteoOrder(input.flowData);
  const traceFd = summarizeFlowDataForTrace(flowData);
  flowTrace("ensure_sorteo_order_enter", {
    conversation_id: input.conversationId,
    empresa_id: input.empresaId,
    flow_code: flowCode,
    flow_session_id_context: input.flowSessionId?.trim() ?? null,
    media_id: input.mediaId,
    flow_data_keys: traceFd.keys,
    flow_data_samples: traceFd.samples ?? null,
  });
  console.info(FLOW_SORTEO_LOG, "ensureSorteoOrderFromChat_invoke", {
    conversationId: input.conversationId,
    flowCode,
    empresaId: input.empresaId,
    mediaId: input.mediaId,
    flowDataKeysRaw: Object.keys(input.flowData),
    flowDataKeysPrepared: Object.keys(flowData),
    chat_flow_data: flowData,
  });

  const sorteoId = await getSorteoIdForChatFlow(supabase, input.empresaId, flowCode);
  if (!sorteoId) {
    flowTrace("sorteo_order_skipped", {
      conversation_id: input.conversationId,
      empresa_id: input.empresaId,
      flow_code: flowCode,
      flow_session_id_context: input.flowSessionId?.trim() ?? null,
      reason: "flow_sin_sorteo_id",
    });
    console.warn(FLOW_SORTEO_LOG, "ensureSorteoOrderFromChat_outcome", {
      path: "skipped",
      reason: "flow_sin_sorteo_id",
      sorteo_id: null,
      conversationId: input.conversationId,
      flowCode,
      archivo: "src/lib/sorteos/sorteo-order-from-chat.ts",
      condicion: "getSorteoIdForChatFlow devolvió null (chat_flows.sorteo_id vacío o sin fila)",
    });
    return { ok: true, skipped: true, reason: "flow_sin_sorteo_id" };
  }

  const { describeFlowCaptureCompletenessForLogs } = await import("@/lib/sorteos/sorteo-flow-capture-order");
  const completeness = await describeFlowCaptureCompletenessForLogs(
    supabase,
    input.empresaId,
    flowCode,
    flowData
  );
  if (completeness?.firstIncomplete) {
    console.info("[sorteo-close][required-fields-check]", {
      conversation_id: input.conversationId,
      flow_session_id: input.flowSessionId?.trim() ?? null,
      required_fields: completeness.required_fields,
      missing_fields: completeness.missing_fields,
      blocked_node_code: "ensure_sorteo_order",
      first_incomplete_node: completeness.firstIncomplete.nodeCode,
    });
    return { ok: true, skipped: true, reason: "datos_flujo_incompletos" };
  }

  const participant = parseSorteoParticipantFromFlowData(flowData);
  if (!participant) {
    const parseDetail = explainParseSorteoParticipantFailure(flowData);
    console.warn(FLOW_SORTEO_LOG, "ensureSorteoOrderFromChat_outcome", {
      path: "skipped",
      reason: "datos_flujo_incompletos",
      parseDetail,
      conversationId: input.conversationId,
      flowCode,
      sorteo_id: sorteoId,
      chat_flow_data: flowData,
      archivo: "src/lib/sorteos/sorteo-order-from-chat.ts",
      condicion: "parseSorteoParticipantFromFlowData === null",
    });
    return { ok: true, skipped: true, reason: "datos_flujo_incompletos" };
  }

  const pricing = parseSorteoPricingFromFlowData(flowData);
  console.info(FLOW_SORTEO_LOG, "ensureSorteoOrderFromChat_pricing", {
    conversationId: input.conversationId,
    flowCode,
    montoCompra: pricing.montoCompra,
    promoNombre: pricing.promoNombre,
    tiene_sorteo_monto_opcion: Boolean(flowData["sorteo_monto_opcion"]?.trim()),
    tiene_precio_fuente: Boolean(flowData["precio_fuente"]?.trim()),
  });

  const idempotencyKey = buildSorteoIdempotencyKey(
    input.conversationId,
    flowCode,
    input.mediaId
  );

  const rpcPayload: Record<string, unknown> = {
    empresa_id: input.empresaId,
    sorteo_id: sorteoId,
    chat_conversation_id: input.conversationId,
    flow_code: flowCode,
    idempotency_key: idempotencyKey,
    whatsapp_numero: input.whatsappNumero,
    nombre_completo: participant.nombre_completo,
    cedula: participant.cedula || "",
    ciudad: participant.ciudad || "",
    cantidad_boletos: participant.cantidad_boletos,
    comprobante_url: input.comprobanteUrl,
    validado_por: "chat_flow",
  };
  if (pricing.montoCompra != null) {
    rpcPayload.monto_compra = pricing.montoCompra;
  }
  if (pricing.promoNombre) {
    rpcPayload.promo_nombre = pricing.promoNombre;
  }
  if (pricing.precioRegularReferencia != null) {
    rpcPayload.precio_regular_referencia = pricing.precioRegularReferencia;
  }

  let revendedorId: string | null = null;
  let codigoReferidoSnap: string | null = null;
  const sidTrim = input.flowSessionId?.trim() ?? null;
  if (sidTrim) {
    const { data: sRef } = await supabase
      .from("chat_flow_sessions")
      .select("revendedor_id, codigo_referido_snapshot")
      .eq("id", sidTrim)
      .eq("empresa_id", input.empresaId)
      .maybeSingle();
    const rid = (sRef as { revendedor_id?: string | null } | null)?.revendedor_id?.trim();
    const csnap = (sRef as { codigo_referido_snapshot?: string | null } | null)?.codigo_referido_snapshot?.trim();
    if (rid) {
      rpcPayload.revendedor_id = rid;
      rpcPayload.codigo_referido = csnap ?? "";
      revendedorId = rid;
      codigoReferidoSnap = csnap ?? null;
    }
  }

  const dataSchema = await fetchDataSchemaForEmpresaId(input.empresaId);
  const hasDirectPg = Boolean(getChatPostgresConnectionString());

  const directOrderArgs = {
    schema: dataSchema,
    empresaId: input.empresaId,
    sorteoId,
    conversationId: input.conversationId,
    flowCode,
    idempotencyKey,
    whatsappNumero: input.whatsappNumero,
    nombreCompleto: participant.nombre_completo,
    cedula: participant.cedula || "",
    ciudad: participant.ciudad || "",
    cantidadBoletos: participant.cantidad_boletos,
    comprobanteUrl: input.comprobanteUrl,
    validadoPor: "chat_flow",
    montoCompra: pricing.montoCompra,
    promoNombre: pricing.promoNombre,
    precioRegularReferencia: pricing.precioRegularReferencia,
    revendedorId,
    codigoReferidoSnapshot: codigoReferidoSnap,
    comprobanteValidacionId: norm(flowData[SORTEO_COMPROBANTE_VALIDACION_ID_FIELD]) || null,
  };

  const msgFallback =
    "No pudimos registrar tu compra en el sorteo. Intentá de nuevo en unos minutos o escribí a soporte.";

  const dbSorteo = createServiceRoleClientWithDbSchema(dataSchema);
  let useCustomCouponNumbering = false;
  try {
    const { data: sn, error: snErr } = await dbSorteo
      .from("sorteos")
      .select("coupon_numbering_enabled")
      .eq("id", sorteoId)
      .eq("empresa_id", input.empresaId)
      .maybeSingle();
    if (!snErr && sn && (sn as { coupon_numbering_enabled?: boolean }).coupon_numbering_enabled === true) {
      useCustomCouponNumbering = true;
    }
  } catch {
    useCustomCouponNumbering = false;
  }

  let row: Record<string, unknown> | null = null;

  if (useCustomCouponNumbering) {
    if (!hasDirectPg) {
      return {
        ok: false,
        message:
          "La numeración personalizada de cupones requiere conexión directa a la base (variables de entorno en el servidor). Contactá soporte.",
      };
    }
    const directOut = await ensureSorteoOrderViaDirectPostgres(directOrderArgs);
    if (!directOut.ok) {
      return { ok: false, message: directOut.message };
    }
    row = mapDirectPgOkToRpcRow(directOut);
    console.info(FLOW_SORTEO_LOG, "ensureSorteoOrderFromChat_path", {
      path: "direct_pg_custom_coupon_numbering",
      schema: dataSchema,
      conversationId: input.conversationId,
    });
  } else if (dataSchema !== SUPABASE_APP_SCHEMA) {
    if (!hasDirectPg) {
      return {
        ok: false,
        message:
          "No hay conexión directa a la base de datos para registrar la compra. Contactá soporte.",
      };
    }
    const directOut = await ensureSorteoOrderViaDirectPostgres(directOrderArgs);
    if (!directOut.ok) {
      return { ok: false, message: directOut.message };
    }
    row = mapDirectPgOkToRpcRow(directOut);
    console.info(FLOW_SORTEO_LOG, "ensureSorteoOrderFromChat_path", {
      path: "direct_pg_tenant",
      schema: dataSchema,
      conversationId: input.conversationId,
    });
  } else {
    const { data, error } = await supabase.rpc("sorteos_ensure_order_from_chat", {
      p: rpcPayload,
    });

    if (error) {
      flowTrace("sorteo_order_failed", {
        conversation_id: input.conversationId,
        flow_session_id_context: input.flowSessionId?.trim() ?? null,
        flow_code: flowCode,
        reason: "rpc_error",
        message: error.message,
      });
      console.error(FLOW_SORTEO_LOG, "ensureSorteoOrderFromChat_outcome", {
        path: "failed",
        reason: "rpc_error",
        error: error.message,
        conversationId: input.conversationId,
        flowCode,
        sorteo_id: sorteoId,
        archivo: "src/lib/sorteos/sorteo-order-from-chat.ts",
        condicion: "supabase.rpc sorteos_ensure_order_from_chat devolvió error",
        rpcError: error.message,
        rpcCode: error.code,
        rpcDetails: error.details,
      });
      if (hasDirectPg && isRpcUnavailableError(error)) {
        const directOut = await ensureSorteoOrderViaDirectPostgres(directOrderArgs);
        if (!directOut.ok) {
          return { ok: false, message: directOut.message };
        }
        row = mapDirectPgOkToRpcRow(directOut);
        console.info(FLOW_SORTEO_LOG, "ensureSorteoOrderFromChat_path", {
          path: "direct_pg_fallback_after_rpc_missing",
          schema: dataSchema,
          conversationId: input.conversationId,
        });
      } else {
        return { ok: false, message: msgFallback };
      }
    } else {
      row = data as Record<string, unknown> | null;
    }
  }
  if (!row || typeof row.ok !== "boolean") {
    const invalidMsg = "Respuesta inválida del servidor (sorteo)";
    console.error(FLOW_SORTEO_LOG, "ensureSorteoOrderFromChat_outcome", {
      path: "failed",
      reason: "invalid_rpc_payload",
      error: invalidMsg,
      conversationId: input.conversationId,
      flowCode,
      sorteo_id: sorteoId,
      archivo: "src/lib/sorteos/sorteo-order-from-chat.ts",
      condicion: "!row || typeof row.ok !== boolean",
      rawData: row,
    });
    return { ok: false, message: invalidMsg };
  }
  if (!row.ok) {
    const msg =
      typeof row.message === "string" ? row.message : "Error al crear orden de sorteo";
    console.error(FLOW_SORTEO_LOG, "ensureSorteoOrderFromChat_outcome", {
      path: "failed",
      reason: "rpc_row_not_ok",
      error: msg,
      conversationId: input.conversationId,
      flowCode,
      sorteo_id: sorteoId,
      archivo: "src/lib/sorteos/sorteo-order-from-chat.ts",
      condicion: "row.ok === false (RPC negocio)",
      rpcRowMessage: msg,
      rawRow: row,
    });
    return {
      ok: false,
      message: msg,
    };
  }

  const entrada = row.entrada as Record<string, unknown> | undefined;
  const entradaId = typeof entrada?.id === "string" ? entrada.id : "";
  const numeroOrden =
    typeof entrada?.numero_orden === "number"
      ? entrada.numero_orden
      : Number(entrada?.numero_orden);
  const cuponesRaw = row.cupones as unknown;
  const cupones: { id: string; numero_cupon: string }[] = Array.isArray(cuponesRaw)
    ? cuponesRaw.map((c) => {
        const o = c as Record<string, unknown>;
        return {
          id: String(o.id ?? ""),
          numero_cupon: String(o.numero_cupon ?? ""),
        };
      })
    : [];

  if (!entradaId || !Number.isFinite(numeroOrden)) {
    const incompleteMsg = "Respuesta de orden incompleta";
    console.error(FLOW_SORTEO_LOG, "ensureSorteoOrderFromChat_outcome", {
      path: "failed",
      reason: "entrada_incompleta",
      error: incompleteMsg,
      conversationId: input.conversationId,
      flowCode,
      sorteo_id: sorteoId,
      archivo: "src/lib/sorteos/sorteo-order-from-chat.ts",
      condicion: "!entradaId || !Number.isFinite(numeroOrden)",
      entradaId,
      numeroOrden,
      rawRow: row,
    });
    return { ok: false, message: incompleteMsg };
  }

  const cbRaw = entrada?.cantidad_boletos;
  let cantidadBoletos =
    typeof cbRaw === "number" ? cbRaw : Number(cbRaw);
  if (!Number.isFinite(cantidadBoletos) || cantidadBoletos < 1) {
    cantidadBoletos = participant.cantidad_boletos;
  }

  const montoRaw = entrada?.monto_total;
  let montoTotal = typeof montoRaw === "number" ? montoRaw : Number(montoRaw);
  if (!Number.isFinite(montoTotal) || montoTotal < 0) {
    montoTotal = 0;
  }

  const promoNombre =
    typeof entrada?.promo_nombre === "string" ? entrada.promo_nombre.trim() : "";
  const precioFuenteRaw = entrada?.precio_fuente;
  const precioFuente =
    precioFuenteRaw === "promo" || precioFuenteRaw === "lista"
      ? precioFuenteRaw
      : "lista";

  const dbForTenantTables =
    dataSchema === SUPABASE_APP_SCHEMA ? supabase : createServiceRoleClientWithDbSchema(dataSchema);

  const { data: sorteoRow, error: sorteoNomErr } = await dbForTenantTables
    .from("sorteos")
    .select("nombre")
    .eq("id", sorteoId)
    .maybeSingle();
  let sorteoNombre = String((sorteoRow as { nombre?: string } | null)?.nombre ?? "").trim();
  if (!sorteoNombre) {
    const pgNom = await fetchSorteoRowTicketFieldsFromPg(dataSchema, sorteoId);
    sorteoNombre = String(pgNom?.nombre ?? "").trim();
  }
  if (!sorteoNombre && sorteoNomErr) {
    console.warn(FLOW_SORTEO_LOG, "sorteo_nombre_lookup_failed", {
      sorteoId,
      message: sorteoNomErr.message,
    });
  }

  console.info(FLOW_SORTEO_LOG, "ensureSorteoOrderFromChat_outcome", {
    path: "success",
    conversationId: input.conversationId,
    flowCode,
    sorteo_id: sorteoId,
    sorteo_nombre: sorteoNombre,
    idempotent: row.idempotent === true,
    entradaId,
    numeroOrden,
    cantidadBoletos,
    cuponesCount: cupones.length,
  });

  flowTrace("sorteo_order_created", {
    conversation_id: input.conversationId,
    empresa_id: input.empresaId,
    flow_code: flowCode,
    flow_session_id_context: input.flowSessionId?.trim() ?? null,
    sorteo_id: sorteoId,
    entrada_id: entradaId,
    numero_orden: numeroOrden,
    cantidad_boletos: cantidadBoletos,
    idempotent: row.idempotent === true,
    event: "creacion_orden_sorteo",
  });

  const cvId = norm(flowData[SORTEO_COMPROBANTE_VALIDACION_ID_FIELD]);
  if (cvId && entradaId) {
    await dbForTenantTables
      .from("sorteo_entradas")
      .update({
        comprobante_validacion_id: cvId,
        updated_at: new Date().toISOString(),
      })
      .eq("id", entradaId)
      .eq("empresa_id", input.empresaId);
    await dbForTenantTables
      .from("chat_comprobante_validaciones")
      .update({
        sorteo_entrada_id: entradaId,
        updated_at: new Date().toISOString(),
      })
      .eq("id", cvId)
      .eq("empresa_id", input.empresaId);
  }

  /**
   * FIX recompra (datos del comprador): en un hit idempotente la entrada ya se había creado antes
   * (paso de la imagen del comprobante) y puede haber quedado con datos que el cliente CORRIGIÓ
   * después, entre enviar el comprobante y tocar "Confirmado". La rama idempotente devuelve la fila
   * sin reescribir nombre/documento, así que esa corrección se perdía. Acá reescribimos con lo
   * CONFIRMADO (`participant` deriva del flowData fresco del momento de la confirmación).
   * - Es UPDATE por id ⇒ imposible duplicar la entrada; no cambia CUÁNDO se crea la orden.
   * - Solo en idempotente: en un INSERT fresco los valores ya son los correctos.
   * - Guard por campo: nunca pisamos con vacío (no borra un documento/nombre ya cargado).
   * - No tocamos ciudad: el ticket/listado/impresión ya la toman del chat_flow_data fresco.
   */
  if (row.idempotent === true && entradaId) {
    const nombreConfirmado = participant.nombre_completo.trim();
    const cedulaConfirmada = participant.cedula.trim();
    const patch: Record<string, unknown> = {};
    if (nombreConfirmado) patch.nombre_participante = nombreConfirmado;
    if (cedulaConfirmada) patch.documento = cedulaConfirmada;
    if (Object.keys(patch).length > 0) {
      patch.updated_at = new Date().toISOString();
      await dbForTenantTables
        .from("sorteo_entradas")
        .update(patch)
        .eq("id", entradaId)
        .eq("empresa_id", input.empresaId);
    }
  }

  return {
    ok: true,
    skipped: false,
    idempotent: row.idempotent === true,
    entradaId,
    numeroOrden,
    cupones,
    sorteoId,
    sorteoNombre,
    cantidadBoletos,
    montoTotal,
    promoNombre,
    precioFuente,
  };
}
