import type { SupabaseAdmin } from "@/lib/chat/types";
import { extractReferralTokenFromInboundText } from "@/lib/sorteos/referral-inbound-text";
import { isInheritedReferral } from "@/lib/sorteos/referral-inheritance";

const LOG = "[sorteo-referral]" as const;

const ERR_MAX = 280;

function clipErr(msg: string | undefined): string | undefined {
  if (!msg || typeof msg !== "string") return undefined;
  const t = msg.trim();
  if (t.length <= ERR_MAX) return t;
  return t.slice(0, ERR_MAX) + "…";
}

/** Token opaco: solo extremos, nunca el valor completo. */
function partialToken(tok: string | null | undefined): string | null {
  if (!tok?.trim()) return null;
  const t = tok.trim();
  if (t.length <= 10) return `[len:${t.length}]`;
  return `${t.slice(0, 4)}…${t.slice(-4)}`;
}

/** UUID: solo extremos. */
function partialUuid(id: string | null | undefined): string | null {
  if (!id?.trim()) return null;
  const t = id.trim();
  if (t.length <= 14) return `[len:${t.length}]`;
  return `${t.slice(0, 8)}…${t.slice(-4)}`;
}

export type ApplyReferralParams = {
  supabase: SupabaseAdmin;
  empresaId: string;
  conversationId: string;
  activeFlowSessionId: string | null | undefined;
  flowCode: string | null | undefined;
  inboundText: string;
  contactPhoneDigits: string;
};

/**
 * Atribuye revendedor a la sesión de flujo activa (no pisa si la sesión ya tiene revendedor).
 * 1) Canje de token (sorteo_revendedor_clicks) — fuente robusta post-click /r
 * 2) Código legible en sorteo_revendedores — respaldo / auditoría
 */
