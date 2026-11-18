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
      .select("active_flow_session_id, contact_id")
      .eq("id", conversationId)
      .eq("empresa_id", empresaId)
      .maybeSingle();
    const convRow = conv as { active_flow_session_id?: string | null; contact_id?: string | null } | null;
    const sid = convRow?.active_flow_session_id?.trim();
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
      .select("estado_validacion, sorteo_entrada_id, created_at, manual_approval_at")
      .eq("id", validationId)
      .maybeSingle();
    const v = val as {
      estado_validacion?: string | null;
      sorteo_entrada_id?: string | null;
      created_at?: string | null;
      manual_approval_at?: string | null;
    } | null;
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

    // Ticket 569: si el comprador ya tiene una orden creada DESPUÉS de este comprobante (por el bot
    // en otra sesión o cargada a mano en el ERP, que no queda vinculada al comprobante), ese pago
    // ya se usó: no se reanuda. Caso: pago del 02/05 aprobado a mano, orden 2745 cargada a mano el
    // 13/05 y el 18/11 el bot "reanudó" la compra y entregó la orden 4826 sin pago nuevo.
    // Sin orden posterior sí se reanuda aunque pasen meses: pagó y nunca recibió sus boletas.
    const desde = String(v.created_at ?? "").trim();
    if (!desde) return null;
    const { data: posteriorConv, error: pcErr } = await supabase
      .from("sorteo_entradas")
      .select("id")
      .eq("empresa_id", empresaId)
      .eq("chat_conversation_id", conversationId)
      .gt("created_at", desde)
      .is("anulada_at", null)
      .limit(1);
    if (pcErr || (Array.isArray(posteriorConv) && posteriorConv.length > 0)) return null;

    const contactId = convRow?.contact_id?.trim();
    if (contactId) {
      const { data: contacto } = await supabase
        .from("chat_contacts")
        .select("phone_normalized, phone_number")
        .eq("id", contactId)
        .maybeSingle();
      const c = contacto as { phone_normalized?: string | null; phone_number?: string | null } | null;
      // Últimos 9 dígitos: las órdenes cargadas a mano guardan 0981…, las del bot 595981….
      const ultimos9 = String(c?.phone_normalized || c?.phone_number || "").replace(/\D/g, "").slice(-9);
      if (ultimos9.length === 9) {
        const { data: posteriorTel, error: ptErr } = await supabase
          .from("sorteo_entradas")
          .select("id")
          .eq("empresa_id", empresaId)
          .like("whatsapp_numero", `%${ultimos9}`)
          .gt("created_at", desde)
          .is("anulada_at", null)
          .limit(1);
        if (ptErr || (Array.isArray(posteriorTel) && posteriorTel.length > 0)) return null;
      }
    }

    return { flowSessionId: sid, validationId };
  } catch {
    return null;
  }
}

/** Aviso antes de repetir el paso pendiente cuando se evitó reiniciar una compra pagada. */
export const PAID_PURCHASE_RESUME_NOTICE =
  "✅ Ya recibimos tu pago. Para enviarte tus boletas solo falta completar este paso 👇";
