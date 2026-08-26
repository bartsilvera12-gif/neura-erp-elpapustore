import { NextRequest, NextResponse } from "next/server";
import { getChatServiceClientForEmpresa } from "@/app/api/chat/_chat-service-client";
import { successResponse, errorResponse } from "@/lib/api/response";
import { requireCampanasApiAccess } from "@/lib/campaigns/campaign-auth";
import {
  applyHeaderImageSendConfigUpdate,
  resolveHeaderImageUrlForCampaign,
  templateSnapshotHasHeaderImage,
} from "@/lib/campaigns/campaign-header-image";
import {
  mappingSatisfiedForTemplate,
  normalizeVariableMapping,
  variableMappingCoversTemplate,
} from "@/lib/campaigns/campaign-mapping";
import { extractBodyPlaceholderKeysOrdered } from "@/lib/campaigns/campaign-template-payload";
import { driveCampaignToCompletion, runCampaignProcessOnce } from "@/lib/campaigns/campaign-job-service";
import type { SupabaseAdmin } from "@/lib/chat/types";

type RouteCtx = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, ctx: RouteCtx) {
  const auth = await requireCampanasApiAccess(request);
  if (!auth.ok) {
    return NextResponse.json(errorResponse(auth.message), { status: auth.status });
  }

  const { id: campaignId } = await ctx.params;

  try {
    const sb = await getChatServiceClientForEmpresa(auth.empresaId);

    const { data: campaign, error: cErr } = await sb
      .from("chat_campaigns")
      .select("id, status, template_components_json, template_name, send_config_json, variable_mapping_json")
      .eq("id", campaignId)
      .eq("empresa_id", auth.empresaId)
      .maybeSingle();

    if (cErr || !campaign) {
      return NextResponse.json(errorResponse("Campaña no encontrada"), { status: 404 });
    }

    const st = String((campaign as { status?: string }).status ?? "");
    if (st !== "draft" && st !== "ready") {
      return NextResponse.json(errorResponse("La campaña no está lista para enviar"), { status: 400 });
    }

    const { data: recipients, error: rErr } = await sb
      .from("chat_campaign_recipients")
      .select("id, mapped_variables_json, status, row_payload_json")
      .eq("campaign_id", campaignId)
      .eq("empresa_id", auth.empresaId);

    if (rErr) {
      return NextResponse.json(errorResponse(rErr.message), { status: 400 });
    }

    const tpl = (campaign as { template_components_json?: unknown }).template_components_json ?? [];

    const vmRaw = (campaign as { variable_mapping_json?: unknown }).variable_mapping_json ?? {};
    const mappingNorm =
      vmRaw && typeof vmRaw === "object" && !Array.isArray(vmRaw)
        ? normalizeVariableMapping(vmRaw as Record<string, unknown>)
        : {};

    const requiredSlots = extractBodyPlaceholderKeysOrdered(tpl as unknown[]);
    if (
      requiredSlots.length > 0 &&
      (Object.keys(mappingNorm).length === 0 || !variableMappingCoversTemplate(mappingNorm, tpl as unknown[]))
    ) {
      return NextResponse.json(
        errorResponse(
          "Completá el mapeo de variables (cada {{variable}} del body debe tener una columna del Excel asignada) y validá antes de enviar."
        ),
        { status: 400 }
      );
    }

    const headerResolution = resolveHeaderImageUrlForCampaign({
      templateComponentsJson: tpl,
      sendConfigJson: (campaign as { send_config_json?: unknown }).send_config_json,
      recipients: (recipients ?? []) as Array<{ status: string; row_payload_json: unknown }>,
    });

    if (templateSnapshotHasHeaderImage(tpl) && !headerResolution.ok) {
      return NextResponse.json(errorResponse(headerResolution.message), { status: 400 });
    }

    if (templateSnapshotHasHeaderImage(tpl) && headerResolution.ok && headerResolution.url) {
      const mergedSend = applyHeaderImageSendConfigUpdate(
        (campaign as { send_config_json?: unknown }).send_config_json,
        headerResolution
      );
      await sb
        .from("chat_campaigns")
        .update({
          send_config_json: mergedSend,
          updated_at: new Date().toISOString(),
        })
        .eq("id", campaignId)
        .eq("empresa_id", auth.empresaId);
    }

    const rows = (recipients ?? []) as Array<{
      id: string;
      mapped_variables_json: Record<string, unknown>;
      status: string;
    }>;

    const validRecipients = rows.filter((r) => r.status !== "invalid");

    if (validRecipients.length === 0) {
      return NextResponse.json(errorResponse("No hay destinatarios válidos"), { status: 400 });
    }

    for (const r of validRecipients) {
      const mv = (r.mapped_variables_json ?? {}) as Record<string, string>;
      if (!mappingSatisfiedForTemplate(tpl as unknown[], mv)) {
        return NextResponse.json(
          errorResponse("Completá el mapeo de variables y validá antes de enviar"),
          { status: 400 }
        );
      }
    }

    const ts = new Date().toISOString();

    await sb
      .from("chat_campaign_recipients")
      .update({
        status: "queued",
        queued_at: ts,
        updated_at: ts,
      })
      .eq("campaign_id", campaignId)
      .eq("empresa_id", auth.empresaId)
      .eq("status", "pending");

    await sb
      .from("chat_campaigns")
      .update({
        status: "sending",
        started_at: ts,
        pending_count: 0,
        queued_count: validRecipients.length,
        updated_at: ts,
      })
      .eq("id", campaignId)
      .eq("empresa_id", auth.empresaId);

    await sb.from("chat_campaign_events").insert({
      empresa_id: auth.empresaId,
      campaign_id: campaignId,
      recipient_id: null,
      event_type: "send_started",
      event_payload_json: {},
    });

    await sb.from("chat_campaign_jobs").insert({
      empresa_id: auth.empresaId,
      campaign_id: campaignId,
      status: "pending",
      batch_size: 25,
    });

    const first = await runCampaignProcessOnce({
      supabase: sb as unknown as SupabaseAdmin,
      empresaId: auth.empresaId,
      campaignId,
      batchSize: 25,
    });

    // Empuja el RESTO en el server (proceso Node persistente), sin depender de que la pestaña
    // quede abierta. Fire-and-forget: corre después de responder. El claim atómico lo hace seguro
    // aunque el navegador también pollee /process. `.catch` evita unhandledRejection.
    void driveCampaignToCompletion({
      supabase: sb as unknown as SupabaseAdmin,
      empresaId: auth.empresaId,
      campaignId,
    }).catch((e) => {
      console.error("[campaign-launch] driver_error", {
        campaign_id: campaignId,
        error: e instanceof Error ? e.message : String(e),
      });
    });

    return NextResponse.json(
      successResponse({
        launched: true,
        first_batch: first,
      })
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Error";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
