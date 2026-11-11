/** Configuración en `chat_channels.config.comprobante_validation` */

export type OcrFieldKey = "monto" | "referencia" | "fecha" | "hora" | "banco" | "texto_completo";

export type OnMissingBehavior = "continuar" | "revision_manual" | "bloquear";

export type ComprobanteEstadoValidacion =
  | "pendiente"
  | "valido"
  | "duplicado_hash"
  | "duplicado_ocr"
  | "revision_manual"
  | "ocr_error"
  | "monto_incoherente"
  | "datos_bancarios_incoherentes"
  | "aprobado_manual"
  | "rechazado_manual";

export interface OcrFieldRule {
  analyzed: boolean;
  use_duplicate_detection: boolean;
  required: boolean;
  on_missing: OnMissingBehavior;
}

export interface ComprobanteValidationMessages {
  hash_duplicado: string;
  ocr_duplicado: string;
  /**
   * Coincidencia débil (p. ej. solo huella de texto OCR sin referencia robusta): no acusa «pago ya usado».
   */
  ocr_coincidencia_debil: string;
  revision_manual: string;
  ocr_insuficiente: string;
  /** Monto del comprobante no coincide con el elegido en el flujo (validación opt-in). */
  monto_incoherente: string;
  /** Datos bancarios del OCR no coinciden con los configurados en el canal (opt-in). */
  datos_bancarios_incoherentes: string;
  boton_otro_titulo: string;
  boton_asesor_titulo: string;
}

/** Datos bancarios esperados en el canal (no se leen del flujo). */
export interface DatosBancariosEsperadosConfig {
  titular: string;
  numero_cuenta: string;
  alias: string;
}

export interface ComprobanteValidationSettings {
  /** Maestro: si false, no se aplica capa (flujo actual sin cambios). */
  enabled: boolean;
  /**
   * Si true, tras OCR compara monto detectado vs monto en chat_flow_data del flow_session_id activo.
   * Por defecto false: no altera el comportamiento existente.
   */
  validar_monto_vs_flujo: boolean;
  /** Tolerancia en guaraníes: abs(ocr - esperado) <= tolerancia se considera válido. */
  monto_tolerancia_absoluta_gs: number;
  /** Orden de lectura de field_name en chat_flow_data para el monto esperado. */
  monto_fields_prioridad: string[];
  /**
   * Si true, compara titular / cuenta / alias detectados en OCR con datos_bancarios_esperados del canal.
   */
  validar_datos_bancarios_ocr: boolean;
  datos_bancarios_esperados: DatosBancariosEsperadosConfig;
  /**
   * Otras cuentas donde también se cobra (p. ej. BNF + Continental). Un comprobante es válido si
   * coincide con la principal o con cualquiera de estas. Vacío = comportamiento de siempre.
   */
  cuentas_bancarias_adicionales: DatosBancariosEsperadosConfig[];
  /** Mínimo de coincidencias entre pares (titular, cuenta, alias) requeridas; acotado al número de campos esperados no vacíos. */
  min_coincidencias_bancarias: number;
  deteccion_duplicados_hash: boolean;
  ocr_obligatorio: boolean;
  bloquear_por_hash_duplicado: boolean;
  bloquear_por_ocr_duplicado: boolean;
  revision_manual_si_sospecha_ocr: boolean;
  /** Si true, en revisión manual se marca conversación en modo humano (deja de responder el bot). */
  revision_manual_activar_takeover: boolean;
  /** Texto OCR más corto que esto → sospecha (si el toggle de sospecha está activo). */
  ocr_min_chars_sospecha: number;
  /** Cuando falla OCR o PDF sin OCR automático. */
  ocr_fallo_comportamiento: OnMissingBehavior;
  messages: ComprobanteValidationMessages;
  ocr_fields: Record<OcrFieldKey, OcrFieldRule>;
}

export const COMPROBANTE_BUTTON_IDS = {
  enviar_otro: "cmp_enviar_otro",
  hablar_asesor: "cmp_hablar_asesor",
} as const;

