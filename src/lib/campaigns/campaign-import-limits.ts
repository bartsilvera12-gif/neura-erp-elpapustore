/**
 * Límites de importación de destinatarios de campaña.
 *
 * Viven en su propio módulo (sin `server-only`) para que la UI muestre el mismo
 * número que valida la API: antes estaban duplicados como texto hardcodeado y
 * quedaban desincronizados al cambiar el límite.
 */

export const CAMPAIGN_IMPORT_MAX_ROWS = 15000;
export const CAMPAIGN_IMPORT_MAX_BYTES = 15 * 1024 * 1024;

/** "15.000" para los mensajes de la UI y de la API. */
export function formatCampaignImportMaxRows(): string {
  return CAMPAIGN_IMPORT_MAX_ROWS.toLocaleString("es-PY");
}

/** "15 MB" para los mensajes de la UI y de la API. */
export function formatCampaignImportMaxSize(): string {
  return `${Math.round(CAMPAIGN_IMPORT_MAX_BYTES / (1024 * 1024))} MB`;
}