export async function applySorteoReferralToActiveSession(
  params: ApplyReferralParams
): Promise<void> {
  const tokenForLog = extractReferralTokenFromInboundText(params.inboundText);
  const inboundTrim = (params.inboundText ?? "").trim();
  console.info(LOG, "apply_enter", {
    hasInboundText: inboundTrim.length > 0,
    hasToken: Boolean(tokenForLog),
    tokenPartial: partialToken(tokenForLog),
    conversationId: params.conversationId,
    activeFlowSessionPresent: Boolean(params.activeFlowSessionId?.trim()),
    flowCodePresent: Boolean(params.flowCode?.trim()),
    empresaId: partialUuid(params.empresaId),
  });

  const sid = params.activeFlowSessionId?.trim();
  const fc = params.flowCode?.trim();
  if (!sid || !fc) {
    console.info(LOG, "early_exit", {
      reason: "missing_session_or_flow",
      hasSid: Boolean(sid),
      hasFlowCode: Boolean(fc),
    });
    return;
  }

  const tokenRaw = extractReferralTokenFromInboundText(params.inboundText);
  if (!tokenRaw) {
    console.info(LOG, "early_exit", { reason: "missing_token_in_text" });
    return;
  }

  const { data: sessionRow, error: sErr } = await params.supabase
    .from("chat_flow_sessions")
    .select("id, revendedor_id, empresa_id, conversation_id, referral_source")
    .eq("id", sid)
    .eq("empresa_id", params.empresaId)
    .maybeSingle();

  console.info(LOG, "session_query", {
    sessionFound: Boolean(sessionRow) && !sErr,
    error: clipErr(sErr?.message),
    conversationId: params.conversationId,
    activeFlowSessionId: partialUuid(sid),
  });

  if (sErr || !sessionRow) {
    console.warn(LOG, "session_load_failed", sErr?.message);
    return;
  }

  const existingRev = (sessionRow as { revendedor_id?: string | null }).revendedor_id;
  const convIdFromSession = (sessionRow as { conversation_id?: string }).conversation_id;
  console.info(LOG, "session_row", {
    sessionFound: true,
    sessionConversationMatches: convIdFromSession === params.conversationId,
    alreadyHasRevendedor: Boolean(existingRev),
    activeFlowSessionId: partialUuid(sid),
  });

  const existingIsInherited = isInheritedReferral(
    sessionRow as { revendedor_id?: string | null; referral_source?: string | null }
  );
  if (existingRev && !existingIsInherited) {
    console.info(LOG, "early_exit", { reason: "session_already_has_revendedor" });
    return;
  }

  if (convIdFromSession !== params.conversationId) {
    console.warn(LOG, "session_conversation_mismatch", {
      sid: partialUuid(sid),
      conversationId: params.conversationId,
    });
    return;
  }

  const { data: flowRow, error: flowErr } = await params.supabase
    .from("chat_flows")
    .select("sorteo_id")
    .eq("empresa_id", params.empresaId)
    .eq("flow_code", fc)
    .maybeSingle();

  const sorteoId = (flowRow as { sorteo_id?: string | null } | null)?.sorteo_id?.trim() ?? null;
  console.info(LOG, "flow_lookup", {
    flowCode: fc,
    hasSorteoId: Boolean(sorteoId),
    flowSorteoIdPartial: partialUuid(sorteoId),
    error: clipErr(flowErr?.message),
  });

  if (!sorteoId) {
    console.info(LOG, "early_exit", {
      reason: flowErr ? "flow_query_error_or_empty" : "flow_missing_sorteo_id",
      flowCode: fc,
    });
    return;
  }

  const nowIso = new Date().toISOString();

  const { data: clickRow, error: clickErr } = await params.supabase
    .from("sorteo_revendedor_clicks")
    .select("id, revendedor_id, sorteo_id, empresa_id, redeemed_at, expires_at")
    .eq("attribution_token", tokenRaw)
    .eq("empresa_id", params.empresaId)
    .maybeSingle();

  console.info(LOG, "click_lookup", {
    clickFound: Boolean(clickRow) && !clickErr,
    tokenPartial: partialToken(tokenRaw),
    error: clipErr(clickErr?.message),
  });

  const click = clickRow as
    | {
        id: string;
        revendedor_id: string;
        sorteo_id: string;
        redeemed_at: string | null;
        expires_at: string;
      }
    | null;

  const expired =
    click && new Date(click.expires_at).getTime() <= Date.now();
  if (click && click.redeemed_at) {
    console.info(LOG, "discard_click", { reason: "already_redeemed", clickIdPartial: partialUuid(click.id) });
  } else if (click && click.sorteo_id !== sorteoId) {
    console.info(LOG, "discard_click", {
      reason: "sorteo_mismatch",
      clickSorteoIdPartial: partialUuid(click.sorteo_id),
      flowSorteoIdPartial: partialUuid(sorteoId),
      isExpired: Boolean(expired),
    });
  } else if (click && expired) {
    console.info(LOG, "discard_click", {
      reason: "expired_click",
      clickSorteoIdPartial: partialUuid(click.sorteo_id),
      flowSorteoIdPartial: partialUuid(sorteoId),
      isExpired: true,
    });
  }

  if (
    click &&
    !click.redeemed_at &&
    click.sorteo_id === sorteoId &&
    new Date(click.expires_at).getTime() > Date.now()
  ) {
    const { data: rev } = await params.supabase
      .from("sorteo_revendedores")
      .select("id, codigo_referido, activo, sorteo_id")
      .eq("id", click.revendedor_id)
      .eq("empresa_id", params.empresaId)
      .maybeSingle();

    const r = rev as
      | { id: string; codigo_referido: string; activo: boolean; sorteo_id: string }
      | null;

    if (!r || !r.activo || r.sorteo_id !== sorteoId) {
      console.info(LOG, "early_exit", {
        reason: "revendedor_row_invalid",
        hasRevRow: Boolean(r),
        activo: r?.activo ?? null,
        revSorteoMatches: r ? r.sorteo_id === sorteoId : null,
      });
      return;
    }

    const { error: upSess } = await params.supabase
      .from("chat_flow_sessions")
      .update({
        revendedor_id: r.id,
        codigo_referido_snapshot: r.codigo_referido,
        referral_source: "click_token",
      })
      .eq("id", sid)
      .eq("empresa_id", params.empresaId)
      // Sin revendedor, o con uno solo heredado de un reinicio: un link/código nuevo manda.
    .is(existingIsInherited ? "referral_source" : "revendedor_id", null);

    if (upSess) {
      console.warn(LOG, "session_update_click_failed", upSess.message);
      console.info(LOG, "update_failed", {
        reason: "session_update_failed",
        error: clipErr(upSess.message),
      });
      return;
    }

    const { error: clickUpErr } = await params.supabase
      .from("sorteo_revendedor_clicks")
      .update({
        redeemed_at: nowIso,
        conversation_id: params.conversationId,
        flow_session_id: sid,
        contact_phone_norm: params.contactPhoneDigits || null,
      })
      .eq("id", click.id)
      .is("redeemed_at", null);

    if (clickUpErr) {
      console.warn(LOG, "click_redeem_update_failed", clickUpErr.message);
      console.info(LOG, "update_failed", {
        reason: "click_update_failed",
        error: clipErr(clickUpErr.message),
      });
    }

    await setFirstRevendedorOnConversation(
      params.supabase,
      params.empresaId,
      params.conversationId,
      r.id
    );

    console.info(LOG, "attributed_click_token", {
      conversationId: params.conversationId,
      flowSessionId: sid,
      revendedorId: r.id,
    });
    console.info(LOG, "redeemed_ok", {
      reason: "redeemed_ok",
      conversationId: params.conversationId,
      activeFlowSessionId: partialUuid(sid),
      revendedorIdPartial: partialUuid(r.id),
      clickIdPartial: partialUuid(click.id),
    });
    return;
  }

  const { data: byCode } = await params.supabase
    .from("sorteo_revendedores")
    .select("id, codigo_referido, activo, sorteo_id")
    .eq("empresa_id", params.empresaId)
    .eq("sorteo_id", sorteoId)
    .ilike("codigo_referido", tokenRaw)
    .maybeSingle();

  const rc = byCode as
    | { id: string; codigo_referido: string; activo: boolean; sorteo_id: string }
    | null;

  if (!rc || !rc.activo) {
    console.info(LOG, "early_exit", {
      reason: "inbound_code_path_no_match",
      hasRevendedorRow: Boolean(rc),
      activo: rc?.activo ?? null,
    });
    return;
  }

  const { error: upSess2 } = await params.supabase
    .from("chat_flow_sessions")
    .update({
      revendedor_id: rc.id,
      codigo_referido_snapshot: rc.codigo_referido,
      referral_source: "inbound_text",
    })
    .eq("id", sid)
    .eq("empresa_id", params.empresaId)
    // Sin revendedor, o con uno solo heredado de un reinicio: un link/código nuevo manda.
    .is(existingIsInherited ? "referral_source" : "revendedor_id", null);

  if (upSess2) {
    console.warn(LOG, "session_update_code_failed", upSess2.message);
    console.info(LOG, "update_failed", {
      reason: "session_update_failed",
      error: clipErr(upSess2.message),
    });
    return;
  }

  await setFirstRevendedorOnConversation(
    params.supabase,
    params.empresaId,
    params.conversationId,
    rc.id
  );

  console.info(LOG, "attributed_inbound_code", {
    conversationId: params.conversationId,
    flowSessionId: sid,
    revendedorId: rc.id,
  });
}

async function setFirstRevendedorOnConversation(
  supabase: SupabaseAdmin,
  empresaId: string,
  conversationId: string,
  revendedorId: string
): Promise<void> {
  const { data: conv } = await supabase
    .from("chat_conversations")
    .select("first_revendedor_id")
    .eq("id", conversationId)
    .eq("empresa_id", empresaId)
    .maybeSingle();

  if ((conv as { first_revendedor_id?: string | null } | null)?.first_revendedor_id) {
    return;
  }

  const { error: convUpErr } = await supabase
    .from("chat_conversations")
    .update({
      first_revendedor_id: revendedorId,
      first_referral_captured_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", conversationId)
    .eq("empresa_id", empresaId)
    .is("first_revendedor_id", null);

  if (convUpErr) {
    console.warn(LOG, "conversation_first_revendedor_update_failed", convUpErr.message);
    console.info(LOG, "update_failed", {
      reason: "conversation_update_failed",
      error: clipErr(convUpErr.message),
    });
  }
}
