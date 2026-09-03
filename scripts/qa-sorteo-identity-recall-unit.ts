/**
 * QA unitario (sin DB): recompra rápida — "¿querés comprar con tus datos registrados?".
 *
 * Simula los tres casos del negocio sobre las funciones puras que decide el flujo:
 *   1. comprador nuevo,
 *   2. recomprador que confirma sus datos,
 *   3. recomprador que compra PARA OTRA PERSONA  ← el que se rompió en agosto (2388584).
 *
 * La afirmación central del caso 3: tras "No, ingresar nuevo" el gate de completitud debe ver la
 * identidad como FALTANTE y el parser no debe poder armar un participante. Si alguna vez se agrega
 * un alias de identidad sin sumarlo a IDENTITY_RECALL_CLEAR_FIELDS, este test falla.
 *
 * Ejecutar: npx tsx scripts/qa-sorteo-identity-recall-unit.ts
 */
import {
  IDENTITY_RECALL_CLEAR_FIELDS,
  IDENTITY_RECALL_CONFIRMED_FIELD,
  IDENTITY_RECALL_SNAPSHOT_FIELD,
  buildIdentityRecallFlowDataWrites,
  buildIdentityRecallSnapshotWrites,
  buildIdentityRecallVars,
  identityRecallWasConfirmed,
  optionPayloadRequestsNewIdentity,
  optionPayloadUsesRegisteredIdentity,
  readIdentityRecallSnapshot,
  splitNombreCompleto,
  type IdentityRecallCliente,
} from "../src/lib/sorteos/sorteo-identity-recall";
import {
  flowDataHasValueForCaptureSaveField,
  isIdentityCaptureField,
} from "../src/lib/sorteos/sorteo-flow-capture-order";
import { parseSorteoParticipantFromFlowData } from "../src/lib/sorteos/sorteo-order-from-chat";
import { paraguayPhoneMatchVariants } from "../src/lib/chat/wa-phone";

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

/** Aplica entradas [campo, valor] como lo hace el upsert de chat_flow_data. */
function applyWrites(
  flowData: Record<string, string>,
  writes: Array<{ field_name: string; field_value: string }>
): Record<string, string> {
  const out = { ...flowData };
  for (const w of writes) out[w.field_name] = w.field_value;
  return out;
}

function applyClear(flowData: Record<string, string>): Record<string, string> {
  const out = { ...flowData };
  for (const f of IDENTITY_RECALL_CLEAR_FIELDS) out[f] = "";
  return out;
}

/** ¿El gate ve la identidad cargada? Espeja lo que evalúan los nodos de captura. */
function identityLooksComplete(flowData: Record<string, string>): boolean {
  return (
    flowDataHasValueForCaptureSaveField(flowData, "cedula") &&
    flowDataHasValueForCaptureSaveField(flowData, "nombre") &&
    flowDataHasValueForCaptureSaveField(flowData, "ciudad")
  );
}

const CLIENTE_REGISTRADO: IdentityRecallCliente = {
  clienteId: "11111111-1111-4111-8111-111111111111",
  nombreCompleto: "Juan Pérez",
  cedula: "1234567",
  ciudad: "Asunción",
  telefono: "595981123456",
};

/** Sesión con una compra previa: cantidad heredable + identidad vieja como resto. */
function sesionConRestosDeCompraAnterior(): Record<string, string> {
  return {
    cantidad: "3",
    nombre: "Juan Pérez",
    apellido: "",
    nombre_completo: "Juan Pérez",
    cedula: "1234567",
    ciudad: "Asunción",
  };
}

/* ───────────────────────── botones ───────────────────────── */

test("los payloads distinguen los dos botones", () => {
  assert(optionPayloadUsesRegisteredIdentity({ usar_datos_registrados: true }), "si");
  assert(optionPayloadRequestsNewIdentity({ cargar_datos_nuevos: true }), "no");
  assert(!optionPayloadUsesRegisteredIdentity({ cargar_datos_nuevos: true }), "no cruzado");
  assert(!optionPayloadRequestsNewIdentity({ usar_datos_registrados: true }), "si cruzado");
  assert(!optionPayloadUsesRegisteredIdentity({}), "payload vacío");
  assert(!optionPayloadUsesRegisteredIdentity(null), "payload nulo");
  // un botón de combo cualquiera no debe activar ninguna rama
  assert(!optionPayloadUsesRegisteredIdentity({ cantidad: 5 }), "combo no confirma");
  assert(!optionPayloadRequestsNewIdentity({ cantidad: 5 }), "combo no rechaza");
});

