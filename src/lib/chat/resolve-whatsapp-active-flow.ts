import { COMPROBANTE_BUTTON_IDS } from "@/lib/chat/comprobante-validation-types";
import { flowTrace } from "@/lib/chat/flow-trace-log";
import type { SupabaseAdmin } from "@/lib/chat/types";
import {
  insertActiveFlowSessionRow,
  markConversationActiveSessionsEnded,
} from "@/lib/chat/flow-session-service";

const LOG = "[webhook/whatsapp][flow-resolve]" as const;
export const CONV_LOG = "[webhook/whatsapp][conversation]" as const;

/** Marca en `chat_flow_events` que el puntero del flujo se reinició (sesión nueva para re-envío del nodo). */
export const FLOW_POINTER_RESET_EVENT = "flow_pointer_reset" as const;

/** Reinicio por intención de compra / keywords configurables (`flow_config`). */
export const RESTART_INTENT_DETECTED_EVENT = "restart_intent_detected" as const;

/**
 * @deprecated Los datos por sesión viven en `chat_flow_sessions` + `chat_flow_data.flow_session_id`;
 * el reinicio crea sesión nueva en lugar de borrar filas.
 */
export async function deleteChatFlowDataForConversationFlow(
  _supabase: SupabaseAdmin,
  _empresaId: string,
  _conversationId: string,
  _flowCode: string | null | undefined
): Promise<void> {
  /* no-op: histórico conservado por sesión */
}

export type ActiveFlowsCatalogResult =
  | {
      kind: "single";
      /** Flujo por defecto si hay que elegir (orden `flow_code` ASC). */
      flowCode: string;
      /** Todos los flujos activos considerados WhatsApp (legacy puede tener `channel` null/vacío). */
      allActiveCodes: string[];
      ambiguous: boolean;
    }
  | { kind: "none" };

const OMNI_FLOW = "[omnichannel-flow]" as const;
/** Logs de reinicio de puntero / sesión (buscar en Vercel: flow-restart). */
const FLOW_RESTART = "[flow-restart]" as const;

function rowIsWhatsappChannel(row: { channel?: string | null }): boolean {
  const ch = String(row.channel ?? "").trim().toLowerCase();
  return !ch || ch === "whatsapp";
}

/**
 * Flujos marcados activos para WhatsApp (canal `whatsapp`, null o vacío = legado).
 * Si hay varios activos, `flowCode` es el primero por orden lexicográfico y `ambiguous=true`.
 */
export async function listActiveWhatsappFlowsForEmpresa(
  supabase: SupabaseAdmin,
  empresaId: string
): Promise<ActiveFlowsCatalogResult> {
  const { data, error } = await supabase
    .from("chat_flows")
    .select("flow_code, channel")
    .eq("empresa_id", empresaId)
    .eq("activo", true)
    .order("flow_code", { ascending: true });

  if (error) {
    console.error(LOG, "catalog_query_failed", { empresaId, message: error.message });
    throw new Error(error.message);
  }

  const codes = [
    ...new Set(
      (data ?? [])
        .filter((r) => rowIsWhatsappChannel(r as { channel?: string | null }))
        .map((r) => String((r as { flow_code?: string }).flow_code ?? "").trim())
        .filter(Boolean)
    ),
  ].sort((a, b) => a.localeCompare(b));

  if (codes.length === 0) return { kind: "none" };

  const canonical = codes[0];
  const ambiguous = codes.length > 1;
  if (ambiguous) {
    console.warn(OMNI_FLOW, "multiple_whatsapp_flows_using_canonical", {
      empresaId,
      chosen_flow_code: canonical,
      allActiveCodes: codes,
    });
  }

  return { kind: "single", flowCode: canonical, allActiveCodes: codes, ambiguous };
}

/**
 * Primer nodo activo del flujo (sort_order, luego created_at). Sin filas → null.
 */
export async function getFirstActiveNodeCodeForFlow(
  supabase: SupabaseAdmin,
  empresaId: string,
  flowCode: string
): Promise<string | null> {
  const { data, error } = await supabase
    .from("chat_flow_nodes")
    .select("node_code, sort_order, created_at")
    .eq("empresa_id", empresaId)
    .eq("flow_code", flowCode)
    .eq("is_active", true)
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true })
    .limit(1);

  if (error) {
    console.error(LOG, "first_node_query_failed", { empresaId, flowCode, message: error.message });
    return null;
  }
  const row = data?.[0] as { node_code?: string } | undefined;
  return row?.node_code?.trim() || null;
}

