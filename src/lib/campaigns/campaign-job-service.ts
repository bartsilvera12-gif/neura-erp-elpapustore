import "server-only";
import type { SupabaseAdmin } from "@/lib/chat/types";
import {
  sendCampaignRecipientMessage,
  type CampaignOutboundRow,
} from "@/lib/campaigns/campaign-send-service";

export const DEFAULT_BATCH_SIZE = 25;

export async function refreshCampaignCounters(supabase: SupabaseAdmin, empresaId: string, campaignId: string) {
  const statuses = [
    "pending",
    "invalid",
    "queued",
    "sending",
    "sent",
    "failed",
    "replied",
    "skipped",
  ] as const;

  const counts: Record<string, number> = {};
  for (const st of statuses) {
    const { count, error } = await supabase
      .from("chat_campaign_recipients")
      .select("id", { count: "exact", head: true })
      .eq("empresa_id", empresaId)
      .eq("campaign_id", campaignId)
      .eq("status", st);
    if (!error) counts[st] = count ?? 0;
    else counts[st] = 0;
  }

  await supabase
    .from("chat_campaigns")
    .update({
      pending_count: counts.pending ?? 0,
      invalid_count: counts.invalid ?? 0,
      queued_count: counts.queued ?? 0,
      sent_count: counts.sent ?? 0,
      failed_count: counts.failed ?? 0,
      replied_count: counts.replied ?? 0,
      updated_at: new Date().toISOString(),
    })
    .eq("id", campaignId)
    .eq("empresa_id", empresaId);
}

