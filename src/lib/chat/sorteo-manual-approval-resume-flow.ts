import "server-only";

import type { AppSupabaseClient } from "@/lib/supabase/schema";
import {
  findFirstIncompleteCaptureNodeInFlowOrder,
  type FindIncompleteCaptureResult,
} from "@/lib/sorteos/sorteo-flow-capture-order";
import {
  advanceConversationToNode,
  sendCurrentFlowNode,
  getConversationFlowState,
} from "@/lib/chat/flow-engine-service";
import {
  resolveOutboundTextContextFromIds,
  sendOutboundTextMessage,
} from "@/lib/chat/outbound-send-dispatch";
import { persistOutgoingChatMessage } from "@/lib/chat/outgoing-message-persist";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import {
  FLOW_SORTEO_PENDIENTE_DATOS_PARTICIPANTE_FIELD,
  MOTIVO_VALIDACION_ASESOR_PENDIENTE_DATOS,
  MOTIVO_VALIDACION_ASESOR_PENDIENTE_CONFIRMACION_CLIENTE,
  SORTEO_COMPROBANTE_ESTADO_VALIDACION_FIELD,
  SORTEO_COMPROBANTE_MOTIVO_VALIDACION_FIELD,
  SORTEO_COMPROBANTE_VALIDACION_ID_FIELD,
} from "@/lib/chat/comprobante-validation-types";

function norm(s: string | undefined | null): string {
  return (s ?? "").trim();
}

function resumePayloadFromIncomplete(
  hit: FindIncompleteCaptureResult
): { nodeCode: string; messageText: string; saveAsField: string | null } {
  return {
    nodeCode: hit.nodeCode,
    messageText: hit.messageText,
    saveAsField: hit.saveAsField,
  };
}

/**
 * Primer nodo de captura incompleto según el orden real del flujo (BFS del grafo configurado).
 * `chat_flow_data` debe reflejar la sesión actual (p. ej. datos hidratados).
 */
export async function findResumeNodeForMissingFields(
  supabase: AppSupabaseClient,
  empresaId: string,
  flowCode: string,
  flowData: Record<string, string>
): Promise<{ nodeCode: string; messageText: string; saveAsField: string | null } | null> {
  const hit = await findFirstIncompleteCaptureNodeInFlowOrder(supabase, empresaId, flowCode, flowData);
  return hit ? resumePayloadFromIncomplete(hit) : null;
}