/** Claves en `chat_flow_data` (por flow_session_id). */
export const SORTEO_COMPROBANTE_VALIDACION_ID_FIELD = "sorteo_comprobante_validacion_id";
export const SORTEO_COMPROBANTE_ESTADO_VALIDACION_FIELD = "sorteo_comprobante_estado_validacion";
export const SORTEO_COMPROBANTE_MOTIVO_VALIDACION_FIELD = "sorteo_comprobante_motivo_validacion";
/** Manual inbox: comprobante OK pero faltan datos del participante para crear entrada. */
export const MOTIVO_VALIDACION_ASESOR_PENDIENTE_DATOS = "asesor_aprobo_pendiente_datos";
/** Manual inbox: datos completos; el cliente debe confirmar en el flujo antes de crear entrada. */
export const MOTIVO_VALIDACION_ASESOR_PENDIENTE_CONFIRMACION_CLIENTE =
  "asesor_aprobo_pendiente_confirmacion_cliente";
/** Flag en chat_flow_data cuando el asesor aprobó pendiente de datos del cliente. */
export const FLOW_SORTEO_PENDIENTE_DATOS_PARTICIPANTE_FIELD = "sorteo_pendiente_datos_participante";
export const SORTEO_COMPROBANTE_HASH_FIELD = "sorteo_comprobante_hash";
export const SORTEO_COMPROBANTE_OCR_TEXT_FIELD = "sorteo_comprobante_ocr_text_raw";
export const SORTEO_COMPROBANTE_OCR_MONTO_FIELD = "sorteo_comprobante_ocr_monto";
export const SORTEO_COMPROBANTE_OCR_REF_FIELD = "sorteo_comprobante_ocr_referencia";
export const SORTEO_COMPROBANTE_OCR_FECHA_FIELD = "sorteo_comprobante_ocr_fecha";
export const SORTEO_COMPROBANTE_OCR_HORA_FIELD = "sorteo_comprobante_ocr_hora";
export const SORTEO_COMPROBANTE_OCR_BANCO_FIELD = "sorteo_comprobante_ocr_banco";

/** Fila de `chat_comprobante_validaciones` en el panel de conversaciones. */
export type ComprobanteValidacionListRow = {
  id: string;
  estado_validacion: string;
  motivo_validacion: string | null;
  comprobante_url: string | null;
  /** Si ya se generó entrada de sorteo (compra cerrada). */
  sorteo_entrada_id?: string | null;
  manual_approval_at?: string | null;
  flow_code: string;
  created_at: string;
  ocr_referencia: string | null;
  ocr_monto: string | null;
  monto_validacion_esperado_gs: number | null;
  monto_validacion_ocr_gs: number | null;
  monto_validacion_diferencia_gs: number | null;
  monto_validacion_status: string | null;
  bank_val_titular_esperado: string | null;
  bank_val_cuenta_esperada: string | null;
  bank_val_alias_esperado: string | null;
  bank_val_titular_ocr: string | null;
  bank_val_cuenta_ocr: string | null;
  bank_val_alias_ocr: string | null;
  bank_val_coincidencias: number | null;
  bank_val_min_requeridas: number | null;
  bank_val_status: string | null;
};

export const DEFAULT_COMPROBANTE_VALIDATION_MESSAGES: ComprobanteValidationMessages = {
  hash_duplicado:
    "Este comprobante ya fue registrado en una compra anterior. Si es un error, enviá otro comprobante o hablá con un asesor.",
  ocr_duplicado:
    "Detectamos que los datos del comprobante coinciden con un pago ya registrado. Enviá otro comprobante o contactá a un asesor.",
  ocr_coincidencia_debil:
    "No pudimos validar automáticamente tu comprobante. Un asesor lo revisará; en breve te contactamos.",
  revision_manual:
    "Recibimos tu comprobante. Nuestro equipo lo está revisando; en breve te confirmamos. Podés seguir con los datos si el flujo te lo pide.",
  ocr_insuficiente:
    "No pudimos leer bien el comprobante. Enviá una foto más clara o hablá con un asesor.",
  monto_incoherente:
    "El comprobante recibido no coincide con el monto seleccionado. Podés reenviar el comprobante o hablar con un asesor.",
  datos_bancarios_incoherentes:
    "El comprobante no coincide con los datos bancarios esperados. Podés reenviar el comprobante o hablar con un asesor.",
  boton_otro_titulo: "Otro comprobante",
  boton_asesor_titulo: "Hablar con asesor",
};