export async function runCampaignProcessOnce(params: {
  supabase: SupabaseAdmin;
  empresaId: string;
  campaignId: string;
  batchSize?: number;
}): Promise<{ processed: number; remainingQueued: number; campaignCompleted: boolean }> {
  const { supabase, empresaId, campaignId } = params;
  const batchSize = Math.min(100, Math.max(1, params.batchSize ?? DEFAULT_BATCH_SIZE));

  const { data: campaign, error: cErr } = await supabase
    .from("chat_campaigns")
    .select(
      "id, empresa_id, status, channel_id, queue_id, provider, template_name, template_language, template_components_json, template_id, send_config_json"
    )
    .eq("id", campaignId)
    .eq("empresa_id", empresaId)
    .maybeSingle();

  if (cErr || !campaign) {
    return { processed: 0, remainingQueued: 0, campaignCompleted: false };
  }

  const st = String((campaign as { status?: string }).status ?? "");
  if (st !== "sending") {
    return { processed: 0, remainingQueued: 0, campaignCompleted: st === "completed" || st === "cancelled" };
  }

  // Recupera filas atascadas en 'sending' de una ejecución MUERTA (sin provider_message_id),
  // pero SOLO si llevan >5 min así. Sin el filtro de antigüedad, esto re-encolaba envíos recién
  // reclamados y todavía EN VUELO por otra ejecución concurrente → los reenviaba (duplicados).
  // 5 min queda MUY por encima de cualquier envío real (que además, si lanza, ya se marca 'failed'
  // por el try/catch de abajo): solo se re-encola lo que quedó colgado por caída dura del proceso.
  const staleSendingBefore = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  await supabase
    .from("chat_campaign_recipients")
    .update({ status: "queued", updated_at: new Date().toISOString() })
    .eq("empresa_id", empresaId)
    .eq("campaign_id", campaignId)
    .eq("status", "sending")
    .is("provider_message_id", null)
    .lt("updated_at", staleSendingBefore);

  if ((campaign as { template_id?: string | null }).template_id) {
    const tid = (campaign as { template_id: string }).template_id;
    const { data: tpl } = await supabase
      .from("chat_campaign_templates")
      .select("status")
      .eq("id", tid)
      .eq("empresa_id", empresaId)
      .maybeSingle();
    const tst = String((tpl as { status?: string } | null)?.status ?? "").toUpperCase();
    if (tpl && tst !== "APPROVED") {
      await supabase
        .from("chat_campaigns")
        .update({
          status: "failed",
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", campaignId)
        .eq("empresa_id", empresaId);
      await supabase.from("chat_campaign_events").insert({
        empresa_id: empresaId,
        campaign_id: campaignId,
        recipient_id: null,
        event_type: "failed",
        event_payload_json: { reason: "template_no_longer_approved" },
      });
      return { processed: 0, remainingQueued: 0, campaignCompleted: true };
    }
  }

  const { data: batch } = await supabase
    .from("chat_campaign_recipients")
    .select(
      "id, phone_e164, mapped_variables_json, provider_message_id, status"
    )
    .eq("empresa_id", empresaId)
    .eq("campaign_id", campaignId)
    .eq("status", "queued")
    .order("row_number", { ascending: true })
    .limit(batchSize);

  const rows = (batch ?? []) as Array<{
    id: string;
    phone_e164: string;
    mapped_variables_json: Record<string, unknown>;
    provider_message_id: string | null;
    status: string;
  }>;

  let processed = 0;

  for (const rec of rows) {
    if (rec.provider_message_id) {
      processed += 1;
      continue;
    }

    const ts = new Date().toISOString();
    // CLAIM ATÓMICO anti-duplicados: solo enviamos si ESTA ejecución logra pasar la fila de
    // 'queued' a 'sending'. El UPDATE condicional toma el lock de fila en Postgres; si otra
    // ejecución concurrente (otro /process, otra pestaña) ya la reclamó o ya la envió, matchea 0
    // filas y salteamos → nunca se manda dos veces, sin importar cuántas corran en paralelo.
    const { data: claimed, error: claimErr } = await supabase
      .from("chat_campaign_recipients")
      .update({ status: "sending", updated_at: ts })
      .eq("id", rec.id)
      .eq("empresa_id", empresaId)
      .eq("status", "queued")
      .is("provider_message_id", null)
      .select("id");
    if (claimErr || !claimed || claimed.length === 0) {
      // otra ejecución ya reclamó/envió este destinatario
      continue;
    }

    // Si el envío LANZA (excepción de red/DB), marcamos la fila 'failed' en vez de dejarla en
    // 'sending': así la re-encolada NO la reintenta (evita un posible duplicado si Meta ya la había
    // aceptado) y un throw no aborta el resto del batch.
    let send: Awaited<ReturnType<typeof sendCampaignRecipientMessage>>;
    try {
      send = await sendCampaignRecipientMessage({
        supabase,
        campaign: campaign as CampaignOutboundRow,
        recipient: {
          id: rec.id,
          phone_e164: rec.phone_e164,
          mapped_variables_json: (rec.mapped_variables_json || {}) as Record<string, unknown>,
        },
      });
    } catch (e) {
      const emsg = e instanceof Error ? e.message : String(e);
      await supabase
        .from("chat_campaign_recipients")
        .update({
          status: "failed",
          failed_at: ts,
          error_message: emsg.slice(0, 2000),
          error_code: "exception",
          updated_at: ts,
        })
        .eq("id", rec.id)
        .eq("empresa_id", empresaId);
      await supabase.from("chat_campaign_events").insert({
        empresa_id: empresaId,
        campaign_id: campaignId,
        recipient_id: rec.id,
        event_type: "failed",
        event_payload_json: { error: emsg, thrown: true },
      });
      processed += 1;
      continue;
    }

    if (send.ok) {
      await supabase
        .from("chat_campaign_recipients")
        .update({
          status: "sent",
          provider_message_id: send.waMessageId,
          sent_at: ts,
          provider_payload_json: { wa_message_id: send.waMessageId },
          updated_at: ts,
        })
        .eq("id", rec.id)
        .eq("empresa_id", empresaId);

      await supabase.from("chat_campaign_events").insert({
        empresa_id: empresaId,
        campaign_id: campaignId,
        recipient_id: rec.id,
        event_type: "sent",
        event_payload_json: { wa_message_id: send.waMessageId },
      });
    } else {
      await supabase
        .from("chat_campaign_recipients")
        .update({
          status: "failed",
          failed_at: ts,
          error_message: send.error.slice(0, 2000),
          error_code: send.code ?? null,
          updated_at: ts,
        })
        .eq("id", rec.id)
        .eq("empresa_id", empresaId);

      await supabase.from("chat_campaign_events").insert({
        empresa_id: empresaId,
        campaign_id: campaignId,
        recipient_id: rec.id,
        event_type: "failed",
        event_payload_json: { error: send.error },
      });
    }

    processed += 1;
  }

  await refreshCampaignCounters(supabase, empresaId, campaignId);

  const { count: remainingQueued } = await supabase
    .from("chat_campaign_recipients")
    .select("id", { count: "exact", head: true })
    .eq("empresa_id", empresaId)
    .eq("campaign_id", campaignId)
    .eq("status", "queued");

  const rq = remainingQueued ?? 0;

  const { count: stillSending } = await supabase
    .from("chat_campaign_recipients")
    .select("id", { count: "exact", head: true })
    .eq("empresa_id", empresaId)
    .eq("campaign_id", campaignId)
    .eq("status", "sending");

  if (rq === 0 && (stillSending ?? 0) === 0) {
    await supabase
      .from("chat_campaigns")
      .update({
        status: "completed",
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", campaignId)
      .eq("empresa_id", empresaId);

    await supabase.from("chat_campaign_events").insert({
      empresa_id: empresaId,
      campaign_id: campaignId,
      recipient_id: null,
      event_type: "completed",
      event_payload_json: {},
    });

    await supabase
      .from("chat_campaign_jobs")
      .update({
        status: "done",
        updated_at: new Date().toISOString(),
      })
      .eq("campaign_id", campaignId)
      .eq("empresa_id", empresaId);

    return { processed, remainingQueued: 0, campaignCompleted: true };
  }

  return { processed, remainingQueued: rq, campaignCompleted: false };
}