export type SyncConversationFlowResult = {
  flow_code: string | null;
  flow_current_node: string | null;
  changed: boolean;
};

/**
 * Asigna o corrige flow_code / nodo inicial según catálogo activo.
 * - Varios flujos activos: si la conv ya tiene `flow_code` entre los activos, se conserva.
 * - Si no hay flujo en conv o el código ya no está en catálogo → se asigna el canónico (primer `flow_code`).
 */
export async function syncWhatsappConversationFlowFromCatalog(
  supabase: SupabaseAdmin,
  empresaId: string,
  conversationId: string,
  conv: { flow_code: string | null; flow_current_node: string | null }
): Promise<SyncConversationFlowResult> {
  const currentFlow = conv.flow_code?.trim() || null;
  const currentNode = conv.flow_current_node?.trim() || null;

  const catalog = await listActiveWhatsappFlowsForEmpresa(supabase, empresaId);

  if (catalog.kind === "none") {
    console.warn(LOG, "no_active_flow_found", { empresaId, conversationId, currentFlow });
    return { flow_code: currentFlow, flow_current_node: currentNode, changed: false };
  }

  const allActive = catalog.allActiveCodes;
  if (currentFlow && allActive.includes(currentFlow)) {
    console.info(LOG, "resolved_active_flow", {
      empresaId,
      conversationId,
      flowCode: currentFlow,
      reason: "conversation_flow_in_active_catalog",
      ambiguous: catalog.ambiguous,
    });
    return { flow_code: currentFlow, flow_current_node: currentNode, changed: false };
  }

  const targetFlow = catalog.flowCode;

  if (currentFlow === targetFlow) {
    console.info(LOG, "resolved_active_flow", {
      empresaId,
      conversationId,
      flowCode: targetFlow,
      flow_current_node: currentNode,
      action: "unchanged_single_active_match",
    });
    return { flow_code: targetFlow, flow_current_node: currentNode, changed: false };
  }

  const firstNode = (await getFirstActiveNodeCodeForFlow(supabase, empresaId, targetFlow)) ?? "inicio";

  if (currentFlow) {
    console.warn(LOG, "previous_flow_inactive", {
      conversationId,
      previousFlow: currentFlow,
      previousNode: currentNode,
      targetFlow,
      targetInitialNode: firstNode,
    });
  }

  console.info(LOG, "resolved_active_flow", {
    empresaId,
    conversationId,
    flowCode: targetFlow,
    flow_current_node: firstNode,
    action: "assign_single_active_flow",
  });

  await markConversationActiveSessionsEnded(
    supabase,
    empresaId,
    conversationId,
    "abandoned",
    "catalog_flow_reassigned"
  );
  const newSid = await insertActiveFlowSessionRow(supabase, empresaId, conversationId, targetFlow);
  if (!newSid) {
    console.error(LOG, "session_create_on_catalog_assign_failed", { conversationId, targetFlow });
    return { flow_code: currentFlow, flow_current_node: currentNode, changed: false };
  }

  const { error: updErr } = await supabase
    .from("chat_conversations")
    .update({
      flow_code: targetFlow,
      flow_current_node: firstNode,
      active_flow_session_id: newSid,
      updated_at: new Date().toISOString(),
    })
    .eq("id", conversationId)
    .eq("empresa_id", empresaId);

  if (updErr) {
    console.error(LOG, "conversation_flow_update_failed", { conversationId, message: updErr.message });
    return { flow_code: currentFlow, flow_current_node: currentNode, changed: false };
  }

  console.info(LOG, "conversation_flow_updated", {
    conversationId,
    flow_code: targetFlow,
    flow_current_node: firstNode,
    active_flow_session_id: newSid,
  });

  return { flow_code: targetFlow, flow_current_node: firstNode, changed: true };
}

/**
 * Resultado de una verificación contra el catálogo. `unknown` = la consulta FALLÓ (API caída un
 * momento): no sabemos si el flujo/nodo es válido, y no hay que tratarlo como inválido.
 */
export type CatalogCheck = "yes" | "no" | "unknown";