function defaultOcrFieldRule(partial: Partial<OcrFieldRule> = {}): OcrFieldRule {
  return {
    analyzed: partial.analyzed ?? true,
    use_duplicate_detection: partial.use_duplicate_detection ?? false,
    required: partial.required ?? false,
    on_missing: partial.on_missing ?? "continuar",
  };
}

export function defaultComprobanteValidationSettings(): ComprobanteValidationSettings {
  return {
    enabled: false,
    validar_monto_vs_flujo: false,
    monto_tolerancia_absoluta_gs: 0,
    monto_fields_prioridad: ["monto", "monto_compra", "sorteo_monto_opcion"],
    validar_datos_bancarios_ocr: false,
    datos_bancarios_esperados: { titular: "", numero_cuenta: "", alias: "" },
    cuentas_bancarias_adicionales: [],
    min_coincidencias_bancarias: 1,
    deteccion_duplicados_hash: true,
    ocr_obligatorio: true,
    bloquear_por_hash_duplicado: true,
    bloquear_por_ocr_duplicado: true,
    revision_manual_si_sospecha_ocr: true,
    revision_manual_activar_takeover: false,
    ocr_min_chars_sospecha: 24,
    ocr_fallo_comportamiento: "revision_manual",
    messages: { ...DEFAULT_COMPROBANTE_VALIDATION_MESSAGES },
    ocr_fields: {
      monto: defaultOcrFieldRule({ analyzed: true, required: false, on_missing: "continuar" }),
      referencia: defaultOcrFieldRule({
        analyzed: true,
        use_duplicate_detection: true,
        required: false,
        on_missing: "continuar",
      }),
      fecha: defaultOcrFieldRule({ analyzed: true, required: false, on_missing: "continuar" }),
      hora: defaultOcrFieldRule({ analyzed: true, required: false, on_missing: "continuar" }),
      banco: defaultOcrFieldRule({ analyzed: true, required: false, on_missing: "continuar" }),
      texto_completo: defaultOcrFieldRule({
        analyzed: true,
        use_duplicate_detection: false,
        required: false,
        on_missing: "continuar",
      }),
    },
  };
}

function isOnMissingBehavior(v: unknown): v is OnMissingBehavior {
  return v === "continuar" || v === "revision_manual" || v === "bloquear";
}

function mergeOcrFieldRule(raw: unknown, fallback: OcrFieldRule): OcrFieldRule {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...fallback };
  const o = raw as Record<string, unknown>;
  const onMissing = o.on_missing;
  return {
    analyzed: typeof o.analyzed === "boolean" ? o.analyzed : fallback.analyzed,
    use_duplicate_detection:
      typeof o.use_duplicate_detection === "boolean" ? o.use_duplicate_detection : fallback.use_duplicate_detection,
    required: typeof o.required === "boolean" ? o.required : fallback.required,
    on_missing: isOnMissingBehavior(onMissing) ? onMissing : fallback.on_missing,
  };
}

