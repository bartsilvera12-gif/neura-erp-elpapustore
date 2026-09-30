import type { SupabaseAdmin } from "@/lib/chat/types";

/**
 * ¿La conversación tiene una compra YA PAGADA a la que todavía no se le creó la orden?
 *
 * Por qué (diagnóstico 29/30-sep, Papu_store): clientes que ya habían mandado un comprobante
 * válido y estaban completando sus datos escribían "Y mis boletas", "Hola, ¿cómo sé mi número?"
 * o volvían a tocar el link del revendedor. Esas frases son palabras de reinicio: el bot les
 * arrancaba una compra NUEVA, la sesión con el pago quedaba cerrada sin orden, y cuando el
 * cliente reenviaba el mismo comprobante se rechazaba como duplicado. Resultado: pagó y nunca
 * recibió sus boletas (Pablo, Vane, Rosa, Richar…).
 *
 * Deliberadamente angosto: sólo devuelve algo si la sesión ACTIVA tiene un comprobante válido o
 * aprobado por un asesor y NO existe orden para ese comprobante. Ante cualquier error de lectura
 * devuelve null (se mantiene el comportamiento de siempre).
 */
export async function findPaidPurchasePendingOrder(
  supabase: SupabaseAdmin,
  empresaId: string,
  conversationId: string
): Promise<{ flowSessionId: string; validationId: string } | null> {
  try {
    const { data: conv, error: cErr } = await supabase
      .from("chat_conversations")
      .select("active_flow_session_id")
      .eq("id", conversationId)
      .eq("empresa_id", empresaId)
      .maybeSingle();
    const sid = (conv as { active_flow_session_id?: string | null } | null)?.active_flow_session_id?.trim();
    if (cErr || !sid) return null;

    const { data: sess, error: sErr } = await supabase
      .from("chat_flow_sessions")
      .select("status")
      .eq("id", sid)
      .maybeSingle();
    if (sErr || (sess as { status?: string } | null)?.status !== "active") return null;

    const { data: fd, error: fErr } = await supabase
      .from("chat_flow_data")
      .select("field_value")
      .eq("flow_session_id", sid)
      .eq("field_name", "sorteo_comprobante_validacion_id")
      .maybeSingle();
    const validationId = String((fd as { field_value?: string | null } | null)?.field_value ?? "").trim();
    if (fErr || !validationId) return null;

    const { data: val, error: vErr } = await supabase
      .from("chat_comprobante_validaciones")
      .select("estado_validacion, sorteo_entrada_id")
      .eq("id", validationId)
      .maybeSingle();
    const v = val as { estado_validacion?: string | null; sorteo_entrada_id?: string | null } | null;
    if (vErr || !v) return null;
    const estado = String(v.estado_validacion ?? "").trim().toLowerCase();
    if (estado !== "valido" && estado !== "aprobado_manual") return null;
    if (v.sorteo_entrada_id) return null;

    const { data: ent, error: eErr } = await supabase
      .from("sorteo_entradas")
      .select("id")
      .eq("comprobante_validacion_id", validationId)
      .limit(1);
    if (eErr || (Array.isArray(ent) && ent.length > 0)) return null;

    return { flowSessionId: sid, validationId };
  } catch {
    return null;
  }
}

/** Aviso antes de repetir el paso pendiente cuando se evitó reiniciar una compra pagada. */
export const PAID_PURCHASE_RESUME_NOTICE =
  "✅ Ya recibimos tu pago. Para enviarte tus boletas solo falta completar este paso 👇";
