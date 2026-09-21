/**
 * QA unitario (sin DB): el teléfono que se imprime en la boleta.
 *
 * Caso reportado (orden 6434): la persona cargó 0973592372 en el bot y la boleta salió con
 * 595984462823, que es la línea de WhatsApp desde la que escribió. Las afirmaciones:
 *   1. el celular declarado en el flujo llega a la orden,
 *   2. el PNG imprime el declarado y sólo cae al WhatsApp si no hay declarado,
 *   3. el teléfono es dato de IDENTIDAD: no se hereda de una compra anterior ni sobrevive
 *      a "No, ingresar nuevo",
 *   4. la recompra rápida nunca ofrece confirmar el número de WhatsApp como si fuera declarado.
 *
 * Ejecutar: npx tsx --conditions=react-server scripts/qa-sorteo-telefono-boleta-unit.ts
 */
import {
  normalizeTelefonoContactoDisplay,
  readTelefonoContactoFromFlowData,
} from "../src/lib/sorteos/sorteo-telefono-contacto";
import {
  flowDataHasValueForCaptureSaveField,
  isIdentityCaptureField,
} from "../src/lib/sorteos/sorteo-flow-capture-order";
import { parseSorteoParticipantFromFlowData } from "../src/lib/sorteos/sorteo-order-from-chat";
import { buildSorteoTicketRenderData } from "../src/lib/sorteos/sorteo-ticket-render-data";
import {
  IDENTITY_RECALL_CLEAR_FIELDS,
  buildIdentityRecallFlowDataWrites,
} from "../src/lib/sorteos/sorteo-identity-recall";
import type { EnsureSorteoOrderCreatedData } from "../src/lib/sorteos/sorteo-order-from-chat";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

let passed = 0;
function ok(msg: string) {
  passed += 1;
  console.log("OK:", msg);
}

const TEL_DECLARADO = "0973592372";
const WA_REMITENTE = "595984462823";

const orderResultVacio: EnsureSorteoOrderCreatedData = {
  idempotent: false,
  entradaId: "e1",
  numeroOrden: 6434,
  cupones: [],
  sorteoId: "s1",
  sorteoNombre: "Sorteo",
  cantidadBoletos: 1,
  montoTotal: 0,
  promoNombre: "",
  precioFuente: "lista",
};

// ---------------------------------------------------------------------------
// 1. Captura del celular declarado
// ---------------------------------------------------------------------------
assert(normalizeTelefonoContactoDisplay(TEL_DECLARADO) === TEL_DECLARADO, "se guarda tal cual");
assert(normalizeTelefonoContactoDisplay("0973 592 372") === "0973 592 372", "respeta espacios");
assert(normalizeTelefonoContactoDisplay("no tengo") === "", "texto suelto no es teléfono");
assert(normalizeTelefonoContactoDisplay("mi celu es 0973592372") === "", "frase con número tampoco");
assert(normalizeTelefonoContactoDisplay("123") === "", "pocos dígitos no es teléfono");
ok("sólo una respuesta que parece teléfono se toma como celular declarado");

for (const alias of ["telefono", "celular", "numero_celular", "nro_celular", "phone"]) {
  assert(
    readTelefonoContactoFromFlowData({ [alias]: TEL_DECLARADO }) === TEL_DECLARADO,
    `alias ${alias} reconocido`
  );
}
ok("se reconocen los alias típicos de la pregunta por el celular");

const flowCompleto: Record<string, string> = {
  nombre: "Karen",
  apellido: "Ayala",
  cedula: "1234567",
  ciudad: "Asunción",
  celular: TEL_DECLARADO,
  cantidad_boletos: "2",
};
const participante = parseSorteoParticipantFromFlowData(flowCompleto);
assert(participante != null, "el participante se arma");
assert(
  participante!.telefono_contacto === TEL_DECLARADO,
  `el celular declarado llega a la orden (obtenido: ${participante!.telefono_contacto})`
);
ok("el celular cargado en el bot viaja con los datos de la orden");

const sinTelefono = parseSorteoParticipantFromFlowData({
  nombre: "Karen",
  apellido: "Ayala",
  cedula: "1234567",
  cantidad_boletos: "2",
});
assert(sinTelefono != null, "un flujo que no pide celular sigue cerrando la compra");
assert(sinTelefono!.telefono_contacto === "", "sin captura, el campo queda vacío");
ok("un flujo sin pregunta de celular no queda bloqueado");

