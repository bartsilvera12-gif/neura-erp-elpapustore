import { NextRequest, NextResponse } from "next/server";
import { getChatServiceClientForEmpresa } from "@/app/api/chat/_chat-service-client";
import { successResponse, errorResponse } from "@/lib/api/response";
import { requireCampanasApiAccess } from "@/lib/campaigns/campaign-auth";
import { templateSnapshotHasHeaderImage } from "@/lib/campaigns/campaign-header-image";
import { findTemplateHeaderDefaultUrl } from "@/lib/campaigns/template-header-default";

export async function GET(request: NextRequest) {
  const auth = await requireCampanasApiAccess(request);
  if (!auth.ok) {
    return NextResponse.json(errorResponse(auth.message), { status: auth.status });
  }

  try {
    const sb = await getChatServiceClientForEmpresa(auth.empresaId);
    const { data, error } = await sb
      .from("chat_campaigns")
      .select(
        "id, name, channel_id, queue_id, provider, template_name, template_language, template_category, status, total_count, sent_count, failed_count, replied_count, created_at, updated_at"
      )
      .eq("empresa_id", auth.empresaId)
      .order("created_at", { ascending: false })
      .limit(200);

    if (error) {
      return NextResponse.json(errorResponse(error.message), { status: 400 });
    }

    const rows = (data ?? []) as Array<{
      channel_id: string | null;
      template_name: string | null;
      template_category: string | null;
      [k: string]: unknown;
    }>;

    // Las campañas viejas pueden no tener template_category guardado.
    // Completamos la categoría buscándola en las plantillas por canal + nombre.
    if (rows.some((r) => !r.template_category && r.template_name)) {
      const { data: tpls } = await sb
        .from("chat_campaign_templates")
        .select("channel_id, name, category")
        .eq("empresa_id", auth.empresaId);
      const catByKey = new Map<string, string>();
      for (const t of (tpls ?? []) as Array<{
        channel_id: string | null;
        name: string | null;
        category: string | null;
      }>) {
        if (t.channel_id && t.name && t.category) {
          catByKey.set(`${t.channel_id}::${t.name}`, t.category);
        }
      }
      for (const r of rows) {
        if (!r.template_category && r.channel_id && r.template_name) {
          r.template_category = catByKey.get(`${r.channel_id}::${r.template_name}`) ?? null;
        }
      }
    }

    return NextResponse.json(successResponse(rows));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Error";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireCampanasApiAccess(request);
  if (!auth.ok) {
    return NextResponse.json(errorResponse(auth.message), { status: auth.status });
  }

  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const channelId = typeof body.channel_id === "string" ? body.channel_id.trim() : "";
    const queueId = typeof body.queue_id === "string" ? body.queue_id.trim() : null;
    const provider = typeof body.provider === "string" ? body.provider.trim().toLowerCase() : "";
    const templateId = typeof body.template_id === "string" ? body.template_id.trim() : null;
    const templateName = typeof body.template_name === "string" ? body.template_name.trim() : "";
    const templateLanguage =
      typeof body.template_language === "string" ? body.template_language.trim() : "es";
    const templateCategory =
      typeof body.template_category === "string" ? body.template_category.trim() : null;
    const templateComponentsJson = Array.isArray(body.template_components_json)
      ? body.template_components_json
      : [];

    if (!name || !channelId) {
      return NextResponse.json(errorResponse("name y channel_id son obligatorios"), { status: 400 });
    }
    if (provider !== "meta" && provider !== "ycloud") {
      return NextResponse.json(errorResponse("provider debe ser meta o ycloud"), { status: 400 });
    }
    if (!templateName) {
      return NextResponse.json(errorResponse("template_name es obligatorio"), { status: 400 });
    }

    // Si la plantilla tiene foto/video/PDF y se creó desde el ERP, su archivo queda como encabezado por defecto.
    const defaultHeaderUrl = templateSnapshotHasHeaderImage(templateComponentsJson)
      ? await findTemplateHeaderDefaultUrl({
          empresaId: auth.empresaId,
          channelId,
          name: templateName,
          language: templateLanguage,
        }).catch(() => null)
      : null;

    const sb = await getChatServiceClientForEmpresa(auth.empresaId);
    const { data, error } = await sb
      .from("chat_campaigns")
      .insert({
        ...(defaultHeaderUrl
          ? { send_config_json: { header_image_url: defaultHeaderUrl, template_header_default_url: defaultHeaderUrl } }
          : {}),
        empresa_id: auth.empresaId,
        name,
        channel_id: channelId,
        queue_id: queueId,
        provider,
        template_id: templateId,
        template_name: templateName,
        template_language: templateLanguage,
        template_category: templateCategory,
        template_components_json: templateComponentsJson,
        variable_mapping_json:
          body.variable_mapping_json && typeof body.variable_mapping_json === "object"
            ? body.variable_mapping_json
            : {},
        status: "draft",
        created_by: auth.usuarioCatalogId,
      })
      .select("id")
      .single();

    if (error) {
      return NextResponse.json(errorResponse(error.message), { status: 400 });
    }

    await sb.from("chat_campaign_events").insert({
      empresa_id: auth.empresaId,
      campaign_id: (data as { id: string }).id,
      recipient_id: null,
      event_type: "created",
      event_payload_json: {},
    });

    return NextResponse.json(successResponse(data));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Error";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
