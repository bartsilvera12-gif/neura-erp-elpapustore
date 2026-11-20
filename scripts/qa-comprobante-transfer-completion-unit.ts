/**
 * QA unitario (sin DB): una captura de la app del banco a mitad de la transferencia NO se aprueba.
 *
 * Caso real (20-nov): el cliente mandó la pantalla "Transferir a BANCO CONTINENTAL SAECA / Ingresá los
 * datos de la persona que recibe" (formulario sin completar, botón "Siguiente") y el bot lo dio por
 * válido y entregó las boletas. Se corre el pipeline real con el OCR simulado y una DB falsa vacía.
 *
 * Ejecutar: npx tsx --conditions=react-server scripts/qa-comprobante-transfer-completion-unit.ts
 */
import { assessTransferCompletion } from "../src/lib/chat/comprobante-transfer-completion";
import { runComprobanteValidationPipeline } from "../src/lib/chat/comprobante-validation-service";
import {
  defaultComprobanteValidationSettings,
  type ComprobanteValidationSettings,
} from "../src/lib/chat/comprobante-validation-types";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}
let passed = 0;
function ok(msg: string) {
  passed += 1;
  console.log("OK:", msg);
}

/** OCR de la captura reportada (formulario de destinatario, sin transferir). */
const OCR_FORMULARIO_CONTINENTAL = `14:49
Transferir a BANCO
CONTINENTAL SAECA
Ingresá los datos de la persona que
recibe.
Nombre y apellido
Héctor lopéz
Tipo de documento
Cédula de identidad
Cédula de identidad
Sin puntos ni guiones.
Mail
Ejemplo: nombre@email.com
+595
N° de celular
0/25
Departamento
Siguiente`;

const OCR_COMPROBANTE_OK = `¡Transferencia exitosa!
Monto Gs. 50.000
Destinatario Héctor López
Banco Continental
Cuenta 1234567890
Fecha 20/11/2026 14:52
Número de operación 987654321`;

const OCR_CONFIRMAR = `Revisá los datos
Monto a transferir
Gs. 50.000
Destinatario Héctor López
Banco Continental
Confirmar transferencia`;

const OCR_SIN_MONTO = `Comprobante de transferencia
Transferencia realizada
Destinatario Héctor López
Banco Continental`;

// --- Detector ---
{
  const a = assessTransferCompletion(OCR_FORMULARIO_CONTINENTAL);
  assert(a.status === "en_proceso", `formulario debe ser en_proceso, fue ${a.status}`);
  ok(`formulario Continental → en_proceso (${a.form_markers.join(", ")})`);
}
{
  const a = assessTransferCompletion(OCR_COMPROBANTE_OK);
  assert(a.status === "completada", `comprobante debe ser completada, fue ${a.status}`);
  ok(`comprobante final → completada (${a.success_markers.join(", ")})`);
}
{
  const a = assessTransferCompletion(OCR_CONFIRMAR);
  assert(a.status === "en_proceso", `pantalla de confirmación debe ser en_proceso, fue ${a.status}`);
  ok("pantalla 'Revisá los datos / Confirmar transferencia' → en_proceso");
}
{
  const a = assessTransferCompletion("Transferencia exitosa. Toca Siguiente para volver");
  assert(a.status === "completada", "un marcador de éxito gana sobre 'Siguiente'");
  ok("éxito + 'Siguiente' → completada");
}

// --- Pipeline real con DB falsa ---
function fakeSupabase() {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  for (const m of ["select", "eq", "in", "neq", "limit", "is", "not", "order"]) chain[m] = self;
  chain.maybeSingle = async () => ({ data: null, error: null });
  chain.single = async () => ({ data: { id: "00000000-0000-0000-0000-00000000v001" }, error: null });
  chain.insert = self;
  return { from: () => chain } as never;
}

async function run(ocr: string, settings: ComprobanteValidationSettings) {
  return runComprobanteValidationPipeline({
    supabase: fakeSupabase(),
    empresaId: "00000000-0000-0000-0000-000000000001",
    conversationId: "00000000-0000-0000-0000-000000000002",
    channelId: "00000000-0000-0000-0000-000000000003",
    flowCode: "Papu_store",
    flowSessionId: "00000000-0000-0000-0000-000000000004",
    mediaId: "m1",
    publicUrl: "https://example.invalid/c.jpg",
    bytes: Buffer.from(ocr),
    mimeType: "image/jpeg",
    settings,
    ocrTextOverride: ocr,
  });
}

async function main() {
  const settings = { ...defaultComprobanteValidationSettings(), enabled: true };

  {
    const r = await run(OCR_FORMULARIO_CONTINENTAL, settings);
    assert(r.kind === "resolved", "resolved");
    if (r.kind !== "resolved") return;
    assert(r.estado !== "valido", `formulario NO debe quedar válido (fue ${r.estado})`);
    assert(r.advance === false, "formulario no debe avanzar el flujo");
    assert(r.motivo.startsWith("transferencia_no_finalizada"), `motivo: ${r.motivo}`);
    assert(Boolean(r.sendInteractive?.body.includes("comprobante final")), "pide el comprobante final");
    ok(`pipeline: formulario → ${r.estado} / ${r.motivo}, no avanza, pide comprobante final`);
  }
  {
    const r = await run(OCR_COMPROBANTE_OK, settings);
    assert(r.kind === "resolved" && r.estado === "valido" && r.advance, `comprobante OK debe ser válido`);
    ok("pipeline: comprobante final con monto → valido");
  }
  {
    const r = await run(OCR_SIN_MONTO, settings);
    assert(r.kind === "resolved" && r.estado === "revision_manual", "sin monto → revisión manual");
    ok("pipeline: comprobante sin monto legible → revision_manual (no se aprueba solo)");
  }
  {
    const legacy = {
      ...settings,
      bloquear_transferencia_en_proceso: false,
      revision_manual_sin_monto_ocr: false,
    };
    const r = await run(OCR_FORMULARIO_CONTINENTAL, legacy);
    assert(r.kind === "resolved" && r.estado === "valido", "con ambas reglas apagadas, comportamiento anterior");
    ok("con las reglas apagadas se reproduce el bug original (formulario → valido)");
  }

  console.log(`\n${passed} OK`);
}

main().catch((e) => {
  console.error("FAIL:", e instanceof Error ? e.message : e);
  process.exit(1);
});