export function parseComprobanteValidationConfig(config: unknown): ComprobanteValidationSettings {
  const base = defaultComprobanteValidationSettings();
  if (!config || typeof config !== "object" || Array.isArray(config)) return base;
  const root = (config as Record<string, unknown>).comprobante_validation;
  if (!root || typeof root !== "object" || Array.isArray(root)) return base;
  const r = root as Record<string, unknown>;
  const messagesRaw = r.messages;
  const messages =
    messagesRaw && typeof messagesRaw === "object" && !Array.isArray(messagesRaw)
      ? (messagesRaw as Record<string, unknown>)
      : {};

  const mergedMessages: ComprobanteValidationMessages = {
    hash_duplicado:
      typeof messages.hash_duplicado === "string" && messages.hash_duplicado.trim()
        ? messages.hash_duplicado.trim()
        : base.messages.hash_duplicado,
    ocr_duplicado:
      typeof messages.ocr_duplicado === "string" && messages.ocr_duplicado.trim()
        ? messages.ocr_duplicado.trim()
        : base.messages.ocr_duplicado,
    ocr_coincidencia_debil:
      typeof messages.ocr_coincidencia_debil === "string" && messages.ocr_coincidencia_debil.trim()
        ? messages.ocr_coincidencia_debil.trim()
        : base.messages.ocr_coincidencia_debil,
    revision_manual:
      typeof messages.revision_manual === "string" && messages.revision_manual.trim()
        ? messages.revision_manual.trim()
        : base.messages.revision_manual,
    ocr_insuficiente:
      typeof messages.ocr_insuficiente === "string" && messages.ocr_insuficiente.trim()
        ? messages.ocr_insuficiente.trim()
        : base.messages.ocr_insuficiente,
    boton_otro_titulo:
      typeof messages.boton_otro_titulo === "string" && messages.boton_otro_titulo.trim()
        ? messages.boton_otro_titulo.trim().slice(0, 20)
        : base.messages.boton_otro_titulo,
    boton_asesor_titulo:
      typeof messages.boton_asesor_titulo === "string" && messages.boton_asesor_titulo.trim()
        ? messages.boton_asesor_titulo.trim().slice(0, 20)
        : base.messages.boton_asesor_titulo,
    monto_incoherente:
      typeof messages.monto_incoherente === "string" && messages.monto_incoherente.trim()
        ? messages.monto_incoherente.trim()
        : base.messages.monto_incoherente,
    datos_bancarios_incoherentes:
      typeof messages.datos_bancarios_incoherentes === "string" && messages.datos_bancarios_incoherentes.trim()
        ? messages.datos_bancarios_incoherentes.trim()
        : base.messages.datos_bancarios_incoherentes,
  };

  const ocrFieldsRaw = r.ocr_fields;
  const ocrMerged = { ...base.ocr_fields };
  if (ocrFieldsRaw && typeof ocrFieldsRaw === "object" && !Array.isArray(ocrFieldsRaw)) {
    const of = ocrFieldsRaw as Record<string, unknown>;
    for (const k of Object.keys(ocrMerged) as OcrFieldKey[]) {
      if (of[k] !== undefined) {
        ocrMerged[k] = mergeOcrFieldRule(of[k], base.ocr_fields[k]);
      }
    }
  }

  const fallo = r.ocr_fallo_comportamiento;

  let montoFields: string[] = base.monto_fields_prioridad;
  const mfp = r.monto_fields_prioridad;
  if (Array.isArray(mfp)) {
    const cleaned = mfp
      .map((x) => (typeof x === "string" ? x.trim() : ""))
      .filter((x) => x.length > 0 && x.length <= 64)
      .slice(0, 20);
    if (cleaned.length > 0) montoFields = cleaned;
    else montoFields = [...base.monto_fields_prioridad];
  }

  const tolRaw = r.monto_tolerancia_absoluta_gs;
  const tolerancia =
    typeof tolRaw === "number" && Number.isFinite(tolRaw) && tolRaw >= 0
      ? Math.min(Math.trunc(tolRaw), 1_000_000_000)
      : base.monto_tolerancia_absoluta_gs;

  let datosBancarios: DatosBancariosEsperadosConfig = { ...base.datos_bancarios_esperados };
  const dbeRaw = r.datos_bancarios_esperados;
  if (dbeRaw && typeof dbeRaw === "object" && !Array.isArray(dbeRaw)) {
    const o = dbeRaw as Record<string, unknown>;
    const clip = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
    datosBancarios = {
      titular: clip(o.titular, 200),
      numero_cuenta: clip(o.numero_cuenta, 64),
      alias: clip(o.alias, 80),
    };
  }

  const clipCta = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const cuentasAdicionales: DatosBancariosEsperadosConfig[] = Array.isArray(r.cuentas_bancarias_adicionales)
    ? r.cuentas_bancarias_adicionales
        .filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === "object" && !Array.isArray(x))
        .map((o) => ({
          titular: clipCta(o.titular, 200),
          numero_cuenta: clipCta(o.numero_cuenta, 64),
          alias: clipCta(o.alias, 80),
        }))
        .filter((c) => Boolean(c.titular || c.numero_cuenta || c.alias))
        .slice(0, 10)
    : [];

  const minCoinRaw = r.min_coincidencias_bancarias;
  const minCoin =
    typeof minCoinRaw === "number" && Number.isFinite(minCoinRaw)
      ? Math.min(3, Math.max(1, Math.trunc(minCoinRaw)))
      : base.min_coincidencias_bancarias;

  const boolOr = (v: unknown, fallback: boolean): boolean =>
    typeof v === "boolean" ? v : fallback;

  return {
    enabled: boolOr(r.enabled, base.enabled),
    validar_monto_vs_flujo: r.validar_monto_vs_flujo === true,
    monto_tolerancia_absoluta_gs: tolerancia,
    monto_fields_prioridad: montoFields,
    validar_datos_bancarios_ocr: r.validar_datos_bancarios_ocr === true,
    datos_bancarios_esperados: datosBancarios,
    cuentas_bancarias_adicionales: cuentasAdicionales,
    min_coincidencias_bancarias: minCoin,
    deteccion_duplicados_hash: boolOr(r.deteccion_duplicados_hash, base.deteccion_duplicados_hash),
    ocr_obligatorio: boolOr(r.ocr_obligatorio, base.ocr_obligatorio),
    bloquear_por_hash_duplicado: boolOr(r.bloquear_por_hash_duplicado, base.bloquear_por_hash_duplicado),
    bloquear_por_ocr_duplicado: boolOr(r.bloquear_por_ocr_duplicado, base.bloquear_por_ocr_duplicado),
    revision_manual_si_sospecha_ocr: boolOr(
      r.revision_manual_si_sospecha_ocr,
      base.revision_manual_si_sospecha_ocr
    ),
    revision_manual_activar_takeover: r.revision_manual_activar_takeover === true,
    ocr_min_chars_sospecha:
      typeof r.ocr_min_chars_sospecha === "number" && r.ocr_min_chars_sospecha >= 0
        ? Math.min(500, Math.trunc(r.ocr_min_chars_sospecha))
        : base.ocr_min_chars_sospecha,
    ocr_fallo_comportamiento: isOnMissingBehavior(fallo) ? fallo : base.ocr_fallo_comportamiento,
    messages: mergedMessages,
    ocr_fields: ocrMerged,
  };
}

