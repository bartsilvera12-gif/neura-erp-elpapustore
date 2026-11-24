import type { AppSupabaseClient } from "@/lib/supabase/schema";

/**
 * Herencia del revendedor entre sesiones del MISMO chat.
 *
 * Contexto (nov-2026, Papu_store): el cliente entra por el link de un revendedor, compra, y luego
 * escribe una palabra de reinicio ("boletas", "papu sorteos") o vuelve después de `compra_realizada`.
 * Cada reinicio crea una sesión nueva y algunos caminos no copiaban el revendedor, así que las
 * compras siguientes quedaban sin revendedor (92 órdenes confirmadas del sorteo vigente).
 *
 * Reglas (para no cross-acreditar):
 *   - Solo se hereda un revendedor ACTIVO y del MISMO sorteo que el flujo actual (sin remapeos).
 *   - Lo heredado queda con `referral_source` VACÍO (revendedor sí, origen no): un link o código nuevo
 *     lo reemplaza. No se usa un valor propio porque la base tiene un CHECK
 *     (`chat_flow_sessions_referral_source_check`) que solo admite NULL, click_token o inbound_text, y
 *     las atribuciones directas siempre guardan uno de esos dos.
 */

/** Sesión con revendedor heredado de un reinicio (no atribuido por link/código en esta sesión). */
export function isInheritedReferral(row: { revendedor_id?: string | null; referral_source?: string | null } | null): boolean {
  return Boolean(row?.revendedor_id) && !(row?.referral_source ?? "").trim();
}

const LOG = "[sorteo-referral][inherit]" as const;

/** Cuántas sesiones recientes del chat se miran para buscar el último revendedor. */
const RECENT_SESSIONS_LIMIT = 20;

export type InheritableRevendedor = {
  revendedorId: string;
  codigo: string | null;
  origen: "sesion_anterior" | "first_revendedor";
};

async function loadValidRevendedor(
  revDb: AppSupabaseClient,
  empresaId: string,
  sorteoId: string,
  revendedorId: string
): Promise<{ id: string; codigo_referido: string | null } | null> {
  const { data, error } = await revDb
    .from("sorteo_revendedores")
    .select("id, codigo_referido, sorteo_id, activo")
    .eq("id", revendedorId)
    .eq("empresa_id", empresaId)
    .maybeSingle();
  if (error || !data) return null;
  const r = data as { id: string; codigo_referido: string | null; sorteo_id: string | null; activo: boolean | null };
  if (r.activo !== true || r.sorteo_id !== sorteoId) return null;
  return { id: r.id, codigo_referido: r.codigo_referido ?? null };
}

/**
 * Devuelve el último revendedor válido (activo, mismo sorteo) que usó este chat:
 *   1. sesiones del chat (más reciente primero; `preferSessionId` se evalúa primero);
 *   2. si `includeFirstRevendedor`, `chat_conversations.first_revendedor_id`.
 * Ante cualquier error de lectura devuelve null (comportamiento de siempre: sin revendedor).
 */
export async function findInheritableRevendedor(params: {
  chatDb: AppSupabaseClient;
  revDb: AppSupabaseClient;
  empresaId: string;
  conversationId: string;
  sorteoId: string | null | undefined;
  preferSessionId?: string | null;
  excludeSessionId?: string | null;
  includeFirstRevendedor?: boolean;
}): Promise<InheritableRevendedor | null> {
  const sorteoId = params.sorteoId?.trim() || "";
  if (!sorteoId || !params.conversationId) return null;
  try {
    const { data: sess, error } = await params.chatDb
      .from("chat_flow_sessions")
      .select("id, revendedor_id, codigo_referido_snapshot, created_at")
      .eq("empresa_id", params.empresaId)
      .eq("conversation_id", params.conversationId)
      .not("revendedor_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(RECENT_SESSIONS_LIMIT);
    if (!error && Array.isArray(sess)) {
      type S = { id: string; revendedor_id: string | null; codigo_referido_snapshot: string | null };
      let rows = (sess as S[]).filter((s) => s.revendedor_id && s.id !== params.excludeSessionId);
      const pref = params.preferSessionId?.trim();
      if (pref) {
        rows = [...rows.filter((s) => s.id === pref), ...rows.filter((s) => s.id !== pref)];
      }
      const seen = new Set<string>();
      for (const s of rows) {
        const rid = s.revendedor_id as string;
        if (seen.has(rid)) continue;
        seen.add(rid);
        const r = await loadValidRevendedor(params.revDb, params.empresaId, sorteoId, rid);
        if (r) {
          return {
            revendedorId: r.id,
            codigo: s.codigo_referido_snapshot?.trim() || r.codigo_referido,
            origen: "sesion_anterior",
          };
        }
      }
    }

    if (params.includeFirstRevendedor) {
      const { data: conv, error: convErr } = await params.chatDb
        .from("chat_conversations")
        .select("first_revendedor_id")
        .eq("id", params.conversationId)
        .eq("empresa_id", params.empresaId)
        .maybeSingle();
      const first = (conv as { first_revendedor_id?: string | null } | null)?.first_revendedor_id?.trim();
      if (!convErr && first) {
        const r = await loadValidRevendedor(params.revDb, params.empresaId, sorteoId, first);
        if (r) return { revendedorId: r.id, codigo: r.codigo_referido, origen: "first_revendedor" };
      }
    }
  } catch (e) {
    console.warn(LOG, "lookup_failed", {
      conversationId: params.conversationId,
      error: e instanceof Error ? e.message.slice(0, 160) : String(e).slice(0, 160),
    });
  }
  return null;
}
