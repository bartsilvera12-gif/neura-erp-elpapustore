/** Solo dígitos, sin prefijo + */
export function normalizeWaPhone(waId: string): string {
  return waId.replace(/\D/g, "");
}

/**
 * "Número nacional significativo" PY: sin código país `595` ni `0` de troncal.
 * Así `0992419766` (local), `992419766` y `595992419766` (internacional) resuelven al mismo
 * valor. Los números llegan de Meta en internacional, pero en el ERP se cargan a mano en local.
 */
export function paraguayNationalSignificantDigits(raw: string): string {
  let x = normalizeWaPhone(raw);
  if (x.startsWith("595")) x = x.slice(3);
  return x.replace(/^0+/, "");
}

/**
 * Formas equivalentes de un mismo número para comparar por igualdad contra `clientes.telefono`
 * (que según el origen quedó guardado en local, nacional o internacional).
 * Devuelve sin duplicados y sin vacíos; `[]` si el número no tiene dígitos utilizables.
 */
export function paraguayPhoneMatchVariants(raw: string): string[] {
  const digits = normalizeWaPhone(raw);
  const nat = paraguayNationalSignificantDigits(raw);
  if (nat.length === 0) return [];
  return [...new Set([digits, nat, `0${nat}`, `595${nat}`].filter((v) => v.length > 0))];
}