/** Fila en catálogo y activa. `unknown` si la consulta falló. */
export async function checkFlowKnownAndActiveInCatalog(
  supabase: SupabaseAdmin,
  empresaId: string,
  flowCode: string
): Promise<CatalogCheck> {
  const fc = flowCode.trim();
  if (!fc) return "no";
  const { data, error } = await supabase
    .from("chat_flows")
    .select("activo")
    .eq("empresa_id", empresaId)
    .eq("flow_code", fc)
    .maybeSingle();
  if (error) {
    console.warn(LOG, "flow_check_query_failed", { empresaId, flowCode: fc, message: error.message });
    return "unknown";
  }
  if (!data) return "no";
  return (data as { activo?: boolean }).activo === true ? "yes" : "no";
}

/** Fila en catálogo y activa (si no hay fila → false = flujo inexistente en catálogo). */
export async function isFlowKnownAndActiveInCatalog(
  supabase: SupabaseAdmin,
  empresaId: string,
  flowCode: string
): Promise<boolean> {
  return (await checkFlowKnownAndActiveInCatalog(supabase, empresaId, flowCode)) === "yes";
}

/** Nodo activo en ese flujo. `unknown` si la consulta falló. */
export async function checkNodeActiveInFlow(
  supabase: SupabaseAdmin,
  empresaId: string,
  flowCode: string,
  nodeCode: string
): Promise<CatalogCheck> {
  const nc = nodeCode.trim();
  const fc = flowCode.trim();
  if (!fc || !nc) return "no";
  const { data, error } = await supabase
    .from("chat_flow_nodes")
    .select("id")
    .eq("empresa_id", empresaId)
    .eq("flow_code", fc)
    .eq("node_code", nc)
    .eq("is_active", true)
    .maybeSingle();
  if (error) {
    console.warn(LOG, "node_check_query_failed", {
      empresaId,
      flowCode: fc,
      nodeCode: nc,
      message: error.message,
    });
    return "unknown";
  }
  return (data as { id?: string } | null)?.id ? "yes" : "no";
}

/** Nodo activo en ese flujo. */
export async function isNodeActiveInFlow(
  supabase: SupabaseAdmin,
  empresaId: string,
  flowCode: string,
  nodeCode: string
): Promise<boolean> {
  return (await checkNodeActiveInFlow(supabase, empresaId, flowCode, nodeCode)) === "yes";
}

/**
 * Handoff por botón: incluye el de comprobantes (lo procesa el flow-engine en `image_input`).
 */
export const HUMAN_HANDOFF_BUTTON_IDS = new Set<string>([
  COMPROBANTE_BUTTON_IDS.hablar_asesor,
  "human_handoff",
  "talk_to_human",
  "hablar_asesor",
  "derivar_asesor",
]);

/**
 * Takeover **antes** del engine: no incluye `cmp_hablar_asesor` porque el motor envía el texto
 * de despedida y persiste el evento cuando el nodo es `image_input`.
 */
export const WEBHOOK_IMMEDIATE_HANDOFF_BUTTON_IDS = new Set<string>([
  "human_handoff",
  "talk_to_human",
  "hablar_asesor",
  "derivar_asesor",
]);

/**
 * Cliente pide explícitamente hablar con una persona (takeover humano).
 * Normalización alineada con `matchesConversationRestartKeyword`.
 */
export function matchesHumanHandoffKeyword(text: string): boolean {
  const raw = text
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  if (!raw) return false;
  const tokens = raw.split(/\s+/).filter(Boolean);
  if (tokens.some((t) => t === "asesor" || t === "humano")) return true;
  if (/\boperador\b/.test(raw)) return true;
  if (/\bhablar\s+con\s+(un\s+)?asesor\b/.test(raw)) return true;
  if (/\bquiero\s+(un\s+)?asesor\b/.test(raw)) return true;
  return false;
}

export { matchesConversationRestartKeyword } from "@/lib/chat/bot-wake-keywords";

export type RestartToFlowStartResult = {
  flow_code: string | null;
  flow_current_node: string | null;
  restarted: boolean;
  reason: string;
  /** Sesión `chat_flow_sessions` creada en este reinicio (si `restarted`). */
  new_flow_session_id?: string | null;
};

export type RestartWhatsappConversationOpts = {
  preferFlowCode?: string | null;
  trigger: string;
  /** Si existe y está activo en el flujo, el puntero arranca ahí (opciones de boletos, etc.). */
  targetNodeCode?: string | null;
  /** Copia `revendedor_id` / snapshot desde la sesión cerrada hacia la nueva. */
  preserveReferralFromPreviousSession?: boolean;
  /** Inserta `restart_intent_detected` en `chat_flow_events`. */
  intentAudit?: { matched_keyword: string };
};