export async function runManualApprovalResumeParticipantFlow(input: {
  supabase: AppSupabaseClient;
  empresaId: string;
  usuarioId: string;
  conversationId: string;
  flowCode: string;
  flowSessionId: string;
  channelId: string;
  contactId: string;
  validationId: string;
  missingFields: string[];
  nextNodeCode: string;
  note: string;
  /** Campos extra en chat_flow_data (opcional; no duplicar los que ya arma esta función). */
  mergedFlowDataPatch?: Record<string, string>;
  /** default: datos faltantes; alternativa: datos OK pero el cliente debe confirmar en el flujo. */
  resumeVariant?: "missing_fields" | "pending_final_confirmation";
}): Promise<{ whatsappWarning?: string }> {
  const fc = input.flowCode.trim();
  const sid = input.flowSessionId.trim();
  const variant = input.resumeVariant ?? "missing_fields";
  const motivoVal =
    variant === "pending_final_confirmation"
      ? MOTIVO_VALIDACION_ASESOR_PENDIENTE_CONFIRMACION_CLIENTE
      : MOTIVO_VALIDACION_ASESOR_PENDIENTE_DATOS;
  const pendienteUpserts = [
    {
      empresa_id: input.empresaId,
      conversation_id: input.conversationId,
      flow_code: fc,
      flow_session_id: sid,
      field_name: FLOW_SORTEO_PENDIENTE_DATOS_PARTICIPANTE_FIELD,
      field_value: variant === "pending_final_confirmation" ? "no" : "si",
    },
    {
      empresa_id: input.empresaId,
      conversation_id: input.conversationId,
      flow_code: fc,
      flow_session_id: sid,
      field_name: SORTEO_COMPROBANTE_VALIDACION_ID_FIELD,
      field_value: input.validationId,
    },
    {
      empresa_id: input.empresaId,
      conversation_id: input.conversationId,
      flow_code: fc,
      flow_session_id: sid,
      field_name: SORTEO_COMPROBANTE_ESTADO_VALIDACION_FIELD,
      field_value: "aprobado_manual",
    },
    {
      empresa_id: input.empresaId,
      conversation_id: input.conversationId,
      flow_code: fc,
      flow_session_id: sid,
      field_name: SORTEO_COMPROBANTE_MOTIVO_VALIDACION_FIELD,
      field_value: motivoVal,
    },
    ...Object.entries(input.mergedFlowDataPatch ?? {}).map(([field_name, field_value]) => ({
      empresa_id: input.empresaId,
      conversation_id: input.conversationId,
      flow_code: fc,
      flow_session_id: sid,
      field_name,
      field_value,
    })),
  ];

  const { error: fdErr } = await input.supabase.from("chat_flow_data").upsert(pendienteUpserts, {
    onConflict: "flow_session_id,field_name",
  });
  if (fdErr) throw new Error(fdErr.message);

  const nowIso = new Date().toISOString();

  /** Primero cerrar otras sesiones activas (índice único 1 active/conversación), luego reactivar `sid`. */
  await input.supabase
    .from("chat_flow_sessions")
    .update({
      status: "abandoned",
      ended_at: nowIso,
      end_reason: "manual_approval_resume_other_sessions",
    })
    .eq("empresa_id", input.empresaId)
    .eq("conversation_id", input.conversationId)
    .eq("status", "active")
    .neq("id", sid);

  await input.supabase
    .from("chat_flow_sessions")
    .update({
      status: "active",
      ended_at: null,
      end_reason: null,
    })
    .eq("id", sid)
    .eq("empresa_id", input.empresaId);

  /**
   * Primero la sesión, después el puntero. Al revés quedaba una ventana con el puntero ya en el
   * nodo de retoma pero la conversación todavía apuntando a la sesión anterior: un mensaje del
   * cliente en ese momento se procesaba contra la sesión equivocada (datos y "ya enviado" de otra
   * compra).
   */
  const { error: convSidErr } = await input.supabase
    .from("chat_conversations")
    .update({
      active_flow_session_id: sid,
      updated_at: nowIso,
    })
    .eq("id", input.conversationId)
    .eq("empresa_id", input.empresaId);
  if (convSidErr) throw new Error(convSidErr.message);

  const adv = await advanceConversationToNode(input.supabase, {
    conversationId: input.conversationId,
    empresaId: input.empresaId,
    flowCode: fc,
    nextNodeCode: input.nextNodeCode,
  });
  if (!adv.ok) throw new Error(adv.error ?? "advanceConversationToNode");

  await input.supabase.from("chat_flow_events").insert({
    empresa_id: input.empresaId,
    conversation_id: input.conversationId,
    flow_code: fc,
    node_code: input.nextNodeCode,
    flow_session_id: sid,
    event_type:
      variant === "pending_final_confirmation"
        ? "sorteo_manual_approval_pending_final_confirmation"
        : "sorteo_manual_approval_pending_data",
    payload: {
      validation_id: input.validationId,
      missing_fields: input.missingFields,
      next_node_code: input.nextNodeCode,
      approved_by: input.usuarioId,
      approval_source: "inbox_manual",
      resume_variant: variant,
      note: input.note || null,
    },
  });

  await input.supabase.from("chat_flow_events").insert({
    empresa_id: input.empresaId,
    conversation_id: input.conversationId,
    flow_code: fc,
    node_code: input.nextNodeCode,
    flow_session_id: sid,
    event_type: "sorteo_manual_approval_resume_node_set",
    payload: {
      validation_id: input.validationId,
      active_flow_session_id: sid,
      flow_current_node: input.nextNodeCode,
      reason: "manual_approval_pending_data",
    },
  });

  const schema = await fetchDataSchemaForEmpresaId(input.empresaId);
  const outbound = await resolveOutboundTextContextFromIds(
    input.supabase,
    { contactId: input.contactId, channelId: input.channelId },
    { dataSchema: schema }
  );

  const intro =
    "Tu comprobante fue aprobado por un asesor. Para completar tu inscripción al sorteo, necesitamos estos datos que faltan.";
  const sendIntro = await sendOutboundTextMessage(outbound, intro);
  const st = await getConversationFlowState(input.supabase, input.conversationId);
  if (sendIntro.ok && st) {
    await persistOutgoingChatMessage(input.supabase, {
      conversation: { id: st.id, empresa_id: st.empresa_id },
      content: intro,
      messageType: "text",
      waMessageId: sendIntro.waMessageId,
      raw: sendIntro.raw,
      senderType: "system",
      automationSource: "sorteo_manual_approval_resume",
    });
  }

  /**
   * Antes se ignoraba el resultado: si la pregunta no salía, el puntero quedaba en un nodo de
   * captura que el cliente nunca vio, y el operador creía haberlo destrabado. Ahora el fallo
   * queda como evento y le llega al operador como aviso.
   */
  const sentNode = await sendCurrentFlowNode(input.supabase, {
    conversationId: input.conversationId,
  });
  if (!sentNode.ok) {
    await input.supabase.from("chat_flow_events").insert({
      empresa_id: input.empresaId,
      conversation_id: input.conversationId,
      flow_code: fc,
      node_code: input.nextNodeCode,
      flow_session_id: sid,
      event_type: "sorteo_manual_approval_resume_send_failed",
      payload: {
        validation_id: input.validationId,
        next_node_code: input.nextNodeCode,
        error: (sentNode.error ?? "send_failed").slice(0, 300),
      },
    });
  }

  const warnings = [
    sendIntro.ok ? null : sendIntro.error,
    sentNode.ok
      ? null
      : `No se pudo enviar la pregunta del paso "${input.nextNodeCode}" al cliente (${sentNode.error ?? "error desconocido"}). Usá "Reenviar paso actual".`,
  ].filter((w): w is string => Boolean(w));

  return {
    whatsappWarning: warnings.length ? warnings.join(" · ") : undefined,
  };
}

