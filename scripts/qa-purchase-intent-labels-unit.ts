/**
 * QA unitario (sin DB): qué etiquetas de botón dispara el detector de "intención de compra".
 *
 * Contexto — bug medido en producción (3-sep-2026):
 * Meta reintenta sus webhooks, y el webhook exceptúa a los clics de botón del dedupe general
 * para poder re-correr el routing de campañas. Esa excepción arrastraba también al motor de
 * flujo, así que un mismo clic se procesaba varias veces. Cuando el reproceso llegaba después
 * de que el nodo avanzara, el botón ya no matcheaba el paso actual y caía en la rama de
 * "intención de compra"... que da TRUE para cualquier etiqueta con "boleta". Resultado: la
 * compra se reiniciaba desde cero. ~1.100 veces en dos meses.
 *
 * Este archivo no prueba el dedupe (necesita DB). Fija el hecho que lo volvía destructivo:
 * TODAS las etiquetas de combo matchean intención de compra. Si alguien amplía las raíces y
 * suma "correcto"/"confirmado", este test falla y avisa antes de que llegue a producción.
 *
 * Ejecutar: npx tsx scripts/qa-purchase-intent-labels-unit.ts
 */
import { matchesPurchaseIntent } from "../src/lib/chat/purchase-intent";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log("OK:", name);
  } catch (e) {
    console.error("FAIL:", name, e instanceof Error ? e.message : e);
    process.exit(1);
  }
}

/** Etiquetas reales del flujo Papu_store, tomadas de la conversación de prueba. */
const ETIQUETAS_DE_COMBO = [
  "1 boleta por 10.000",
  "2 boletas por 20.000",
  "3 boletas 30.000 gs",
  "6 boletas 50.000 gs",
  "13 boletas 100.000 g",
  "25 boletas 200.000 g",
  "50 boletos 400.000 g",
  "100 boletos 800.000",
];

/** Botones de avance del flujo: NO deben leerse como intención de comprar de nuevo. */
const ETIQUETAS_DE_AVANCE = ["Correcto", "Confirmado", "Corregir", "Cancelar", "Enviar comprobante"];

test("todas las etiquetas de combo disparan intención de compra (el peligro)", () => {
  for (const label of ETIQUETAS_DE_COMBO) {
    assert(
      matchesPurchaseIntent(label),
      `esperaba intención en "${label}" — si esto cambia, revisar el guard de reproceso`
    );
  }
});

test("los botones de avance NO disparan intención de compra", () => {
  for (const label of ETIQUETAS_DE_AVANCE) {
    assert(!matchesPurchaseIntent(label), `"${label}" no debería leerse como intención de compra`);
  }
});

test("comprobante no se confunde con comprar (raíz `compra`, no `compr`)", () => {
  assert(!matchesPurchaseIntent("comprobante"), "comprobante");
  assert(!matchesPurchaseIntent("te envio el comprobante"), "frase con comprobante");
  assert(matchesPurchaseIntent("quiero comprar"), "quiero comprar");
});

test("intención real de recomprar sigue reconocida", () => {
  for (const t of ["compra mas", "quiero otro", "volver a comprar", "Comprar mas", "mas boletas"]) {
    assert(matchesPurchaseIntent(t), t);
  }
});

console.log(`\n${passed} pruebas OK`);
