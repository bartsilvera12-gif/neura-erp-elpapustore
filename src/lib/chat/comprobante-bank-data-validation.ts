import type { ComprobanteValidationSettings, DatosBancariosEsperadosConfig } from "@/lib/chat/comprobante-validation-types";

export type BankDetailsOcr = {
  titular: string;
  numero_cuenta: string;
  alias: string;
};

export type BankValidationAuditStatus =
  | "omitido_config"
  | "omitido_sin_esperado"
  | "omitido_sin_ocr_bancario"
  | "coincide"
  | "discrepancia";

export type BankValidationAudit = {
  bank_val_titular_esperado: string | null;
  bank_val_cuenta_esperada: string | null;
  bank_val_alias_esperado: string | null;
  bank_val_titular_ocr: string | null;
  bank_val_cuenta_ocr: string | null;
  bank_val_alias_ocr: string | null;
  bank_val_coincidencias: number | null;
  bank_val_min_requeridas: number | null;
  bank_val_status: BankValidationAuditStatus | null;
};

function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "");
}

/** Titular / alias: minúsculas, sin acentos, espacios colapsados. */
export function normalizeBankText(s: string): string {
  return stripAccents(s.trim().toLowerCase()).replace(/\s+/g, " ").trim();
}

/** Cuenta: solo dígitos. */
export function normalizeBankAccountDigits(s: string): string {
  return String(s).replace(/\D/g, "");
}

/**
 * Heurística mínima sobre texto OCR completo (no reemplaza el extractor de monto/referencia).
 */
