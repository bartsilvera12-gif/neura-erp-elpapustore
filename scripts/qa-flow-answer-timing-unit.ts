/**
 * QA unitario (sin DB): ¿un texto del cliente cuenta como respuesta a la pregunta en pantalla?
 *
 * Reproduce líneas de tiempo REALES de producción (diagnóstico del 26-sep, Papu_store). De los
 * mensajes del cliente se conoce la hora en que el servidor los procesó, no la hora en que el
 * cliente los envió: se usa la suposición MÁS DESFAVORABLE para la regla (enviado 1 s antes de
 * procesarse). En la realidad la diferencia es mayor, así que el margen en producción es más amplio.
 *
 * Ejecutar: npx tsx scripts/qa-flow-answer-timing-unit.ts
 */
import {
  latestQuestionRun,
  clientSentAtMsFromRaw,
  textPredatesQuestion,
  type NodeSentRow,
} from "../src/lib/chat/flow-answer-timing";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}
let passed = 0;
function ok(msg: string) {
  passed += 1;
  console.log("OK:", msg);
}

const at = (iso: string) => Date.parse(iso);
/** Peor caso para la regla: el cliente envió 1 s antes de que el servidor procesara el mensaje. */
const sentBy = (processedIso: string) => at(processedIso) - 1000;

function decide(clientSentAtMs: number, nodeSentNewestFirst: NodeSentRow[]): "rechazado" | "aceptado" {
  const run = latestQuestionRun(nodeSentNewestFirst);
  return textPredatesQuestion({ clientSentAtMs, questionFirstSentAtMs: run?.firstSentAtMs ?? null })
    ? "rechazado"
    : "aceptado";
}

// ---------------------------------------------------------------------------
// Caso real 1 — 595993582312, 20-sep: imagen del comprobante y enseguida "Listo".
//   16:22:40.21 puntero → cedula · 16:22:41.73 "Listo" procesado · 16:22:42.84 sale la pregunta
// ---------------------------------------------------------------------------
{
  const nodeSent: NodeSentRow[] = [
    { node_code: "cedula", created_at: "2026-09-20T16:22:42.837Z" },
    { node_code: "pedido_de_comprobante", created_at: "2026-09-20T16:20:38.008Z" },
  ];
  assert(
    decide(sentBy("2026-09-20T16:22:41.729Z"), nodeSent) === "rechazado",
    '"Listo" no debe guardarse como cédula'
  );
  ok('caso real "Listo": escrito antes de que saliera la cédula → no se guarda');

  // La respuesta real de ese cliente a la cédula (en producción cayó en "nombre" por el corrimiento)
  assert(
    decide(sentBy("2026-09-20T16:23:31.932Z"), nodeSent) === "aceptado",
    "la cédula tipeada después de la pregunta sí es respuesta"
  );
  ok("caso real: la cédula 6985464, escrita después de la pregunta → se acepta");
}

// ---------------------------------------------------------------------------
// Caso real 2 — 595981645021, 22-sep: "Acá te paso mi comprobante".
//   16:25:59.03 procesado · 16:26:01.54 sale la cédula
// ---------------------------------------------------------------------------
{
  const nodeSent: NodeSentRow[] = [
    { node_code: "cedula", created_at: "2026-09-22T16:26:01.540Z" },
    { node_code: "pedido_de_comprobante", created_at: "2026-09-22T16:21:56.292Z" },
  ];
  assert(
    decide(sentBy("2026-09-22T16:25:59.027Z"), nodeSent) === "rechazado",
    '"Acá te paso mi comprobante" no es una cédula'
  );
  ok('caso real "Acá te paso mi comprobante" → no se guarda como cédula');
}

