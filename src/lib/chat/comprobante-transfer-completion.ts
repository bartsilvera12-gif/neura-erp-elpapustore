/**
 * Distingue un comprobante de transferencia TERMINADA de una pantalla de la app del banco
 * a mitad de la operación (formulario de destinatario, pantalla de confirmación, token…).
 *
 * Heurística sobre el texto OCR: no reemplaza la revisión humana, solo evita aprobar
 * automáticamente capturas que claramente no son un comprobante.
 */

export type TransferCompletionStatus = "completada" | "en_proceso" | "indeterminada";

export type TransferCompletionAssessment = {
  status: TransferCompletionStatus;
  form_markers: string[];
  success_markers: string[];
};

/**
 * Textos típicos de formularios / pasos previos al envío en apps bancarias PY.
 * No incluir "tipo de documento": los comprobantes finales de Sudameris también lo muestran.
 */
const FORM_MARKERS = [
  "ingresa los datos",
  "persona que recibe",
  "sin puntos ni guiones",
  "nombre email com",
  "confirmar transferencia",
  "confirma la transferencia",
  "revisa los datos",
  "verifica los datos",
  "ingresa el monto",
  "ingresa tu clave",
  "ingresa el token",
  "ingresa tu token",
  "codigo de verificacion",
  "monto a transferir",
  "cuanto queres transferir",
  "a quien queres transferir",
  "cuanto dinero queres enviar",
  "saldo disponible",
  "alias no encontrado",
  "no se encontro el alias",
  "verifica el dato",
  "recordar esta cuenta",
  "selecciona una cuenta",
  "disculpe los inconvenientes",
  "siguiente",
] as const;

/** Textos que solo aparecen cuando la transferencia ya se hizo. */
const SUCCESS_MARKERS = [
  "exitosa",
  "exitoso",
  "realizada",
  "realizado",
  "enviaste",
  "transferiste",
  "transferencia enviada",
  "aprobada",
  "aprobado",
  "completada",
  "acreditada",
  "procesada",
  "comprobante de",
  "numero de operacion",
  "nro de operacion",
  "n de operacion",
  "codigo de operacion",
  "numero de transaccion",
  "nro de transaccion",
  "n de transaccion",
  "id de transaccion",
  "numero de comprobante",
  "nro de comprobante",
  "numero de soporte",
  "fecha de imputacion",
  "nueva transferencia",
  "compartir comprobante",
  "ya solicitamos el envio",
  "con exito",
  "procesando transferencia",
  "detalle de transferencia",
  "monto debitado",
  "n de comprobante",
  "enviado por",
] as const;

/** Minúsculas, sin acentos, solo letras/dígitos separados por un espacio. */
export function normalizeOcrForMarkers(text: string): string {
  return (text || "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function findMarkers(normalized: string, markers: readonly string[]): string[] {
  const padded = ` ${normalized} `;
  return markers.filter((m) => padded.includes(` ${m} `));
}

export function assessTransferCompletion(ocrText: string): TransferCompletionAssessment {
  const normalized = normalizeOcrForMarkers(ocrText);
  const form_markers = findMarkers(normalized, FORM_MARKERS);
  const success_markers = findMarkers(normalized, SUCCESS_MARKERS);
  let status: TransferCompletionStatus = "indeterminada";
  if (success_markers.length > 0) status = "completada";
  else if (form_markers.length > 0) status = "en_proceso";
  return { status, form_markers, success_markers };
}

export const MOTIVO_TRANSFERENCIA_NO_FINALIZADA = "transferencia_no_finalizada";
export const MOTIVO_MONTO_NO_DETECTADO = "monto_no_detectado_revision";
export const MOTIVO_TRANSFERENCIA_SIN_CONFIRMACION = "transferencia_sin_confirmacion_revision";