export function comprobanteValidationSettingsForForm(
  settings: ComprobanteValidationSettings
): Record<string, unknown> {
  return {
    enabled: settings.enabled,
    validar_monto_vs_flujo: settings.validar_monto_vs_flujo,
    monto_tolerancia_absoluta_gs: settings.monto_tolerancia_absoluta_gs,
    monto_fields_prioridad: [...settings.monto_fields_prioridad],
    validar_datos_bancarios_ocr: settings.validar_datos_bancarios_ocr,
    datos_bancarios_esperados: { ...settings.datos_bancarios_esperados },
    // Se conservan al guardar desde el panel (que no las edita) para no borrarlas sin querer.
    cuentas_bancarias_adicionales: settings.cuentas_bancarias_adicionales.map((c) => ({ ...c })),
    min_coincidencias_bancarias: settings.min_coincidencias_bancarias,
    deteccion_duplicados_hash: settings.deteccion_duplicados_hash,
    ocr_obligatorio: settings.ocr_obligatorio,
    bloquear_por_hash_duplicado: settings.bloquear_por_hash_duplicado,
    bloquear_por_ocr_duplicado: settings.bloquear_por_ocr_duplicado,
    revision_manual_si_sospecha_ocr: settings.revision_manual_si_sospecha_ocr,
    revision_manual_activar_takeover: settings.revision_manual_activar_takeover,
    ocr_min_chars_sospecha: settings.ocr_min_chars_sospecha,
    ocr_fallo_comportamiento: settings.ocr_fallo_comportamiento,
    messages: { ...settings.messages },
    ocr_fields: JSON.parse(JSON.stringify(settings.ocr_fields)),
  };
}