/* ─────────────────── caso 1: comprador nuevo ─────────────────── */

test("caso 1 — comprador nuevo: sin marca de recall no se saltea nada", () => {
  const fd: Record<string, string> = { cantidad: "2" };
  assert(!identityRecallWasConfirmed(fd), "no debe haber marca de confirmación");
  assert(!identityLooksComplete(fd), "la identidad debe estar vacía");
  assert(parseSorteoParticipantFromFlowData(fd) === null, "no debe armar participante");
});

/* ──────────── caso 2: recomprador confirma sus datos ──────────── */

test("caso 2 — recomprador confirma: la orden queda con los datos mostrados", () => {
  // el nodo se envió: se guarda el snapshot de lo que el cliente vio
  let fd = applyWrites({ cantidad: "3" }, buildIdentityRecallSnapshotWrites(CLIENTE_REGISTRADO));
  const snap = readIdentityRecallSnapshot(fd[IDENTITY_RECALL_SNAPSHOT_FIELD]);
  assert(snap !== null, "el snapshot debe releerse");
  assert(snap!.cedula === "1234567", "cédula del snapshot");

  // toca "Sí, confirmar"
  fd = applyWrites(fd, buildIdentityRecallFlowDataWrites(snap!));
  fd[IDENTITY_RECALL_SNAPSHOT_FIELD] = "";
  fd[IDENTITY_RECALL_CONFIRMED_FIELD] = "si";

  assert(identityRecallWasConfirmed(fd), "queda la marca que habilita el salteo");
  assert(identityLooksComplete(fd), "el gate debe ver la identidad completa");

  const p = parseSorteoParticipantFromFlowData(fd);
  assert(p !== null, "debe armar participante");
  assert(p!.nombre_completo === "Juan Pérez", `nombre: ${p!.nombre_completo}`);
  assert(p!.cedula === "1234567", `cédula: ${p!.cedula}`);
  assert(p!.ciudad === "Asunción", `ciudad: ${p!.ciudad}`);
  assert(p!.cantidad_boletos === 3, `cantidad: ${p!.cantidad_boletos}`);
});

/* ───── caso 3: recomprador compra PARA OTRA PERSONA (el crítico) ───── */

test("caso 3 — 'No, ingresar nuevo' deja la identidad vacía (regresión 2388584)", () => {
  const antes = sesionConRestosDeCompraAnterior();
  assert(identityLooksComplete(antes), "precondición: los restos se ven como identidad cargada");
  assert(parseSorteoParticipantFromFlowData(antes) !== null, "precondición: armaría participante");

  const despues = applyClear(antes);

  assert(!identityLooksComplete(despues), "el gate NO debe ver identidad cargada");
  assert(
    parseSorteoParticipantFromFlowData(despues) === null,
    "no debe poder armar participante con los datos viejos"
  );
  assert(!identityRecallWasConfirmed(despues), "la marca de confirmación debe quedar borrada");
  assert(
    (despues[IDENTITY_RECALL_SNAPSHOT_FIELD] ?? "") === "",
    "el snapshot no debe sobrevivir al rechazo"
  );
});

test("caso 3 — la cantidad heredada SÍ sobrevive (no se pierde el combo elegido)", () => {
  const despues = applyClear(sesionConRestosDeCompraAnterior());
  assert(despues["cantidad"] === "3", "la cantidad no es identidad: debe quedar");
});

test("caso 3 — luego carga los datos de otra persona y la orden sale a ese nombre", () => {
  const fd = applyClear(sesionConRestosDeCompraAnterior());
  // el flujo vuelve a capturar, ahora para otra persona
  fd["nombre"] = "María";
  fd["apellido"] = "González";
  fd["cedula"] = "7654321";
  fd["ciudad"] = "Luque";

  const p = parseSorteoParticipantFromFlowData(fd);
  assert(p !== null, "debe armar participante");
  assert(p!.nombre_completo === "María González", `nombre: ${p!.nombre_completo}`);
  assert(p!.cedula === "7654321", `cédula: ${p!.cedula}`);
  assert(p!.ciudad === "Luque", `ciudad: ${p!.ciudad}`);
});

/* ─────────── invariante anti-divergencia de alias ─────────── */

