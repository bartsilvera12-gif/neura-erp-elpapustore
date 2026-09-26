/**
 * Errores al enviar un nodo del flujo: cuáles vale la pena reintentar y cómo dejarlos legibles.
 *
 * Helpers puros. Contexto (diagnóstico del 26-sep): el primer paso del flujo falló ~47 veces en
 * 14 días. En 28 el "error" guardado era una página HTML entera de Cloudflare (un 5xx de la base
 * o del proveedor a mitad del envío) y en 18 venía vacío. Nadie reintentaba: el cliente que
 * escribió "hola" se quedaba sin respuesta.
 */

/** Esperas entre reintentos. Dos reintentos: cubre un 5xx pasajero sin demorar de más el webhook. */
export const SEND_RETRY_DELAYS_MS: readonly number[] = [1500, 3000];

function htmlTitle(s: string): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(s);
  return m ? m[1].replace(/\s+/g, " ").trim() : "";
}

function isHtml(s: string): boolean {
  return /<!doctype html|<html[\s>]/i.test(s);
}

/**
 * Versión corta y legible del error: una página HTML queda como su título (Cloudflare pone ahí
 * el código, p. ej. "…supabase.co | 522: Connection timed out"). Nunca devuelve vacío.
 */
export function summarizeSendError(raw: string | null | undefined): string {
  const s = (raw ?? "").trim();
  if (!s) return "error vacío (sin detalle del proveedor)";
  if (isHtml(s)) {
    const title = htmlTitle(s);
    const code = /\b(5\d\d|429)\b/.exec(title || s)?.[1];
    return `respuesta HTML${code ? ` ${code}` : ""}${title ? `: ${title}` : ""}`.slice(0, 200);
  }
  return s.replace(/\s+/g, " ").slice(0, 300);
}

/**
 * ¿Vale la pena reintentar? Sólo fallas pasajeras de red / proveedor / base.
 * NO se reintenta lo que va a fallar igual: nodo inexistente, sesión sin iniciar, ventana de 24 h
 * de WhatsApp cerrada (#131047), número inválido, configuración del canal.
 */
export function isTransientSendError(raw: string | null | undefined): boolean {
  const s = (raw ?? "").trim();
  if (!s) return true;
  if (isHtml(s)) return true;
  if (
    /nodo actual no encontrado|sesión de flujo no inicializada|sesion de flujo no inicializada|auto-encadenamiento|sin flow_code|no tiene nodo siguiente|configuración|configuracion|inválido|invalido|#131047|#131026|#131051|#132\d{3}/i.test(
      s
    )
  ) {
    return false;
  }
  return /fetch failed|etimedout|econnreset|econnrefused|eai_again|socket hang up|timed? ?out|network|#131000|#131016|#130429|#80007|rate limit|too many requests|http 5\d\d|http 429|bad gateway|service unavailable|gateway time-?out/i.test(
    s
  );
}