// ---------------------------------------------------------------------------
// 2. Qué se imprime en el PNG
// ---------------------------------------------------------------------------
const entradaBase = {
  clienteNombre: "Karen Ayala",
  documento: "1234567",
  telefono: WA_REMITENTE,
  telefonoContacto: TEL_DECLARADO,
  numeroOrdenStr: "6434",
  cupones: ["0020"],
  sorteoNombre: "Sorteo",
};

const conDeclarado = buildSorteoTicketRenderData({
  entradaDb: entradaBase,
  flowData: {},
  orderResult: orderResultVacio,
  sorteoNombreCatalog: "Sorteo",
});
assert(
  conDeclarado.fields.telefono === TEL_DECLARADO,
  `la boleta imprime el declarado (obtenido: ${conDeclarado.fields.telefono})`
);
assert(conDeclarado.fields.telefonoFuente === "declarado", "la fuente queda registrada");
ok("caso 6434: con celular declarado, la boleta ya no imprime el WhatsApp");

const ordenVieja = buildSorteoTicketRenderData({
  entradaDb: { ...entradaBase, telefonoContacto: "" },
  flowData: {},
  orderResult: orderResultVacio,
  sorteoNombreCatalog: "Sorteo",
});
assert(ordenVieja.fields.telefono === WA_REMITENTE, "respaldo para órdenes anteriores");
assert(ordenVieja.fields.telefonoFuente === "whatsapp", "queda marcado como respaldo");
ok("una orden vieja sin declarado no sale sin teléfono: usa el WhatsApp y lo marca");

const soloFlujo = buildSorteoTicketRenderData({
  entradaDb: { ...entradaBase, telefonoContacto: "" },
  flowData: { celular: TEL_DECLARADO },
  orderResult: orderResultVacio,
  sorteoNombreCatalog: "Sorteo",
});
assert(soloFlujo.fields.telefono === TEL_DECLARADO, "el flujo gana sobre el WhatsApp");
ok("si la columna todavía está vacía, vale lo capturado en el flujo antes que el WhatsApp");

// ---------------------------------------------------------------------------
// 3. El teléfono es identidad: no se hereda ni sobrevive al 'No, ingresar nuevo'
// ---------------------------------------------------------------------------
for (const alias of ["telefono", "celular", "numero_celular", "whatsapp"]) {
  assert(isIdentityCaptureField(alias), `${alias} clasifica como identidad`);
}
ok("el celular es dato de identidad: no se hereda de compras anteriores");

const clearSet = new Set(IDENTITY_RECALL_CLEAR_FIELDS.map((k) => k.toLowerCase()));
for (const alias of ["telefono", "celular", "numero_celular", "nro_celular", "whatsapp", "phone"]) {
  assert(clearSet.has(alias), `"No, ingresar nuevo" limpia ${alias}`);
}
ok("comprar para otra persona borra también el celular del comprador anterior");

assert(
  !flowDataHasValueForCaptureSaveField({ nombre: "Karen" }, "celular"),
  "sin celular cargado el gate lo ve faltante"
);
assert(
  flowDataHasValueForCaptureSaveField({ telefono: TEL_DECLARADO }, "celular"),
  "un alias cargado alcanza para darlo por capturado"
);
ok("el gate de completitud pide el celular cuando falta");

// ---------------------------------------------------------------------------
// 4. Recompra rápida
// ---------------------------------------------------------------------------
const recallSinDeclarado = buildIdentityRecallFlowDataWrites({
  clienteId: "c1",
  nombreCompleto: "Karen Ayala",
  cedula: "1234567",
  ciudad: "Asunción",
  telefono: "",
});
assert(
  !recallSinDeclarado.some((r) => r.field_name === "telefono"),
  "sin celular declarado previo, el 'Sí' no escribe teléfono"
);
ok("la recompra rápida no da por confirmado un número que la persona nunca declaró");

const recallConDeclarado = buildIdentityRecallFlowDataWrites({
  clienteId: "c1",
  nombreCompleto: "Karen Ayala",
  cedula: "1234567",
  ciudad: "Asunción",
  telefono: TEL_DECLARADO,
});
assert(
  recallConDeclarado.some((r) => r.field_name === "telefono" && r.field_value === TEL_DECLARADO),
  "con celular declarado previo, el 'Sí' lo reutiliza"
);
ok("el recomprador confirma el celular que ya había declarado");

console.log(`\n${passed} pruebas OK`);
