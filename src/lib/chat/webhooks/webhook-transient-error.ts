import type { ProcessWebhookResult } from "@/lib/chat/types";

/**
 * Errores de infraestructura pasajeros (Supabase/PostgREST caído un momento, Cloudflare 5xx,
 * red). Patrones acotados a propósito: un error permanente marcado como pasajero haría que Meta
 * reintente de más y, si falla sostenido, desactive el webhook.
 */
const TRANSIENT_ERROR_RE = new RegExp(
  [
    // Página HTML de error de Cloudflare/proxy devuelta como mensaje (520/522/524…), sola o tras "Prefijo: ".
    "(^|:\\s*)<!doctype html",
    "(^|:\\s*)<html",
    // PostgREST sin conexión a la base / sin schema cache / pool agotado.
    "PGRST00[0-3]",
    "Could not query the database for the schema cache",
    // Postgres saturado o reiniciando.
    "out of shared memory",
    "too many (connections|clients)",
    "remaining connection slots",
    "terminating connection due to",
    "Connection terminated",
    "the database system is (starting up|shutting down|in recovery mode)",
    // Red (códigos de Node/undici).
    "\\b(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|EPIPE)\\b",
    "\\bUND_ERR_[A-Z_]+\\b",
    "fetch failed",
    "socket hang up",
    // Estados HTTP de gateway, solo con contexto (no un número suelto en un texto).
    "\\b(Bad Gateway|Service Unavailable|Gateway Time-?out)\\b",
    "\\b(error code|status|HTTP)\\s*:?\\s*(502|503|504|520|521|522|523|524)\\b",
  ].join("|"),
  "i"
);

/** Vacío/undefined NO cuenta: puede ser un bug permanente sin mensaje. */
export function isTransientWebhookError(msg: unknown): boolean {
  if (typeof msg !== "string") return false;
  const text = msg.trim();
  if (text === "" || text === "undefined") return false;
  return TRANSIENT_ERROR_RE.test(text);
}

/**
 * ¿Responderle 503 a Meta para que reintente?
 *
 * Solo si (1) ningún mensaje entrante llegó a guardarse ni se pasó el punto donde el flujo tiene
 * efectos (`inboundDurableWrite`) y (2) hubo al menos un error pasajero. No se mira `processed`:
 * también cuenta estados (sent/delivered/read) y un body mixto taparía un mensaje perdido.
 * Así el reintento es seguro: no hay fila en chat_messages ni respuestas enviadas; contacto y
 * conversación se reusan (upsert / lookup). Los estados (sent/delivered/read) son idempotentes y
 * no retroceden (`shouldApplyWhatsappStatus`).
 */
export function shouldAskMetaToRetry(result: ProcessWebhookResult): boolean {
  if (result.inboundDurableWrite) return false;
  return result.errors.some(isTransientWebhookError);
}
