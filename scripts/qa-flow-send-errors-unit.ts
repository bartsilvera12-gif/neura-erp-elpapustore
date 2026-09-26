/**
 * QA unitario (sin DB): qué errores de envío se reintentan y cómo quedan registrados.
 * Los casos son los errores REALES del diagnóstico de producción (26-sep, Papu_store, bloque A).
 *
 * Ejecutar: npx tsx scripts/qa-flow-send-errors-unit.ts
 */
import { isTransientSendError, summarizeSendError } from "../src/lib/chat/flow-send-errors";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}
let passed = 0;
function ok(msg: string) {
  passed += 1;
  console.log("OK:", msg);
}

const CLOUDFLARE_HTML = `<!DOCTYPE html>
<!--[if lt IE 7]> <html class="no-js ie6 oldie" lang="en-US"> <![endif]-->
<!--[if IE 7]>    <html class="no-js ie7 oldie" lang="en-US"> <![endif]-->
<head><title>xyzabc.supabase.co | 522: Connection timed out</title></head><body>...</body></html>`;

assert(isTransientSendError(CLOUDFLARE_HTML), "HTML de Cloudflare se reintenta");
const resumen = summarizeSendError(CLOUDFLARE_HTML);
assert(resumen.includes("522") && !resumen.includes("<"), `HTML resumido: ${resumen}`);
ok(`página de Cloudflare (28 casos): se reintenta y queda como "${resumen}"`);

assert(isTransientSendError(""), "error vacío se reintenta");
assert(summarizeSendError("") !== "", "nunca vacío");
ok("error vacío (18 casos): se reintenta y queda con texto");

assert(isTransientSendError("(#131000) Something went wrong"), "#131000 transitorio de Meta");
assert(isTransientSendError("TypeError: fetch failed"), "caída de red");
ok("(#131000) Something went wrong y TypeError: fetch failed: se reintentan");

assert(!isTransientSendError("Nodo actual no encontrado"), "nodo inexistente no se reintenta");
assert(!isTransientSendError("Sesión de flujo no inicializada; escribí hola para reiniciar."), "sin sesión");
assert(!isTransientSendError("(#131047) Re-engagement message"), "ventana de 24 h cerrada");
assert(!isTransientSendError("Se alcanzó el límite de auto-encadenamiento del flujo"), "bucle");
ok("lo que va a fallar igual NO se reintenta (nodo inexistente, sin sesión, 24 h, bucle)");

assert(summarizeSendError("x".repeat(2000)).length <= 300, "errores largos se recortan");
ok("errores largos se recortan");

console.log(`\n${passed} pruebas OK`);
