/** Config JSON en `sorteos.ticket_image_config` (sin validación estricta en DB). */

export type SorteoTicketDeliveryMode = "text_only" | "text_and_image" | "image_only";

/** Render: SVG automático vs imagen base subida + texto encima */
export type SorteoTicketDesignMode = "auto" | "custom_template";

/** Posición de un campo dinámico sobre plantilla personalizada (coords px en imagen base). */
export type SorteoTicketCustomFieldLayout = {
  x: number;
  y: number;
  fontSize: number;
  color: string;
};

/** Colores y tamaños base; el render ubica el bloque abajo. x/y en DB = override opcional. */
export const DEFAULT_CUSTOM_TEMPLATE_FIELDS: Record<string, SorteoTicketCustomFieldLayout> = {
  cliente_nombre: { x: 72, y: 0, fontSize: 32, color: "#111827" },
  cliente_documento: { x: 72, y: 0, fontSize: 26, color: "#374151" },
  telefono: { x: 72, y: 0, fontSize: 26, color: "#374151" },
  ciudad: { x: 72, y: 0, fontSize: 26, color: "#374151" },
  numero_orden: { x: 72, y: 0, fontSize: 30, color: "#111827" },
  sorteo_nombre: { x: 72, y: 0, fontSize: 26, color: "#374151" },
  cupones: { x: 72, y: 0, fontSize: 56, color: "#111827" },
};

export type SorteoTicketImageConfig = {
  /** Automático (SVG) o plantilla imagen completa */
  design_mode?: SorteoTicketDesignMode;
  /** Bucket/path de la plantilla base (normalmente sorteo-ticket-assets) */
  custom_template_storage_bucket?: string;
  custom_template_storage_path?: string;
  /** Dimensiones detectadas al subir (overlay SVG) */
  custom_template_width?: number;
  custom_template_height?: number;
  /** Nombre original del archivo al subir la plantilla (solo UX / referencia) */
  custom_template_original_filename?: string;
  /** Coordenadas por campo para texto sobre plantilla */
  custom_template_fields?: Partial<Record<string, SorteoTicketCustomFieldLayout>>;
  /** Título visible en el PNG */
  title?: string;
  /** Caption de WhatsApp al enviar la imagen */
  caption?: string;
  /** Pie legal / texto informativo */
  legalFooter?: string;
  /** Último asset de logo subido (bucket + path en Storage) */
  logo_storage_bucket?: string;
  logo_storage_path?: string;
  /** Último fondo subido (bucket + path en Storage) */
  background_storage_bucket?: string;
  background_storage_path?: string;
  primaryColor?: string;
  secondaryColor?: string;
  backgroundColor?: string;
  showLogo?: boolean;
  showClienteNombre?: boolean;
  showDocumento?: boolean;
  showTelefono?: boolean;
  showCiudad?: boolean;
  showNumeroOrden?: boolean;
  showCupones?: boolean;
  showSorteoNombre?: boolean;
  /** Texto corto si image_only necesita texto aparte (fallback UX) */
  ticket_image_only_stub?: string;
};

export const SORTEO_TICKET_DEFAULT_STUB =
  "Listo, generamos tu comprobante de participación.";

export function normalizeTicketImageConfig(raw: unknown): SorteoTicketImageConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return raw as SorteoTicketImageConfig;
}

/** Merge defaults de campos sobre plantilla para render. */
export function mergeCustomTemplateFields(
  cfg: SorteoTicketImageConfig
): Record<string, SorteoTicketCustomFieldLayout> {
  const partial = cfg.custom_template_fields ?? {};
  const out: Record<string, SorteoTicketCustomFieldLayout> = {};
  for (const key of Object.keys(DEFAULT_CUSTOM_TEMPLATE_FIELDS)) {
    const def = DEFAULT_CUSTOM_TEMPLATE_FIELDS[key]!;
    const o = partial[key];
    out[key] =
      o && typeof o === "object"
        ? {
            x: typeof o.x === "number" ? o.x : def.x,
            y: typeof o.y === "number" ? o.y : def.y,
            fontSize: typeof o.fontSize === "number" ? o.fontSize : def.fontSize,
            color: typeof o.color === "string" ? o.color : def.color,
          }
        : { ...def };
  }
  return out;
}