// ---------------------------------------------------------------------------
// Caso real 3 — 595974901809, 23-sep: tras "corregir datos" el cliente manda correcciones
// sueltas mientras el bot encadena preguntas. "Apellido" terminó guardado como NOMBRE.
//   16:31:55.55 "Apellido" procesado · 16:31:57.06 sale la pregunta del nombre
// ---------------------------------------------------------------------------
{
  const nodeSent: NodeSentRow[] = [
    { node_code: "primer_nombre", created_at: "2026-09-23T01:31:57.057Z" },
    { node_code: "cedula", created_at: "2026-09-23T01:31:54.435Z" },
    { node_code: "cedula", created_at: "2026-09-23T01:31:53.316Z" },
  ];
  assert(
    decide(sentBy("2026-09-23T01:31:55.548Z"), nodeSent) === "rechazado",
    '"Apellido" no debe quedar como nombre'
  );
  ok('caso real "Apellido": escrito antes de la pregunta del nombre → no se guarda');
}

// ---------------------------------------------------------------------------
// Respuestas legítimas que la regla NO puede tocar
// ---------------------------------------------------------------------------
{
  // Flujo normal real (595974901809): cédula enviada 01:22:37, respuesta procesada 01:22:59
  const nodeSent: NodeSentRow[] = [{ node_code: "cedula", created_at: "2026-09-23T01:22:37.184Z" }];
  assert(decide(sentBy("2026-09-23T01:22:59.370Z"), nodeSent) === "aceptado", "respuesta normal");
  ok("caso real normal: cédula respondida 22 s después de la pregunta → se acepta");

  // Respuesta rapidísima (1 s) y con reloj del cliente 1,5 s atrasado: dentro del margen
  const q = [{ node_code: "ciudad", created_at: "2026-09-26T10:00:00.000Z" }];
  assert(decide(at("2026-09-26T10:00:01.000Z"), q) === "aceptado", "respuesta de 1 s");
  assert(decide(at("2026-09-26T09:59:58.500Z"), q) === "aceptado", "desfase de reloj 1,5 s");
  ok("respuesta inmediata o con el reloj del cliente algo atrasado → se acepta");

  // Pregunta REENVIADA (botón "Reenviar paso actual"): la respuesta a la primera copia vale
  const resent: NodeSentRow[] = [
    { node_code: "cedula", created_at: "2026-09-26T10:02:00.000Z" },
    { node_code: "cedula", created_at: "2026-09-26T10:00:00.000Z" },
    { node_code: "verificacion", created_at: "2026-09-26T09:59:57.000Z" },
  ];
  assert(decide(at("2026-09-26T10:01:00.000Z"), resent) === "aceptado", "respuesta a la primera copia");
  ok("pregunta reenviada: la respuesta a la PRIMERA copia se acepta aunque sea anterior a la última");

  // Pero una visita ANTERIOR a esa pregunta (antes de pasar por otro nodo) no cuenta
  const revisit: NodeSentRow[] = [
    { node_code: "cedula", created_at: "2026-09-26T10:10:00.000Z" },
    { node_code: "primer_nombre", created_at: "2026-09-26T10:05:00.000Z" },
    { node_code: "cedula", created_at: "2026-09-26T10:00:00.000Z" },
  ];
  assert(decide(at("2026-09-26T10:06:00.000Z"), revisit) === "rechazado", "visita vieja no cuenta");
  ok("si el bot volvió a la cédula después del nombre, un mensaje de antes de volver no es respuesta");
}

// ---------------------------------------------------------------------------
// Sin datos no se descarta nada
// ---------------------------------------------------------------------------
{
  assert(clientSentAtMsFromRaw({ timestamp: "1727346000" }) === 1727346000 * 1000, "timestamp Meta");
  assert(clientSentAtMsFromRaw({}) === null, "sin timestamp");
  assert(
    !textPredatesQuestion({ clientSentAtMs: null, questionFirstSentAtMs: at("2026-09-26T10:00:00Z") }),
    "sin hora del cliente"
  );
  assert(
    !textPredatesQuestion({ clientSentAtMs: at("2026-09-26T09:00:00Z"), questionFirstSentAtMs: null }),
    "sin pregunta enviada"
  );
  assert(latestQuestionRun([]) === null, "sesión sin envíos");
  ok("si falta la hora del mensaje o de la pregunta, la regla no descarta nada");
}

console.log(`\n${passed} pruebas OK`);