export function extractBankDetailsFromOcr(fullText: string): BankDetailsOcr {
  const t = fullText || "";

  let alias = "";
  const aliasPatterns = [
    /(?:^|\n|\r)\s*alias\s*[:\s.-]+\s*([A-Za-z0-9._-]{3,48})/im,
    /\bALIAS\s*[:\s]+\s*([A-Za-z0-9._-]{3,48})/,
    /(?:cvu|cbu)\s*[:\s.-]+\s*([A-Za-z0-9]{8,32})/i,
  ];
  for (const re of aliasPatterns) {
    const m = t.match(re);
    if (m?.[1]) {
      alias = m[1].trim();
      break;
    }
  }

  let numero_cuenta = "";
  const cuentaRe =
    /(?:cuenta|n[°º]?\s*cuenta|c\/a|c\.?\s*a\.?|c\.?\s*c\.?|cta\.?|caja\s+de\s+ahorro|cuenta\s+corriente)\s*[:\s#.-]*([0-9][0-9\s.\-]{5,24})/i;
  const cm = t.match(cuentaRe);
  if (cm?.[1]) {
    numero_cuenta = normalizeBankAccountDigits(cm[1]);
  }
  if (!numero_cuenta || numero_cuenta.length < 6) {
    const runs = [...t.matchAll(/\b(\d{8,18})\b/g)];
    if (runs.length > 0) {
      const best = runs.sort((a, b) => b[1].length - a[1].length)[0]?.[1] ?? "";
      if (best.length >= 8) numero_cuenta = best;
    }
  }

  let titular = "";
  const titRe =
    /(?:titular|beneficiario|orden\s+de|a\s+nombre\s+de|a\s+favor\s+de|favor\s+de|destinatario)\s*[:\s#.-]+([^\n\r|]{3,100})/i;
  const tm = t.match(titRe);
  if (tm?.[1]) {
    titular = tm[1]
      .split(/[\n\r|]/)[0]
      .replace(/\s+/g, " ")
      .trim();
  }

  return { titular, numero_cuenta, alias };
}

function hasAnyOcrBank(b: BankDetailsOcr): boolean {
  return Boolean(b.titular.trim() || b.numero_cuenta.trim() || b.alias.trim());
}

function countExpectedNonEmpty(e: DatosBancariosEsperadosConfig): number {
  let n = 0;
  if (e.titular.trim()) n++;
  if (e.numero_cuenta.trim()) n++;
  if (e.alias.trim()) n++;
  return n;
}

function titularMatches(expected: string, ocr: string): boolean {
  const a = normalizeBankText(expected);
  const b = normalizeBankText(ocr);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

function cuentaMatches(expected: string, ocr: string): boolean {
  const a = normalizeBankAccountDigits(expected);
  const b = normalizeBankAccountDigits(ocr);
  if (a.length < 4 || b.length < 4) return false;
  return a === b || a.endsWith(b) || b.endsWith(a);
}

function aliasMatches(expected: string, ocr: string): boolean {
  const a = normalizeBankText(expected);
  const b = normalizeBankText(ocr);
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  /** CI/RUC/CVU con guiones vs OCR sin guiones o solo dígitos */
  const da = normalizeBankAccountDigits(expected);
  const db = normalizeBankAccountDigits(ocr);
  if (da.length >= 6 && db.length >= 6 && da === db) return true;
  return false;
}

/**
 * True si la referencia extraída por OCR coincide con identificadores bancarios configurados
 * (cuenta, alias, RUC/dígitos en titular). Esa cadena no debe usarse como clave de duplicado
 * fuerte: suele ser cuenta destino o dato estático repetido, no número de operación.
 */
export function ocrReferenciaMatchesConfiguredMerchantIdentifiers(
  refRaw: string | null | undefined,
  datos: DatosBancariosEsperadosConfig | undefined | null
): boolean {
  if (!datos || !(refRaw ?? "").trim()) return false;
  const ref = (refRaw ?? "").trim();

  if (datos.numero_cuenta.trim() && cuentaMatches(datos.numero_cuenta, ref)) return true;
  if (datos.alias.trim() && aliasMatches(datos.alias, ref)) return true;

  const titDig = normalizeBankAccountDigits(datos.titular);
  const refDig = normalizeBankAccountDigits(ref);
  if (titDig.length >= 6 && refDig.length >= 6 && titDig === refDig) return true;

  return false;
}

/**
 * Si los regex no encontraron campos, o devolvieron algo que no coincide, pero el texto OCR
 * contiene los valores del canal, usamos esos (comprobantes sin etiquetas o extractor enganchando otro bloque).
 */
function supplementBankDetailsFromFullText(
  fullText: string,
  expected: DatosBancariosEsperadosConfig,
  ocr: BankDetailsOcr
): BankDetailsOcr {
  const ft = fullText || "";
  const mergedNorm = normalizeBankText(ft);
  const digitsBlob = normalizeBankAccountDigits(ft);

  const out: BankDetailsOcr = {
    titular: ocr.titular.trim(),
    numero_cuenta: ocr.numero_cuenta.trim(),
    alias: ocr.alias.trim(),
  };

  const titExp = expected.titular.trim();
  if (titExp) {
    const nt = normalizeBankText(titExp);
    const inText = nt.length >= 3 && mergedNorm.includes(nt);
    if (inText && (!out.titular || !titularMatches(titExp, out.titular))) {
      out.titular = titExp;
    }
  }

  const cuentaExp = expected.numero_cuenta.trim();
  const cuentaDig = normalizeBankAccountDigits(cuentaExp);
  if (cuentaDig.length >= 6) {
    if (digitsBlob.includes(cuentaDig) && (!out.numero_cuenta || !cuentaMatches(cuentaExp, out.numero_cuenta))) {
      out.numero_cuenta = cuentaDig;
    }
  }

  const aliasExp = expected.alias.trim();
  if (aliasExp) {
    const na = normalizeBankText(aliasExp);
    const aliasDig = normalizeBankAccountDigits(aliasExp);
    const inTextNorm = na.length >= 2 && mergedNorm.includes(na);
    const inTextDig = aliasDig.length >= 6 && digitsBlob.includes(aliasDig);
    if (
      (inTextNorm || inTextDig) &&
      (!out.alias || !aliasMatches(aliasExp, out.alias))
    ) {
      out.alias = aliasExp;
    }
  }

  return out;
}

function countPairwiseMatches(expected: DatosBancariosEsperadosConfig, ocr: BankDetailsOcr): number {
  let m = 0;
  if (expected.titular.trim() && ocr.titular.trim() && titularMatches(expected.titular, ocr.titular)) m++;
  if (expected.numero_cuenta.trim() && ocr.numero_cuenta.trim() && cuentaMatches(expected.numero_cuenta, ocr.numero_cuenta))
    m++;
  if (expected.alias.trim() && ocr.alias.trim() && aliasMatches(expected.alias, ocr.alias)) m++;
  return m;
}

export type ValidateReceiptBankDataResult =
  | { apply: false; audit: BankValidationAudit }
  | { apply: true; ok: true; audit: BankValidationAudit }
  | { apply: true; ok: false; audit: BankValidationAudit; motivoDetalle: string };

const emptyAuditPartial = (): Omit<BankValidationAudit, "bank_val_status"> => ({
  bank_val_titular_esperado: null,
  bank_val_cuenta_esperada: null,
  bank_val_alias_esperado: null,
  bank_val_titular_ocr: null,
  bank_val_cuenta_ocr: null,
  bank_val_alias_ocr: null,
  bank_val_coincidencias: null,
  bank_val_min_requeridas: null,
});

/** Cuenta principal + adicionales del canal (las que reciben pagos hoy). */
export function cuentasBancariasVigentes(settings: ComprobanteValidationSettings): DatosBancariosEsperadosConfig[] {
  return [settings.datos_bancarios_esperados, ...(settings.cuentas_bancarias_adicionales ?? [])];
}

/** Igual que `ocrReferenciaMatchesConfiguredMerchantIdentifiers` pero contra todas las cuentas vigentes. */
export function ocrReferenciaMatchesAnyConfiguredAccount(
  refRaw: string | null | undefined,
  settings: ComprobanteValidationSettings
): boolean {
  return cuentasBancariasVigentes(settings).some((d) => ocrReferenciaMatchesConfiguredMerchantIdentifiers(refRaw, d));
}

/**
 * Compara datos bancarios del OCR con los configurados en el canal (no usa flujo).
 * Con cuentas adicionales, el comprobante es válido si coincide con cualquiera; si no coincide
 * con ninguna se informa el resultado contra la cuenta principal (igual que antes).
 */
export function validateReceiptBankDataAgainstExpected(
  settings: ComprobanteValidationSettings,
  fullTextOcr: string
): ValidateReceiptBankDataResult {
  const principal = validateReceiptBankDataAgainstOneAccount(settings, settings.datos_bancarios_esperados, fullTextOcr);
  const extras = settings.cuentas_bancarias_adicionales ?? [];
  if (!settings.validar_datos_bancarios_ocr || extras.length === 0 || (principal.apply && principal.ok)) {
    return principal;
  }
  for (const cuenta of extras) {
    const r = validateReceiptBankDataAgainstOneAccount(settings, cuenta, fullTextOcr);
    if (r.apply && r.ok) return r;
  }
  return principal;
}

function validateReceiptBankDataAgainstOneAccount(
  settings: ComprobanteValidationSettings,
  exp: DatosBancariosEsperadosConfig,
  fullTextOcr: string
): ValidateReceiptBankDataResult {
  const baseAudit = (status: BankValidationAuditStatus): BankValidationAudit => ({
    ...emptyAuditPartial(),
    bank_val_status: status,
  });

  if (!settings.validar_datos_bancarios_ocr) {
    return { apply: false, audit: baseAudit("omitido_config") };
  }

  const nExp = countExpectedNonEmpty(exp);
  if (nExp === 0) {
    return { apply: false, audit: baseAudit("omitido_sin_esperado") };
  }

  const ocrRaw = extractBankDetailsFromOcr(fullTextOcr);
  const ocr = supplementBankDetailsFromFullText(fullTextOcr, exp, ocrRaw);
  if (!hasAnyOcrBank(ocr)) {
    return {
      apply: false,
      audit: {
        bank_val_titular_esperado: exp.titular.trim() || null,
        bank_val_cuenta_esperada: exp.numero_cuenta.trim() || null,
        bank_val_alias_esperado: exp.alias.trim() || null,
        bank_val_titular_ocr: null,
        bank_val_cuenta_ocr: null,
        bank_val_alias_ocr: null,
        bank_val_coincidencias: null,
        bank_val_min_requeridas: null,
        bank_val_status: "omitido_sin_ocr_bancario",
      },
    };
  }

  const minCfg = Math.max(1, Math.min(3, Math.trunc(settings.min_coincidencias_bancarias) || 1));
  const minReq = Math.min(minCfg, nExp);
  const matches = countPairwiseMatches(exp, ocr);

  const auditFull: BankValidationAudit = {
    bank_val_titular_esperado: exp.titular.trim() || null,
    bank_val_cuenta_esperada: exp.numero_cuenta.trim() || null,
    bank_val_alias_esperado: exp.alias.trim() || null,
    bank_val_titular_ocr: ocr.titular.trim() || null,
    bank_val_cuenta_ocr: ocr.numero_cuenta.trim() || null,
    bank_val_alias_ocr: ocr.alias.trim() || null,
    bank_val_coincidencias: matches,
    bank_val_min_requeridas: minReq,
    bank_val_status: matches >= minReq ? "coincide" : "discrepancia",
  };

  const clip = (x: string, n: number) => {
    const t = x.replace(/\s+/g, " ").trim();
    return t.length <= n ? t : `${t.slice(0, n)}…`;
  };
  const titOk =
    exp.titular.trim() && ocr.titular.trim() && titularMatches(exp.titular, ocr.titular) ? "ok" : "no";
  const ctaOk =
    exp.numero_cuenta.trim() &&
    ocr.numero_cuenta.trim() &&
    cuentaMatches(exp.numero_cuenta, ocr.numero_cuenta)
      ? "ok"
      : "no";
  const aliasOk =
    exp.alias.trim() && ocr.alias.trim() && aliasMatches(exp.alias, ocr.alias) ? "ok" : "no";
  const motivoDetalle = `datos_bancarios:matches=${matches}/${minReq};titular=${titOk}:${clip(exp.titular, 24)}|${clip(ocr.titular, 24)};cuenta=${ctaOk}:${clip(exp.numero_cuenta, 16)}|${clip(ocr.numero_cuenta, 16)};alias=${aliasOk}:${clip(exp.alias, 20)}|${clip(ocr.alias, 20)}`;

  if (matches >= minReq) {
    return { apply: true, ok: true, audit: auditFull };
  }

  return { apply: true, ok: false, audit: auditFull, motivoDetalle };
}
