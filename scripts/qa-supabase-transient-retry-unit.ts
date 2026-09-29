/**
 * QA unitario (sin DB): reintento de fallas pasajeras de la API REST de Supabase.
 *
 * Contexto (diagnóstico 29-sep, Papu_store): la API detrás de Cloudflare devolvía 520 / cuerpo
 * vacío de forma intermitente y una sola lectura fallida cortaba el flujo del cliente. Lo que se
 * prueba acá es QUÉ se reintenta: lecturas y upserts siempre; otras escrituras sólo si el pedido
 * seguro no llegó a la base (para no duplicar inserts ni romper el compare-and-set del puntero).
 *
 * Ejecutar: npx tsx scripts/qa-supabase-transient-retry-unit.ts
 */
import { createTransientRetryFetch } from "../src/lib/supabase/transient-retry-fetch";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}
let passed = 0;
function ok(msg: string) {
  passed += 1;
  console.log("OK:", msg);
}

type Step = number | Error;
const URL_REST = "https://api.example.test/rest/v1/chat_flow_nodes?select=id";

/** fetch simulado: devuelve los estados (o lanza los errores) en orden. */
function fakeFetch(steps: Step[]) {
  const calls: number[] = [];
  const f = (async () => {
    calls.push(calls.length + 1);
    const s = steps[Math.min(calls.length - 1, steps.length - 1)];
    if (s instanceof Error) throw s;
    return new Response(s >= 500 ? "<html><title>520: Web server is returning an unknown error</title></html>" : "[]", {
      status: s,
    });
  }) as typeof fetch;
  return { f, calls };
}

function netErr(code?: string): Error {
  const e = new TypeError("fetch failed");
  if (code) (e as unknown as { cause: unknown }).cause = { code };
  return e;
}

const NO_WAIT = [0, 0, 0];

async function run(steps: Step[], init?: RequestInit, input: string | Request = URL_REST) {
  const { f, calls } = fakeFetch(steps);
  const retrying = createTransientRetryFetch(f, NO_WAIT);
  try {
    const res = await retrying(input, init);
    return { status: res.status, calls: calls.length, threw: null as Error | null };
  } catch (e) {
    return { status: 0, calls: calls.length, threw: e as Error };
  }
}

(async () => {
  // Silenciar los logs de reintento.
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    {
      const r = await run([520, 520, 200]);
      assert(r.status === 200 && r.calls === 3, `GET 520,520,200 → ${r.status} en ${r.calls}`);
      ok("lectura: dos 520 seguidos y después OK → se recupera (el caso de 'primer_nombre' inválido)");
    }
    {
      const r = await run([502, 503, 504, 524]);
      assert(r.status === 524 && r.calls === 4, `GET agota reintentos → ${r.status} en ${r.calls}`);
      ok("lectura: si la API sigue caída, tras 3 reintentos devuelve el error (no se cuelga)");
    }
    {
      const r = await run([netErr(), 200]);
      assert(r.status === 200 && r.calls === 2, `GET fetch failed → ${r.status} en ${r.calls}`);
      ok("lectura: 'fetch failed' de red → se reintenta");
    }
    {
      const r = await run([404]);
      assert(r.status === 404 && r.calls === 1, "GET 404 no se reintenta");
      const r2 = await run([400]);
      assert(r2.status === 400 && r2.calls === 1, "GET 400 no se reintenta");
      ok("lectura: errores que no son pasajeros (400/404) no se reintentan");
    }
    {
      const r = await run([520, 200], { method: "PATCH", body: "{}" });
      assert(r.status === 520 && r.calls === 1, `PATCH 520 → ${r.status} en ${r.calls}`);
      ok("update: 520 es ambiguo (pudo aplicarse) → NO se repite (protege el compare-and-set del puntero)");
    }
    {
      const r = await run([520, 200], { method: "POST", body: "{}" });
      assert(r.status === 520 && r.calls === 1, `POST insert 520 → ${r.status} en ${r.calls}`);
      ok("insert: 520 ambiguo → NO se repite (no duplica mensajes ni eventos)");
    }
    {
      const r = await run([522, 200], { method: "PATCH", body: "{}" });
      assert(r.status === 200 && r.calls === 2, `PATCH 522 → ${r.status} en ${r.calls}`);
      const r2 = await run([521, 523, 200], { method: "POST", body: "{}" });
      assert(r2.status === 200 && r2.calls === 3, `POST 521,523 → ${r2.status} en ${r2.calls}`);
      ok("escritura: 521/522/523 (Cloudflare no llegó al origen) → se reintenta sin riesgo");
    }
    {
      const r = await run([520, 200], {
        method: "POST",
        body: "{}",
        headers: { Prefer: "resolution=merge-duplicates,return=representation" },
      });
      assert(r.status === 200 && r.calls === 2, `upsert 520 → ${r.status} en ${r.calls}`);
      const r2 = await run([504, 200], {
        method: "POST",
        body: "{}",
        headers: new Headers({ prefer: "resolution=merge-duplicates" }),
      });
      assert(r2.status === 200 && r2.calls === 2, `upsert (Headers) 504 → ${r2.status} en ${r2.calls}`);
      ok("upsert: re-aplicarlo deja el mismo resultado → se reintenta (guardado de cédula/nombre)");
    }
    {
      const r = await run([netErr(), 200], { method: "POST", body: "{}" });
      assert(r.threw !== null && r.calls === 1, "insert con 'fetch failed' sin código no se repite");
      const r2 = await run([netErr("ECONNREFUSED"), 200], { method: "POST", body: "{}" });
      assert(r2.status === 200 && r2.calls === 2, "insert con ECONNREFUSED sí se repite");
      ok("escritura: error de red ambiguo no se repite; conexión rechazada (no salió) sí");
    }
    {
      const r = await run([520, 200], { method: "GET" }, new Request(URL_REST));
      assert(r.status === 520 && r.calls === 1, "Request object no se reintenta");
      const r2 = await run([522, 200], { method: "POST", body: new Blob(["x"]) });
      assert(r2.status === 522 && r2.calls === 1, "cuerpo no repetible (Blob/stream) no se reintenta");
      ok("pedidos cuyo cuerpo no se puede volver a mandar (subidas de archivos) no se reintentan");
    }
    {
      const ac = new AbortController();
      ac.abort();
      const abortErr = new Error("aborted");
      abortErr.name = "AbortError";
      const r = await run([abortErr, 200], { signal: ac.signal });
      assert(r.threw !== null && r.calls === 1, "abort no se reintenta");
      ok("pedido cancelado a propósito no se reintenta");
    }
  } finally {
    console.warn = warn;
  }
  console.log(`\n${passed} pruebas OK`);
})().catch((e) => {
  console.error("FALLO:", e instanceof Error ? e.message : e);
  process.exit(1);
});
