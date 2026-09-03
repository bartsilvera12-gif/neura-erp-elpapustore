import type { AppSupabaseClient } from "@/lib/supabase/schema";

export type ChatChannelRow = {
  id: string;
  empresa_id: string;
  type: string;
  meta_phone_number_id: string;
  config: Record<string, unknown>;
};

export type ChatContactRow = {
  id: string;
  empresa_id: string;
  phone_number: string;
  phone_normalized: string | null;
  name: string | null;
  cliente_id: string | null;
  crm_prospecto_id: string | null;
};

export type ChatConversationRow = {
  id: string;
  empresa_id: string;
  channel_id: string;
  contact_id: string;
  status: "open" | "pending" | "closed";
  queue_id?: string | null;
  assigned_agent_id?: string | null;
  priority?: "low" | "medium" | "high";
  flow_code: string | null;
  flow_current_node: string | null;
  flow_status: "bot" | "human";
  human_taken_over: boolean;
  last_message_at: string | null;
  last_message_preview: string | null;
  unread_count: number;
};

export type ChatMessageRow = {
  id: string;
  empresa_id: string;
  conversation_id: string;
  wa_message_id: string | null;
  from_me: boolean;
  sender_type: "contact" | "ai" | "human" | "system";
  sent_by_user_id: string | null;
  sent_by_user_name: string | null;
  automation_source: string | null;
  message_type: string;
  content: string | null;
  raw_payload: Record<string, unknown>;
  created_at: string;
};

export type ChatFlowNodeRow = {
  id: string;
  empresa_id: string;
  flow_code: string;
  node_code: string;
  message_text: string | null;
  save_as_field: string | null;
  next_node_code: string | null;
  sort_order: number;
  node_type: "buttons" | "list" | "text" | "media" | "image_input" | "human" | "end" | "identity_recall";
  is_active: boolean;
  created_at: string;
};

export type ChatFlowOptionRow = {
  id: string;
  node_id: string;
  label: string;
  option_value: string;
  meta_button_id: string;
  next_node_code: string | null;
  sort_order: number;
  option_payload: Record<string, unknown>;
  created_at: string;
};

export type ChatFlowEventRow = {
  id: string;
  empresa_id: string;
  conversation_id: string;
  flow_code: string | null;
  node_code: string | null;
  event_type: string;
  selected_option_id: string | null;
  meta_button_id: string | null;
  payload: Record<string, unknown>;
  created_at: string;
};

export type ChatFlowDataRow = {
  id: string;
  empresa_id: string;
  conversation_id: string;
  flow_code: string;
  field_name: string;
  field_value: string;
  created_at: string;
};

/** Payload Meta (solo lo que usamos) */
export type MetaWebhookEntry = {
  id?: string;
  changes?: Array<{
    field?: string;
    value?: MetaWebhookValue;
  }>;
};

export type MetaWebhookValue = {
  messaging_product?: string;
  metadata?: {
    display_phone_number?: string;
    phone_number_id?: string;
  };
  contacts?: Array<{
    profile?: { name?: string };
    wa_id?: string;
  }>;
  messages?: MetaInboundMessage[];
};

export type MetaInboundMessage = {
  from?: string;
  id?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
  image?: { caption?: string; id?: string; mime_type?: string };
  /** Comprobantes suelen venir como document (PDF o imagen como archivo); id y mime_type vienen de Graph API */
  document?: { id?: string; mime_type?: string; caption?: string; filename?: string };
  audio?: { id?: string; mime_type?: string; voice?: boolean };
  video?: { id?: string; caption?: string; mime_type?: string };
  sticker?: { id?: string };
  interactive?: {
    type?: string;
    button_reply?: { id?: string; title?: string };
    list_reply?: { id?: string; title?: string; description?: string };
  };
  /** Clic en botón de plantilla / reply: Meta envía `type: "button"` (no siempre `interactive`). */
  button?: { text?: string; payload?: string };
  [key: string]: unknown;
};

export type ProcessWebhookResult = {
  ok: boolean;
  processed: number;
  skipped: number;
  errors: string[];
};

export type SupabaseAdmin = AppSupabaseClient;
