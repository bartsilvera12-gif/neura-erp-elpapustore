/**
 * Los errores que devuelve el backend (PostgREST detrás de Cloudflare) a veces no
 * son JSON sino una página HTML de error: un 520 de Cloudflare llegaba entero al
 * cartel rojo de la UI, con el `<!DOCTYPE html>` y todo.
 */

const MAX_UPSTREAM_ERROR_LENGTH = 300;

/** Detecta una página HTML devuelta en lugar de un error del API. */
export function looksLikeHtmlErrorPage(message: string): boolean {
  const head = message.trimStart().slice(0, 200).toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html") || head.includes("<html ");
}

/**
 * Deja el error en algo que se pueda leer en pantalla: si vino una página HTML,
 * la reemplaza por un mensaje accionable; si no, recorta el texto.
 */
export function describeUpstreamError(message: string | null | undefined): string {
  const raw = (message ?? "").trim();
  if (!raw) return "Error desconocido del servidor.";

  if (looksLikeHtmlErrorPage(raw)) {
    const code = /error code (\d{3})/i.exec(raw)?.[1] ?? /\b(5\d{2})\b/.exec(raw)?.[1] ?? null;
    return code
      ? `El servidor de datos respondió con un error ${code} (no con datos). Suele ser momentáneo: reintentá en un minuto.`
      : "El servidor de datos devolvió una página de error en vez de datos. Suele ser momentáneo: reintentá en un minuto.";
  }

  return raw.length > MAX_UPSTREAM_ERROR_LENGTH
    ? `${raw.slice(0, MAX_UPSTREAM_ERROR_LENGTH)}…`
    : raw;
}
