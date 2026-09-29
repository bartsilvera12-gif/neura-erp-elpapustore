/**
 * `fetch` para los clientes Supabase del servidor que reintenta fallas PASAJERAS de la API REST
 * (Cloudflare 520-524, 502/503/504 del gateway, red caída) antes de devolverle el error al código.
 *
 * Por qué (diagnóstico 29-sep, Papu_store): el bot habla con la base por la API REST detrás de
 * Cloudflare, que responde 520 / cuerpo vacío de forma intermitente. Casi ninguna consulta del
 * motor reintentaba: una sola lectura fallida cortaba el procesamiento del mensaje en silencio
 * (el cliente contestaba "Asunción" y el bot no seguía), o se leía como "nodo inválido" y
 * reiniciaba el flujo perdiendo los datos ya cargados.
 *
 * Qué se reintenta, para no duplicar escrituras:
 * - Lecturas (GET/HEAD): ante cualquier falla pasajera.
 * - Upserts (POST con `Prefer: resolution=…`): re-aplicarlos deja el mismo resultado.
 * - Otras escrituras (insert/update/delete/rpc): SÓLO si el pedido seguro no llegó a la base
 *   (Cloudflare no pudo conectar con el origen: 521/522/523/525/526, o la conexión no se
 *   estableció). Un 520/524 en una escritura es ambiguo —pudo haberse aplicado— y no se repite:
 *   p. ej. el avance con compare-and-set del puntero, reintentado tras aplicarse, se leería como
 *   "otro handler ganó" y descartaría la respuesta del cliente.
 */

const RETRY_DELAYS_MS: readonly number[] = [300, 900, 2000];

/** El pedido no llegó al origen: seguro de repetir aunque sea escritura. */
const NOT_DELIVERED_STATUSES = new Set([521, 522, 523, 525, 526]);
/** Pasajeros pero ambiguos para escrituras (el origen pudo haber procesado el pedido). */
const AMBIGUOUS_TRANSIENT_STATUSES = new Set([502, 503, 504, 520, 524]);

/** Errores de conexión en los que el pedido nunca salió hacia el servidor. */
const NOT_SENT_NETWORK_CODES = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT|UND_ERR_CONNECT/i;

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

function methodOf(input: FetchInput, init: FetchInit): string {
  const m = init?.method ?? (typeof input === "object" && "method" in input ? input.method : undefined);
  return (m ?? "GET").toUpperCase();
}

function headerOf(init: FetchInit, name: string): string {
  const h = init?.headers;
  if (!h) return "";
  if (h instanceof Headers) return h.get(name) ?? "";
  if (Array.isArray(h)) {
    const hit = h.find(([k]) => k.toLowerCase() === name.toLowerCase());
    return hit?.[1] ?? "";
  }
  const rec = h as Record<string, string>;
  const key = Object.keys(rec).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? String(rec[key]) : "";
}

/** Sólo se puede repetir un pedido cuyo cuerpo se pueda volver a mandar tal cual. */
function isReplayable(input: FetchInput, init: FetchInit): boolean {
  if (typeof input !== "string" && !(input instanceof URL)) return false;
  const b = init?.body;
  return b == null || typeof b === "string";
}

function networkErrorCode(e: unknown): string {
  const err = e as { code?: unknown; cause?: { code?: unknown; message?: unknown } } | null;
  return [err?.code, err?.cause?.code, err?.cause?.message, e instanceof Error ? e.message : ""]
    .filter((x) => typeof x === "string")
    .join(" ");
}

function isAbort(e: unknown, init: FetchInit): boolean {
  return Boolean(init?.signal?.aborted) || (e instanceof Error && e.name === "AbortError");
}

export function createTransientRetryFetch(
  baseFetch?: typeof fetch,
  delaysMs: readonly number[] = RETRY_DELAYS_MS
): typeof fetch {
  return async function transientRetryFetch(input: FetchInput, init?: FetchInit): Promise<Response> {
    const doFetch = baseFetch ?? globalThis.fetch;
    const method = methodOf(input, init);
    const isRead = method === "GET" || method === "HEAD";
    const isUpsert = method === "POST" && /resolution=/i.test(headerOf(init, "prefer"));
    const idempotent = isRead || isUpsert;
    const replayable = isReplayable(input, init);

    for (let attempt = 0; ; attempt++) {
      const canRetry = replayable && attempt < delaysMs.length;
      let retryReason: string | null = null;
      try {
        const res = await doFetch(input, init);
        if (!canRetry) return res;
        if (NOT_DELIVERED_STATUSES.has(res.status) || (idempotent && AMBIGUOUS_TRANSIENT_STATUSES.has(res.status))) {
          retryReason = `http_${res.status}`;
          // Liberar el cuerpo de la respuesta descartada.
          await res.body?.cancel().catch(() => undefined);
        } else {
          return res;
        }
      } catch (e) {
        if (!canRetry || isAbort(e, init)) throw e;
        const code = networkErrorCode(e);
        if (!(idempotent || NOT_SENT_NETWORK_CODES.test(code))) throw e;
        retryReason = code.slice(0, 120) || "network_error";
      }
      const delay = delaysMs[attempt];
      console.warn("[supabase-fetch][retry]", {
        method,
        attempt: attempt + 1,
        reason: retryReason,
        path: String(input).replace(/^https?:\/\/[^/]+/, "").split("?")[0].slice(0, 80),
      });
      await new Promise((r) => setTimeout(r, delay));
    }
  };
}

/** Instancia compartida para pasar como `global.fetch` a `createClient`. */
export const transientRetryFetch = createTransientRetryFetch();
