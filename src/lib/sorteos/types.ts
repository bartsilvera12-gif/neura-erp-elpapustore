/** Estados de sorteo (tabla sorteos) */
export type SorteoEstado = "activo" | "pausado" | "cerrado" | "finalizado";

export type SorteoTicketDeliveryMode = "text_only" | "text_and_image" | "image_only";

export type SorteoCouponNumberMode = "correlative" | "random";

/** Estados de conversación de sorteo */
export type SorteoConversacionEstado =
  | "new_lead"
  | "awaiting_ticket_selection"
  | "awaiting_customer_data"
  | "awaiting_payment"
  | "awaiting_receipt"
  | "receipt_under_review"
  | "paid_confirmed"
  | "human_handoff"
  | "cancelled"
  | "closed_no_response";

/** `anulado`: venta dada de baja — sus cupones no participan y el cupo del sorteo se liberó. */
export type SorteoEntradaEstadoPago =
  | "pendiente"
  | "pendiente_revision"
  | "confirmado"
  | "rechazado"
  | "anulado";

export interface Sorteo {
  id: string;
  empresa_id: string;
  nombre: string;
  descripcion: string | null;
  precio_por_boleto: number;
  max_boletos: number;
  total_boletos_vendidos: number;
  ultimo_numero_cupon: number;
  fecha_sorteo: string | null;
  estado: SorteoEstado;
  datos_bancarios: Record<string, unknown>;
  imagen_url: string | null;
  ticket_delivery_mode?: SorteoTicketDeliveryMode;
  ticket_image_config?: Record<string, unknown>;
  /** Numeración opcional; si false, se usa el comportamiento legacy. */
  coupon_numbering_enabled?: boolean;
  coupon_number_start?: number | null;
  coupon_number_mode?: SorteoCouponNumberMode | null;
  coupon_number_limit?: number | null;
  created_at: string;
  updated_at: string;
}

export interface SorteoConversacion {
  id: string;
  empresa_id: string;
  sorteo_id: string;
  whatsapp_numero: string;
  cliente_id: string | null;
  estado: SorteoConversacionEstado;
  ultimo_mensaje: string | null;
  cantidad_boletos: number | null;
  datos_cliente: Record<string, unknown>;
  recordatorio_24h: boolean | null;
  recordatorio_48h: boolean | null;
  recordatorio_72h: boolean | null;
  ultimo_recordatorio_at: string | null;
  human_handoff_at: string | null;
  activa: boolean;
  created_at: string;
  updated_at: string;
  /** Si viene de select con join */
  sorteos?: { nombre: string } | null;
}

export interface SorteoEntrada {
  id: string;
  empresa_id: string;
  sorteo_id: string;
  conversacion_id: string | null;
  cliente_id: string | null;
  whatsapp_numero: string;
  nombre_participante: string;
  documento: string | null;
  cantidad_boletos: number;
  monto_total: number;
  moneda: string;
  estado_pago: SorteoEntradaEstadoPago;
  fecha_pago: string | null;
  monto_pagado: number | null;
  banco_origen: string | null;
  comprobante_url: string | null;
  comprobante_ia_resultado: Record<string, unknown> | null;
  comprobante_ia_confianza: number | null;
  validado_por: string | null;
  validado_por_user_id: string | null;
  validado_at: string | null;
  created_at: string;
  updated_at: string;
  numero_orden?: number | null;
  chat_conversation_id?: string | null;
  flow_code?: string | null;
  idempotency_key?: string | null;
  promo_nombre?: string | null;
  precio_fuente?: "lista" | "promo" | null;
  precio_regular_referencia?: number | null;
  /** Fila en `chat_comprobante_validaciones` cuando la compra viene del flujo WhatsApp. */
  comprobante_validacion_id?: string | null;
  sorteos?: { nombre: string } | null;
}

/** Fila agregada para la vista Cupones (una por orden con cupones listados). */
export type SorteoCuponOrdenRow = {
  entrada_id: string;
  sorteo_id: string;
  numero_orden: number;
  nombre_participante: string;
  documento: string | null;
  whatsapp_numero: string;
  /** Ciudad del comprador (clientes.ciudad vía sorteo_entradas.cliente_id). Null si no hay. */
  ciudad: string | null;
  cantidad_boletos: number;
  monto_total: number;
  promo_nombre: string | null;
  precio_fuente: "lista" | "promo" | null;
  estado_pago: SorteoEntradaEstadoPago;
  created_at: string;
  chat_conversation_id: string | null;
  sorteo_nombre: string;
  numeros_cupon: string[];
  /** Impresión física urna (migración cupones_impresos_*). */
  cupones_impresos_at: string | null;
};

export interface SorteoCupon {
  id: string;
  empresa_id: string;
  sorteo_id: string;
  entrada_id: string;
  numero_cupon: string;
  /** Valor numérico para rangos/unicidad cuando numeración personalizada está activa. */
  coupon_number_value?: number | null;
  ganador: boolean | null;
  created_at: string;
  sorteos?: { nombre: string } | null;
  sorteo_entradas?: { nombre_participante: string } | null;
}

/** Body esperado por POST /api/raffles/entries/create (n8n) */
export interface CreateRaffleEntryPayload {
  empresa_id: string;
  sorteo_id: string;
  whatsapp_numero: string;
  nombre_completo: string;
  cedula: string;
  celular: string;
  ciudad: string;
  cantidad_boletos: number;
  fecha_pago: string;
  monto_pago: number;
  banco_origen: string;
  comprobante_url: string | null;
  ultimo_mensaje: string | null;
}

export interface CreateRaffleEntryResponseOk {
  ok: true;
  message: string;
  cliente: { id: string; nombre: string };
  conversacion: { id: string; estado: string };
  entrada: {
    id: string;
    cantidad_boletos: number;
    monto_total: number;
    estado_pago: string;
  };
  cupones: { id: string; numero_cupon: string }[];
}

export interface CreateRaffleEntryResponseErr {
  ok: false;
  message: string;
  detalle?: string;
}

export type CreateRaffleEntryResponse = CreateRaffleEntryResponseOk | CreateRaffleEntryResponseErr;
