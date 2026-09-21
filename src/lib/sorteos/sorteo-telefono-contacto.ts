/**
 * Teléfono de contacto DECLARADO por el comprador en el flujo.
 *
 * Distinto de `sorteo_entradas.whatsapp_numero`, que es la línea desde la que escribe (la que
 * usa Meta para entregarle el ticket). La boleta debe mostrar el que la persona cargó y
 * confirmó: puede comprar desde el celular de un familiar, o dejar otro número de contacto.
 *
 * Helpers puros (sin `pg` ni Supabase): los comparte el cierre de la orden, el render del PNG
 * y el clasificador de campos de identidad del flujo.
 */

function norm(v: string | undefined | null): string {
  return typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "";
}

/** Claves de `chat_flow_data` (save_as_field) donde puede quedar el celular declarado. */
export const TELEFONO_CONTACTO_FLOW_KEYS: readonly string[] = [
  "telefono_contacto",
  "telefono",
  "teléfono",
  "telefono_celular",
  "numero_telefono",
  "nro_telefono",
  "celular",
  "numero_celular",
  "número_celular",
  "nro_celular",
  "num_celular",
  "movil",
  "móvil",
  "numero_contacto",
  "número_contacto",
  "whatsapp",
  "numero_whatsapp",
  "phone",
  "mobile",
];

/** Mínimo de dígitos para considerar que la respuesta es un teléfono y no texto suelto. */
const MIN_PHONE_DIGITS = 6;

/**
 * Devuelve el número tal como lo tipeó la persona (sin reformatear: el cliente quiere ver
 * `0973592372`, no `595973592372`), o `""` si la respuesta no parece un teléfono.
 */
export function normalizeTelefonoContactoDisplay(raw: string | undefined | null): string {
  const t = norm(raw);
  if (!t) return "";
  const digits = t.replace(/\D/g, "");
  if (digits.length < MIN_PHONE_DIGITS) return "";
  /** Texto con un número adentro ("mi celu es 0973...") no es una captura limpia: se descarta. */
  if (/[a-zA-ZáéíóúÁÉÍÓÚñÑ]/.test(t)) return "";
  return t;
}

/** Primer alias con un teléfono válido en el mapa de `chat_flow_data`. */
export function readTelefonoContactoFromFlowData(
  flowData: Record<string, string>
): string {
  for (const k of TELEFONO_CONTACTO_FLOW_KEYS) {
    const v = normalizeTelefonoContactoDisplay(flowData[k]);
    if (v) return v;
  }
  return "";
}

/** ¿Esta `save_as_field` captura el teléfono de contacto? (alias + acentos, sin orden fijo) */
export function isTelefonoContactoFieldKey(normalizedKey: string): boolean {
  const k = normalizedKey.trim().toLowerCase();
  if (!k) return false;
  if (TELEFONO_CONTACTO_FLOW_KEYS.includes(k)) return true;
  return /telefono|celular|movil|whatsapp|phone|mobile/.test(k);
}