/**
 * Reinicia conversación al primer nodo de un flujo activo.
 * - Un solo flujo activo en catálogo → ese.
 * - Varios: solo si `preferFlowCode` está en la lista activa; si no, no elige al azar.
 * Pone flow_status=bot y human_taken_over=false.
 */
export async function restartWhatsappConversationToFlowStart(
  supabase: SupabaseAdmin,
  empresaId: string,
  conversationId: string,
  opts: RestartWhatsappConversationOpts
): Promise<RestartToFlowStartResult> {
  console.info(FLOW_RESTART, "restart_begin", {
    empresaId,
    conversationId,
    trigger: opts.trigger,
    preferFlowCode: opts.preferFlowCode ?? null,
  });
  const catalog = await listActiveWhatsappFlowsForEmpresa(supabase, empresaId);
  console.info(CONV_LOG, "restart_attempt", {
    conversationId,
    trigger: opts.trigger,
    preferFlowCode: opts.preferFlowCode ?? null,
    catalogKind: catalog.kind,
    activeFlowCodes: catalog.kind === "single" ? catalog.allActiveCodes : [],
  });
  if (catalog.kind === "none") {
    console.warn(FLOW_RESTART, "restart_failed", { reason: "no_active_flow", conversationId });
    console.warn(CONV_LOG, "conversation_restarted", {
      conversationId,
      ok: false,
      detail: "no_active_flow_found",
      trigger: opts.trigger,
    });
    return { flow_code: null, flow_current_node: null, restarted: false, reason: "no_active_flow" };
  }

  const pref = opts.preferFlowCode?.trim() || null;
  const codes = catalog.allActiveCodes;
  const targetFlow: string | null =
    pref && codes.includes(pref) ? pref : catalog.flowCode;
  if (pref && !codes.includes(pref)) {
    console.warn(CONV_LOG, "restart_prefer_not_in_catalog_using_canonical", {
      conversationId,
      preferFlowCode: pref,
      chosenFlow: targetFlow,
      activeFlowCodes: codes,
      trigger: opts.trigger,
    });
  }

  const canonicalFirst =
    (await getFirstActiveNodeCodeForFlow(supabase, empresaId, targetFlow)) ?? "inicio";
  const requested = opts.targetNodeCode?.trim() || null;
  let firstNode = canonicalFirst;
  if (requested) {
    const okTarget = await isNodeActiveInFlow(supabase, empresaId, targetFlow, requested);
    if (okTarget) {
      firstNode = requested;
    } else {
      console.warn(FLOW_RESTART, "target_node_invalid_fallback_first", {
        empresaId,
        conversationId,
        targetFlow,
        requested,
        fallback: canonicalFirst,
      });
    }
  }

  const { data: convBeforeRestart } = await supabase
    .from("chat_conversations")
    .select("active_flow_session_id, flow_code, flow_current_node")
    .eq("id", conversationId)
    .eq("empresa_id", empresaId)
    .maybeSingle();
  const previousActiveFlowSessionId =
    (convBeforeRestart as { active_flow_session_id?: string | null } | null)?.active_flow_session_id ??
    null;

  flowTrace("restart_flow_session_before_close_old", {
    conversation_id: conversationId,
    empresa_id: empresaId,
    trigger: opts.trigger,
    target_flow_code: targetFlow,
    previous_active_flow_session_id: previousActiveFlowSessionId,
    previous_flow_code: (convBeforeRestart as { flow_code?: string | null } | null)?.flow_code ?? null,
    previous_flow_current_node:
      (convBeforeRestart as { flow_current_node?: string | null } | null)?.flow_current_node ?? null,
  });

  await markConversationActiveSessionsEnded(
    supabase,
    empresaId,
    conversationId,
    "restarted",
    opts.trigger
  );
  const newSessionId = await insertActiveFlowSessionRow(
    supabase,
    empresaId,
    conversationId,
    targetFlow
  );
  if (!newSessionId) {
    console.error(FLOW_RESTART, "restart_failed", { reason: "session_create_failed", conversationId });
    console.error(CONV_LOG, "conversation_restarted", {
      conversationId,
      ok: false,
      detail: "flow_session_insert_failed",
      trigger: opts.trigger,
    });
    return { flow_code: null, flow_current_node: null, restarted: false, reason: "session_create_failed" };
  }

  if (opts.preserveReferralFromPreviousSession && previousActiveFlowSessionId) {
    const { data: prevSess } = await supabase
      .from("chat_flow_sessions")
      .select("revendedor_id, codigo_referido_snapshot, referral_source")
      .eq("id", previousActiveFlowSessionId)
      .eq("empresa_id", empresaId)
      .maybeSingle();
    const p = prevSess as
      | {
          revendedor_id?: string | null;
          codigo_referido_snapshot?: string | null;
          referral_source?: string | null;
        }
      | null;
    if (p && (p.revendedor_id || (p.codigo_referido_snapshot ?? "").trim())) {
      const { error: refErr } = await supabase
        .from("chat_flow_sessions")
        .update({
          revendedor_id: p.revendedor_id ?? null,
          codigo_referido_snapshot: p.codigo_referido_snapshot ?? null,
          referral_source: p.referral_source ?? null,
        })
        .eq("id", newSessionId)
        .eq("empresa_id", empresaId);
      if (refErr) {
        console.warn(FLOW_RESTART, "preserve_referral_copy_failed", {
          conversationId,
          message: refErr.message,
        });
      }
    }
  }

  const { error: updErr } = await supabase
    .from("chat_conversations")
    .update({
      flow_code: targetFlow,
      flow_current_node: firstNode,
      flow_status: "bot",
      human_taken_over: false,
      active_flow_session_id: newSessionId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", conversationId)
    .eq("empresa_id", empresaId);

  if (updErr) {
    console.error(FLOW_RESTART, "restart_failed", {
      reason: "conversation_update_failed",
      conversationId,
      message: updErr.message,
    });
    console.error(CONV_LOG, "conversation_restarted", {
      conversationId,
      ok: false,
      message: updErr.message,
      trigger: opts.trigger,
    });
    return { flow_code: null, flow_current_node: null, restarted: false, reason: "update_failed" };
  }

  const { error: resetEvErr } = await supabase.from("chat_flow_events").insert({
    empresa_id: empresaId,
    conversation_id: conversationId,
    flow_code: targetFlow,
    node_code: firstNode,
    event_type: FLOW_POINTER_RESET_EVENT,
    flow_session_id: newSessionId,
    payload: { trigger: opts.trigger, flow_session_id: newSessionId },
  });
  if (resetEvErr) {
    console.error(CONV_LOG, "flow_pointer_reset_insert_failed", {
      conversationId,
      flow_code: targetFlow,
      node_code: firstNode,
      message: resetEvErr.message,
      trigger: opts.trigger,
    });
  }

  if (opts.intentAudit) {
    const { error: intentEvErr } = await supabase.from("chat_flow_events").insert({
      empresa_id: empresaId,
      conversation_id: conversationId,
      flow_code: targetFlow,
      node_code: firstNode,
      event_type: RESTART_INTENT_DETECTED_EVENT,
      flow_session_id: newSessionId,
      payload: {
        trigger: opts.trigger,
        matched_keyword: opts.intentAudit.matched_keyword,
        previous_session_id: previousActiveFlowSessionId,
        new_session_id: newSessionId,
        restart_node_code: firstNode,
      },
    });
    if (intentEvErr) {
      console.error(CONV_LOG, "restart_intent_detected_insert_failed", {
        conversationId,
        message: intentEvErr.message,
      });
    }
  }

  flowTrace("restart_flow_session_complete", {
    conversation_id: conversationId,
    empresa_id: empresaId,
    trigger: opts.trigger,
    target_flow_code: targetFlow,
    first_node: firstNode,
    previous_active_flow_session_id: previousActiveFlowSessionId,
    new_flow_session_id: newSessionId,
    event: "flow_pointer_reset",
  });

  console.info(CONV_LOG, "conversation_restarted", {
    conversationId,
    flow_code: targetFlow,
    flow_current_node: firstNode,
    trigger: opts.trigger,
  });
  console.info(FLOW_RESTART, "restart_ok", {
    conversationId,
    flow_code: targetFlow,
    flow_current_node: firstNode,
    flow_session_id: newSessionId,
    trigger: opts.trigger,
  });

  return {
    flow_code: targetFlow,
    flow_current_node: firstNode,
    restarted: true,
    reason: opts.trigger,
    new_flow_session_id: newSessionId,
  };
}
