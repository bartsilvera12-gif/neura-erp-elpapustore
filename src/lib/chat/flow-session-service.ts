import { ensureCentralChatFlowSessionMirror } from "@/lib/chat/central-chat-flow-session-mirror";
import type { SupabaseAdmin } from "@/lib/chat/types";
import { getChatPostgresPool } from "@/lib/supabase/chat-pg-pool";

/** Ventana para adoptar una sesión activa creada por otro webhook en paralelo. */
const ADOPT_RECENT_SESSION_MS = 2 * 60 * 1000;

/**
 * Cierra todas las sesiones activas de la conversación (p. ej. antes de reinicio o cambio de flujo).
 */
export async function markConversationActiveSessionsEnded(
  supabase: SupabaseAdmin,
  empresaId: string,
  conversationId: string,
  endStatus: "restarted" | "abandoned" | "completed",
  reason: string
): Promise<void> {
  const endedAt = new Date().toISOString();
  const { error } = await supabase
    .from("chat_flow_sessions")
    .update({
      status: endStatus,
      ended_at: endedAt,
      end_reason: reason.slice(0, 500),
    })
    .eq("empresa_id", empresaId)
    .eq("conversation_id", conversationId)
    .eq("status", "active");
  if (error) {
    console.error("[flow-session] end_active_failed", { conversationId, message: error.message });
  }
}

export async function insertActiveFlowSessionRow(
  supabase: SupabaseAdmin,
  empresaId: string,
  conversationId: string,
  flowCode: string
): Promise<string | null> {
  const fc = flowCode.trim();
  if (!fc) return null;
  const { data, error } = await supabase
    .from("chat_flow_sessions")
    .insert({
      empresa_id: empresaId,
      conversation_id: conversationId,
      flow_code: fc,
      status: "active",
    })
    .select("id")
    .single();
  if (error || !data) {
    console.error("[flow-runtime]", "chat_flow_sessions_insert_failed", {
      conversationId,
      empresaId,
      flowCode: fc,
      message: error?.message,
      code: (error as { code?: string })?.code,
      hint:
        typeof error?.message === "string" &&
        error.message.includes("chat_flow_sessions_conversation_id_fkey")
          ? "FK conversation_id suele apuntar a zentra_erp en lugar del chat_conversations tenant; migración 20260422100000"
          : undefined,
    });
    return null;
  }
  const sessionId = (data as { id: string }).id;
  await ensureCentralChatFlowSessionMirror({
    pool: getChatPostgresPool(),
    empresaId,
    sessionId,
  });
  return sessionId;
}

/**
 * Garantiza `chat_conversations.active_flow_session_id` coherente con `flow_code` y sesión `active`.
 */
export async function ensureActiveFlowSessionForConversation(
  supabase: SupabaseAdmin,
  empresaId: string,
  conversationId: string,
  flowCode: string | null | undefined
): Promise<string | null> {
  const fc = flowCode?.trim();
  if (!fc) return null;

  const { data: conv, error: cErr } = await supabase
    .from("chat_conversations")
    .select("active_flow_session_id, flow_code")
    .eq("id", conversationId)
    .eq("empresa_id", empresaId)
    .maybeSingle();
  if (cErr || !conv) return null;
  if (String(conv.flow_code ?? "").trim() !== fc) return null;

  const sid = (conv as { active_flow_session_id?: string | null }).active_flow_session_id;
  if (sid) {
    const { data: sess, error: sErr } = await supabase
      .from("chat_flow_sessions")
      .select("id, status, flow_code")
      .eq("id", sid)
      .maybeSingle();
    /**
     * Lectura fallida (API caída un momento) ≠ sesión vencida. Antes se abandonaba la sesión en
     * uso y se creaba otra vacía: el cliente perdía lo ya cargado (cédula, nombre, comprobante) y
     * el bot le volvía a preguntar o quedaba trabado. Se conserva el puntero.
     */
    if (sErr) {
      console.warn("[flow-session] ensure_active_read_failed_keep_pointer", {
        conversationId,
        sid,
        message: sErr.message,
      });
      return sid;
    }
    const s = sess as { id?: string; status?: string; flow_code?: string } | null;
    if (s && s.status === "active" && String(s.flow_code ?? "").trim() === fc) {
      return s.id ?? null;
    }
  }

  /**
   * Si ya hay una sesión ACTIVA de este flujo (la creó otro webhook del mismo cliente procesándose
   * en paralelo, o un reinicio que todavía no movió el puntero) se adopta en vez de abandonarla:
   * dos mensajes seguidos del cliente creaban 2-4 sesiones en el mismo segundo y cada una
   * descartaba a la anterior junto con sus datos. Sólo sesiones recién creadas: una activa vieja
   * olvidada (de otra compra) no se revive; esa se abandona como siempre.
   */
  const { data: activeRows, error: activeErr } = await supabase
    .from("chat_flow_sessions")
    .select("id, created_at")
    .eq("empresa_id", empresaId)
    .eq("conversation_id", conversationId)
    .eq("flow_code", fc)
    .eq("status", "active")
    .gte("created_at", new Date(Date.now() - ADOPT_RECENT_SESSION_MS).toISOString())
    .order("created_at", { ascending: false })
    .limit(1);
  if (activeErr) {
    console.warn("[flow-session] ensure_active_lookup_failed_keep_pointer", {
      conversationId,
      sid: sid ?? null,
      message: activeErr.message,
    });
    return sid ?? null;
  }
  const adoptId = (activeRows?.[0] as { id?: string } | undefined)?.id ?? null;
  if (adoptId) {
    let adopt = supabase
      .from("chat_conversations")
      .update({ active_flow_session_id: adoptId, updated_at: new Date().toISOString() })
      .eq("id", conversationId)
      .eq("empresa_id", empresaId);
    adopt = sid ? adopt.eq("active_flow_session_id", sid) : adopt.is("active_flow_session_id", null);
    const { error: adoptErr } = await adopt;
    if (adoptErr) {
      console.error("[flow-session] adopt_active_on_conversation_failed", adoptErr.message);
      return sid ?? null;
    }
    const { data: after } = await supabase
      .from("chat_conversations")
      .select("active_flow_session_id")
      .eq("id", conversationId)
      .eq("empresa_id", empresaId)
      .maybeSingle();
    const current =
      (after as { active_flow_session_id?: string | null } | null)?.active_flow_session_id ?? adoptId;
    console.info("[flow-session] ensure_active_adopted_existing", {
      conversationId,
      stale_sid: sid ?? null,
      adopted: adoptId,
      pointer_now: current,
    });
    return current;
  }

  await markConversationActiveSessionsEnded(
    supabase,
    empresaId,
    conversationId,
    "abandoned",
    "ensure_active_session_recovered_stale_pointer"
  );

  const newId = await insertActiveFlowSessionRow(supabase, empresaId, conversationId, fc);
  if (!newId) return null;

  const { error: uErr } = await supabase
    .from("chat_conversations")
    .update({
      active_flow_session_id: newId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", conversationId)
    .eq("empresa_id", empresaId);
  if (uErr) {
    console.error("[flow-session] set_active_on_conversation_failed", uErr.message);
    return null;
  }
  return newId;
}