/**
 * Corrige solo el puntero `chat_conversations.active_flow_session_id` hacia la sesión de la validación.
 * Sin WhatsApp ni `sendCurrentFlowNode` (reintento seguro si un caso quedó desalineado antes del fix de sesión).
 */
export async function realignManualApprovalFlowSessionPointer(input: {
  supabase: AppSupabaseClient;
  empresaId: string;
  conversationId: string;
  flowCode: string;
  validationFlowSessionId: string;
  validationId?: string;
  usuarioId?: string;
}): Promise<{ ok: boolean; realigned: boolean; error?: string }> {
  const sid = input.validationFlowSessionId.trim();
  const fc = input.flowCode.trim();
  if (!sid || !fc) return { ok: false, realigned: false, error: "Falta flow_session_id o flow_code" };

  const { data: conv, error: cErr } = await input.supabase
    .from("chat_conversations")
    .select("id, active_flow_session_id, flow_code, flow_current_node")
    .eq("id", input.conversationId)
    .eq("empresa_id", input.empresaId)
    .maybeSingle();
  if (cErr || !conv) return { ok: false, realigned: false, error: cErr?.message ?? "Conversación no encontrada" };

  const convFc = String((conv as { flow_code?: string | null }).flow_code ?? "").trim();
  if (convFc && convFc !== fc) {
    return {
      ok: false,
      realigned: false,
      error: "flow_code de conversación no coincide con la validación",
    };
  }

  const cur = String((conv as { active_flow_session_id?: string | null }).active_flow_session_id ?? "").trim();
  if (cur === sid) return { ok: true, realigned: false };

  const nowIso = new Date().toISOString();

  await input.supabase
    .from("chat_flow_sessions")
    .update({
      status: "abandoned",
      ended_at: nowIso,
      end_reason: "manual_approval_realign_other_sessions",
    })
    .eq("empresa_id", input.empresaId)
    .eq("conversation_id", input.conversationId)
    .eq("status", "active")
    .neq("id", sid);

  const { error: actErr } = await input.supabase
    .from("chat_flow_sessions")
    .update({
      status: "active",
      ended_at: null,
      end_reason: null,
    })
    .eq("id", sid)
    .eq("empresa_id", input.empresaId);
  if (actErr) return { ok: false, realigned: false, error: actErr.message };

  const flowCurrentNode = String((conv as { flow_current_node?: string | null }).flow_current_node ?? "").trim();

  const { error: uErr } = await input.supabase
    .from("chat_conversations")
    .update({
      active_flow_session_id: sid,
      flow_status: "bot",
      human_taken_over: false,
      updated_at: nowIso,
    })
    .eq("id", input.conversationId)
    .eq("empresa_id", input.empresaId);
  if (uErr) return { ok: false, realigned: false, error: uErr.message };

  await input.supabase.from("chat_flow_events").insert({
    empresa_id: input.empresaId,
    conversation_id: input.conversationId,
    flow_code: fc,
    node_code: flowCurrentNode || null,
    flow_session_id: sid,
    event_type: "sorteo_manual_approval_session_realign",
    payload: {
      validation_id: input.validationId ?? null,
      previous_active_flow_session_id: cur || null,
      validation_flow_session_id: sid,
      flow_current_node: flowCurrentNode || null,
      approved_by: input.usuarioId ?? null,
      reason: "pointer_mismatch_pending_manual_approval",
    },
  });

  return { ok: true, realigned: true };
}
