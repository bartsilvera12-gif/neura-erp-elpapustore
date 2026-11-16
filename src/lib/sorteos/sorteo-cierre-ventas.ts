import type { Pool } from "pg";
import type { SupabaseAdmin } from "@/lib/chat/types";
import { quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";

/**
 * Cierre de ventas por fecha del sorteo.
 *
 * - Cuando llega `fecha_sorteo`, el cron pasa el sorteo de `activo` a `cerrado` (ver `cerrarSorteosVencidos`).
 * - El bot deja de vender: a quien escribe le contesta que las ventas cerraron y no le muestra combos.
 * - Margen: quien ya había elegido un combo en su sesión puede terminar la compra (mandar el comprobante)
 *   hasta `GRACIA_CIERRE_MS` después de la fecha; su boleta va al sorteo que eligió.
 * - El pase al sorteo siguiente sigue siendo manual (flujo → sorteo nuevo).
 */
export const GRACIA_CIERRE_MS = 30 * 60 * 1000;

/** Para no repetir el aviso a cada mensaje del mismo cliente. */
const AVISO_CADA_MS = 6 * 60 * 60 * 1000;

export type SorteoCierreInfo = {
  id: string;
  nombre: string;
  estado: string;
  fecha_sorteo: string | null;
};

function fechaMs(s: SorteoCierreInfo): number | null {
  if (!s.fecha_sorteo) return null;
  const t = Date.parse(s.fecha_sorteo);
  return Number.isFinite(t) ? t : null;
}

/** Ventas cerradas: el sorteo ya no está activo, o llegó su fecha (aunque el cron todavía no lo haya cerrado). */
export function ventasCerradas(s: SorteoCierreInfo, ahora = Date.now()): boolean {
  if (String(s.estado) !== "activo") return true;
  const f = fechaMs(s);
  return f != null && ahora >= f;
}

/** Dentro del margen para terminar compras empezadas: solo cierre por fecha (`activo` vencido o `cerrado`). */
export function dentroDeGraciaCierre(s: SorteoCierreInfo, ahora = Date.now()): boolean {
  const est = String(s.estado);
  if (est !== "activo" && est !== "cerrado") return false;
  const f = fechaMs(s);
  return f != null && ahora >= f && ahora < f + GRACIA_CIERRE_MS;
}

export function mensajeVentasCerradas(s: SorteoCierreInfo): string {
  return (
    `⏰ Las ventas del *${s.nombre.trim()}* ya cerraron. ¡Gracias por participar!\n\n` +
    "Muy pronto te contamos del próximo sorteo. Si ya hiciste un pago, quedate tranquilo: un asesor lo va a revisar."
  );
}

/** Caché corto por proceso: el chequeo corre en cada mensaje entrante y el sorteo cambia muy poco. */
const CACHE_MS = 30 * 1000;
const cacheSorteo = new Map<string, { at: number; value: SorteoCierreInfo | null }>();

/** Sorteo al que está atado el flujo de la conversación (null si el flujo no tiene sorteo). */
export async function sorteoDelFlujo(
  supabase: SupabaseAdmin,
  empresaId: string,
  flowCode: string | null | undefined
): Promise<SorteoCierreInfo | null> {
  const fc = (flowCode ?? "").trim();
  if (!fc) return null;
  const key = `${empresaId}:${fc}`;
  const hit = cacheSorteo.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = await leerSorteoDelFlujo(supabase, empresaId, fc);
  cacheSorteo.set(key, { at: Date.now(), value });
  return value;
}

async function leerSorteoDelFlujo(
  supabase: SupabaseAdmin,
  empresaId: string,
  fc: string
): Promise<SorteoCierreInfo | null> {
  const { data: flow } = await supabase
    .from("chat_flows")
    .select("sorteo_id")
    .eq("empresa_id", empresaId)
    .eq("flow_code", fc)
    .maybeSingle();
  const sid = (flow as { sorteo_id?: string | null } | null)?.sorteo_id;
  if (!sid) return null;
  const { data: s } = await supabase
    .from("sorteos")
    .select("id, nombre, estado, fecha_sorteo")
    .eq("id", sid)
    .eq("empresa_id", empresaId)
    .maybeSingle();
  return (s as SorteoCierreInfo | null) ?? null;
}

/** ¿Eligió un combo (opción con cantidad) en la sesión de flujo activa? */
export async function eligioComboEnSesion(
  supabase: SupabaseAdmin,
  empresaId: string,
  conversationId: string,
  flowSessionId: string | null | undefined
): Promise<boolean> {
  const sid = (flowSessionId ?? "").trim();
  if (!sid) return false;
  const { data: evs } = await supabase
    .from("chat_flow_events")
    .select("selected_option_id")
    .eq("empresa_id", empresaId)
    .eq("conversation_id", conversationId)
    .eq("flow_session_id", sid)
    .eq("event_type", "button_selected")
    .limit(50);
  const ids = [
    ...new Set(
      ((evs ?? []) as Array<{ selected_option_id?: string | null }>)
        .map((e) => e.selected_option_id)
        .filter((x): x is string => !!x)
    ),
  ];
  if (ids.length === 0) return false;
  const { data: opts } = await supabase.from("chat_flow_options").select("option_payload").in("id", ids);
  return ((opts ?? []) as Array<{ option_payload?: Record<string, unknown> | null }>).some(
    (o) => o.option_payload != null && o.option_payload.cantidad != null
  );
}

export type DecisionCierre =
  | { bloquear: false }
  | { bloquear: true; sorteo: SorteoCierreInfo; avisar: boolean };

/**
 * Decide si el mensaje entrante NO debe pasar por el flujo porque las ventas cerraron.
 * Falla abierto: ante cualquier error de lectura, deja pasar (mismo comportamiento que antes).
 */
export async function decidirCierreParaInbound(params: {
  supabase: SupabaseAdmin;
  empresaId: string;
  conversationId: string;
  flowCode: string | null | undefined;
  flowSessionId: string | null | undefined;
}): Promise<DecisionCierre> {
  const { supabase, empresaId, conversationId } = params;
  const s = await sorteoDelFlujo(supabase, empresaId, params.flowCode);
  if (!s || !ventasCerradas(s)) return { bloquear: false };
  if (
    dentroDeGraciaCierre(s) &&
    (await eligioComboEnSesion(supabase, empresaId, conversationId, params.flowSessionId))
  ) {
    return { bloquear: false };
  }
  const texto = mensajeVentasCerradas(s);
  const desde = new Date(Date.now() - AVISO_CADA_MS).toISOString();
  const { data: previo } = await supabase
    .from("chat_messages")
    .select("id")
    .eq("conversation_id", conversationId)
    .eq("from_me", true)
    .eq("content", texto)
    .gte("created_at", desde)
    .limit(1);
  return { bloquear: true, sorteo: s, avisar: !(previo && previo.length > 0) };
}

/** Cron: pasa a `cerrado` los sorteos activos cuya fecha ya llegó. Devuelve los cerrados. */
export async function cerrarSorteosVencidos(
  pool: Pool,
  schema: string,
  empresaId: string
): Promise<Array<{ id: string; nombre: string; fecha_sorteo: string }>> {
  const t = quoteSchemaTable(schema, "sorteos");
  const r = await pool.query<{ id: string; nombre: string; fecha_sorteo: string }>(
    `UPDATE ${t}
        SET estado = 'cerrado', updated_at = now()
      WHERE empresa_id = $1::uuid
        AND estado = 'activo'
        AND fecha_sorteo IS NOT NULL
        AND fecha_sorteo <= now()
      RETURNING id::text, nombre, fecha_sorteo::text`,
    [empresaId]
  );
  return r.rows;
}
