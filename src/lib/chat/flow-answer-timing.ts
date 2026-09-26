/**
 * ¿Un texto del cliente puede ser la respuesta a la pregunta que tiene el bot en pantalla?
 *
 * Helpers puros (sin DB) para que la regla se pueda probar contra líneas de tiempo reales.
 * Contexto: en producción, textos como "Listo" que el cliente manda justo después de la imagen
 * del comprobante caían en el hueco de ~2,5 s entre que el bot pasa a `cedula` y la pregunta sale,
 * y quedaban guardados como cédula; desde ahí la carga de datos se corría un lugar.
 */

/** Margen: redondeo del timestamp de Meta a segundos + desfase de relojes. */
export const PREDATES_TOLERANCE_MS = 2000;

export type NodeSentRow = { node_code?: string | null; created_at?: string | null };

function toMs(iso: string | null | undefined): number | null {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

/**
 * De los `node_sent` de la sesión (más nuevo primero): la última pregunta enviada y el PRIMER
 * envío de su racha actual. Si la misma pregunta se reenvió, una respuesta posterior al primer
 * envío es válida. Un envío de esa pregunta antes de pasar por otro nodo ya no cuenta.
 */
export function latestQuestionRun(
  rowsNewestFirst: NodeSentRow[]
): { nodeCode: string; sentAtMs: number | null; firstSentAtMs: number | null } | null {
  const newest = rowsNewestFirst[0];
  const code = typeof newest?.node_code === "string" ? newest.node_code.trim() : "";
  if (!code) return null;
  let firstSentAtMs = toMs(newest.created_at);
  for (const r of rowsNewestFirst.slice(1)) {
    if ((r.node_code ?? "").trim() !== code) break;
    firstSentAtMs = toMs(r.created_at) ?? firstSentAtMs;
  }
  return { nodeCode: code, sentAtMs: toMs(newest.created_at), firstSentAtMs };
}

/** Hora en que el cliente ENVIÓ el mensaje, desde el payload de Meta (`timestamp`, segundos). */
export function clientSentAtMsFromRaw(raw: Record<string, unknown> | null | undefined): number | null {
  const ts = raw?.timestamp;
  if (typeof ts !== "string" && typeof ts !== "number") return null;
  const n = Number(ts);
  return Number.isFinite(n) && n > 0 ? n * 1000 : null;
}

/** true = el mensaje se escribió antes de que saliera la pregunta: no es su respuesta. */
export function textPredatesQuestion(input: {
  clientSentAtMs: number | null;
  questionFirstSentAtMs: number | null;
  toleranceMs?: number;
}): boolean {
  const { clientSentAtMs, questionFirstSentAtMs } = input;
  if (clientSentAtMs == null || questionFirstSentAtMs == null) return false;
  return clientSentAtMs < questionFirstSentAtMs - (input.toleranceMs ?? PREDATES_TOLERANCE_MS);
}