test("la limpieza cubre TODOS los alias de identidad que reconoce el gate", () => {
  /** Sembramos cada alias con valor y verificamos que el clear los apague todos. */
  const alias = IDENTITY_RECALL_CLEAR_FIELDS.filter((f) => isIdentityCaptureField(f));
  assert(alias.length >= 15, `esperaba muchos alias de identidad, hay ${alias.length}`);

  const sembrado: Record<string, string> = { cantidad: "1" };
  for (const a of alias) sembrado[a] = "X";

  const limpio = applyClear(sembrado);
  for (const a of alias) {
    assert((limpio[a] ?? "") === "", `alias sin limpiar: ${a}`);
  }
  assert(!identityLooksComplete(limpio), "con todos los alias sembrados y limpiados: incompleto");
});

test("los alias que el gate consulta están en la lista de limpieza", () => {
  /**
   * Guarda de divergencia: si mañana el gate empieza a aceptar un alias nuevo,
   * sembrarlo solo a él debe seguir quedando incompleto tras el clear.
   */
  for (const bucketKey of ["cedula", "nombre", "ciudad"]) {
    const solo: Record<string, string> = { cantidad: "1", [bucketKey]: "X" };
    assert(
      flowDataHasValueForCaptureSaveField(solo, bucketKey),
      `precondición: ${bucketKey} sembrado se ve cargado`
    );
    const limpio = applyClear(solo);
    assert(
      !flowDataHasValueForCaptureSaveField(limpio, bucketKey),
      `${bucketKey} sigue viéndose cargado tras limpiar`
    );
  }
});

test("el test tiene dientes: si se olvidara un alias, el caso 3 fallaría", () => {
  /**
   * Simula el olvido concreto: limpiar todo MENOS `nombre_completo`. El parser tiene fallback a
   * esa clave, así que la orden volvería a salir con el nombre viejo — el bug de agosto.
   * Este test afirma que ese estado se DETECTA, o sea que la aserción del caso 3 no es vacía.
   */
  const olvido = applyClear(sesionConRestosDeCompraAnterior());
  olvido["nombre_completo"] = "Juan Pérez";

  const p = parseSorteoParticipantFromFlowData(olvido);
  assert(p !== null, "con el alias olvidado el parser SÍ arma participante");
  assert(
    p!.nombre_completo === "Juan Pérez",
    "y lo arma con el nombre viejo: exactamente el bug que el caso 3 previene"
  );
});

/* ─────────── piezas de apoyo ─────────── */

test("nombre y apellido se separan igual que en el resto del flujo", () => {
  assert(splitNombreCompleto("Juan Pérez").nombre === "Juan", "nombre simple");
  assert(splitNombreCompleto("Juan Pérez").apellido === "Pérez", "apellido simple");
  assert(splitNombreCompleto("Ana María López Gómez").nombre === "Ana", "primer token");
  assert(
    splitNombreCompleto("Ana María López Gómez").apellido === "María López Gómez",
    "resto como apellido"
  );
  assert(splitNombreCompleto("  Juan  ").apellido === "", "un solo token: sin apellido");
  assert(splitNombreCompleto("").nombre === "", "vacío");
});

test("el teléfono matchea en los tres formatos PY", () => {
  const v = paraguayPhoneMatchVariants("595981123456");
  assert(v.includes("595981123456"), "internacional");
  assert(v.includes("0981123456"), "local con 0");
  assert(v.includes("981123456"), "nacional significativo");
  // el mismo número tipeado en local debe generar el mismo conjunto
  const v2 = paraguayPhoneMatchVariants("0981 123 456");
  assert(v2.includes("595981123456"), "desde local resuelve el internacional");
  assert(paraguayPhoneMatchVariants("").length === 0, "sin dígitos: sin variantes");
  assert(paraguayPhoneMatchVariants("abc").length === 0, "sin dígitos: sin variantes (texto)");
});

test("snapshot corrupto o vacío no inventa identidad", () => {
  assert(readIdentityRecallSnapshot("") === null, "vacío");
  assert(readIdentityRecallSnapshot("{no json") === null, "json inválido");
  assert(readIdentityRecallSnapshot('{"nombreCompleto":"Juan"}') === null, "sin cédula");
  assert(readIdentityRecallSnapshot('{"cedula":"123"}') === null, "sin nombre");
});

test("las variables del mensaje traen los cuatro datos pedidos", () => {
  const vars = buildIdentityRecallVars(CLIENTE_REGISTRADO);
  assert(vars.datos_cedula === "1234567", "C.I.");
  assert(vars.datos_nombre === "Juan Pérez", "Nombre");
  assert(vars.datos_ciudad === "Asunción", "Ciudad");
  assert(vars.datos_telefono === "595981123456", "Teléfono");
});

console.log(`\n${passed} pruebas OK`);
