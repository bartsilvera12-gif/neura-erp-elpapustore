import { NextRequest, NextResponse } from "next/server";
import { getChatServiceClientForEmpresa } from "@/app/api/chat/_chat-service-client";
import { successResponse, errorResponse } from "@/lib/api/response";
import { describeUpstreamError } from "@/lib/api/upstream-error";
import { requireCampanasApiAccess } from "@/lib/campaigns/campaign-auth";
import {
  parseCampaignSpreadsheet,
  pickPhoneColumn,
} from "@/lib/campaigns/campaign-import-service";
import {
  CAMPAIGN_IMPORT_MAX_BYTES,
  CAMPAIGN_IMPORT_MAX_ROWS,
  formatCampaignImportMaxRows,
  formatCampaignImportMaxSize,
} from "@/lib/campaigns/campaign-import-limits";
import { normalizeCampaignPhone } from "@/lib/campaigns/campaign-phone";
import {
  applyHeaderImageSendConfigUpdate,
  evaluateHeaderImageOnImport,
  findHeaderImageUrlColumnKey,
  templateSnapshotHasHeaderImage,
} from "@/lib/campaigns/campaign-header-image";

type RouteCtx = { params: Promise<{ id: string }> };

/**
 * Importar 15.000 filas tarda más que el default de 15 s de algunos runtimes.
 * En el contenedor propio (Coolify) no aplica, pero no cuesta nada dejarlo.
 */
export const maxDuration = 120;

export async function POST(request: NextRequest, ctx: RouteCtx) {
  const auth = await requireCampanasApiAccess(request);
  if (!auth.ok) {
    return NextResponse.json(errorResponse(auth.message), { status: auth.status });
  }

  const { id: campaignId } = await ctx.params;

  try {
    const form = await request.formData();
    const file = form.get("file");
    const phoneHint = typeof form.get("phone_column") === "string" ? String(form.get("phone_column")) : "";

    if (!(file instanceof Blob)) {
      return NextResponse.json(errorResponse("Archivo file es obligatorio"), { status: 400 });
    }

    const buf = Buffer.from(await file.arrayBuffer());
    if (buf.length > CAMPAIGN_IMPORT_MAX_BYTES) {
      return NextResponse.json(
        errorResponse(`Archivo demasiado grande (máx. ${formatCampaignImportMaxSize()})`),
        { status: 400 }
      );
    }

    const filename = typeof file.name === "string" ? file.name : "upload.xlsx";
    const parsed = parseCampaignSpreadsheet(buf, filename);

    if (parsed.headers.length === 0 || parsed.rows.length === 0) {
      return NextResponse.json(errorResponse("El archivo no tiene filas de datos"), { status: 400 });
    }

    if (parsed.rows.length > CAMPAIGN_IMPORT_MAX_ROWS) {
      return NextResponse.json(
        errorResponse(`Demasiadas filas (máx. ${formatCampaignImportMaxRows()})`),
        { status: 400 }
      );
    }

    const phoneCol = pickPhoneColumn(parsed.headers, phoneHint || undefined);
    if (!phoneCol) {
      return NextResponse.json(errorResponse("No se detectó columna de teléfono"), { status: 400 });
    }

    const sb = await getChatServiceClientForEmpresa(auth.empresaId);

    const { data: camp, error: campErr } = await sb
      .from("chat_campaigns")
      .select("id, status, template_components_json, send_config_json")
      .eq("id", campaignId)
      .eq("empresa_id", auth.empresaId)
      .maybeSingle();

    if (campErr || !camp) {
      return NextResponse.json(errorResponse("Campaña no encontrada"), { status: 404 });
    }

    const st = String((camp as { status?: string }).status ?? "");
    if (st !== "draft" && st !== "ready") {
      return NextResponse.json(errorResponse("Solo se puede importar en borrador o lista para enviar"), {
        status: 400,
      });
    }

    await sb
      .from("chat_campaign_recipients")
      .delete()
      .eq("campaign_id", campaignId)
      .eq("empresa_id", auth.empresaId);

    const seen = new Set<string>();
    let rowNum = 0;
    let valid = 0;
    let invalid = 0;

    const headerImageCol = findHeaderImageUrlColumnKey(parsed.headers);
    const headerUrlPerValid: string[] = [];
    const tplComponents = (camp as { template_components_json?: unknown }).template_components_json;
    const needsHeaderImage = templateSnapshotHasHeaderImage(tplComponents);

    const ts = new Date().toISOString();

    // Construimos todas las filas en memoria y las insertamos en lotes (bulk).
    // Insertar de a una (await por fila) hacía timeout con archivos grandes:
    // ~5.000 round-trips PostgREST no entran en el límite de la función.
    const insertRows: Record<string, unknown>[] = [];

    for (const row of parsed.rows) {
      rowNum += 1;
      const rawPhone = row[phoneCol] ?? "";
      const norm = normalizeCampaignPhone(String(rawPhone));
      let status: "pending" | "invalid" = "pending";
      let validationError: string | null = null;
      let phoneE164 = "";

      if (!norm.ok) {
        status = "invalid";
        validationError = norm.error;
        invalid += 1;
      } else {
        phoneE164 = norm.e164;
        const d = norm.digits;
        if (seen.has(d)) {
          status = "invalid";
          validationError = "Duplicado en archivo";
          invalid += 1;
        } else {
          seen.add(d);
          valid += 1;
          if (headerImageCol) {
            headerUrlPerValid.push(String(row[headerImageCol] ?? "").trim());
          }
        }
      }

      const insertRow: Record<string, unknown> = {
        empresa_id: auth.empresaId,
        campaign_id: campaignId,
        row_number: rowNum,
        phone_raw: String(rawPhone).trim() || null,
        phone_e164: status === "invalid" ? `invalid_${rowNum}_${campaignId.slice(0, 8)}` : phoneE164 || "+0",
        row_payload_json: row,
        mapped_variables_json: {},
        status,
        validation_error: validationError,
        created_at: ts,
        updated_at: ts,
      };

      insertRows.push(insertRow);
    }

    /**
     * Inserción por lotes para no exceder el timeout con archivos grandes.
     * Con el límite en 15.000 filas son ~15 round-trips en vez de ~30, y si un
     * lote falla se borra lo ya insertado: una campaña a medias mandaría la
     * plantilla solo a una parte de la lista, sin forma de saber a quiénes.
     */
    const INSERT_CHUNK = 1000;
    for (let i = 0; i < insertRows.length; i += INSERT_CHUNK) {
      const chunk = insertRows.slice(i, i + INSERT_CHUNK);
      const { error: insErr } = await sb.from("chat_campaign_recipients").insert(chunk);
      if (insErr) {
        await sb
          .from("chat_campaign_recipients")
          .delete()
          .eq("campaign_id", campaignId)
          .eq("empresa_id", auth.empresaId);
        console.error("[campanas][import] insert_chunk_failed", {
          campaign_id: campaignId,
          chunk_start: i,
          total_rows: insertRows.length,
          error: insErr.message,
        });
        return NextResponse.json(
          errorResponse(
            `No se pudo importar la lista completa. ${describeUpstreamError(insErr.message)} No quedaron destinatarios cargados: volvé a subir el archivo.`
          ),
          { status: 400 }
        );
      }
    }

    const prevCfg = ((camp as { send_config_json?: unknown }).send_config_json ?? {}) as Record<string, unknown>;
    const templateDefaultUrl =
      typeof prevCfg.template_header_default_url === "string" ? prevCfg.template_header_default_url.trim() : "";
    const excelHasHeaderUrls = headerUrlPerValid.some((u) => u.trim() !== "");

    // Si el Excel no trae URL de cabecera y la plantilla tiene archivo por defecto (creada desde el ERP), se usa ese.
    // Si el Excel sí trae URLs, se validan como siempre.
    const headerImportResolution =
      needsHeaderImage && !excelHasHeaderUrls && templateDefaultUrl
        ? ({ ok: true, url: templateDefaultUrl } as const)
        : evaluateHeaderImageOnImport({
            needsHeader: needsHeaderImage,
            headerCol: headerImageCol,
            valuesPerValidRow: headerUrlPerValid,
            validCount: valid,
          });
    const sendConfigMerged = applyHeaderImageSendConfigUpdate(
      (camp as { send_config_json?: unknown }).send_config_json,
      headerImportResolution
    );

    await sb
      .from("chat_campaigns")
      .update({
        import_original_filename: filename,
        total_count: parsed.rows.length,
        valid_count: valid,
        invalid_count: invalid,
        pending_count: valid,
        status: "draft",
        send_config_json: sendConfigMerged,
        updated_at: ts,
      })
      .eq("id", campaignId)
      .eq("empresa_id", auth.empresaId);

    await sb.from("chat_campaign_events").insert({
      empresa_id: auth.empresaId,
      campaign_id: campaignId,
      recipient_id: null,
      event_type: "import_uploaded",
      event_payload_json: { phone_column: phoneCol, rows: parsed.rows.length },
    });

    return NextResponse.json(
      successResponse({
        phone_column: phoneCol,
        rows: parsed.rows.length,
        valid_count: valid,
        invalid_count: invalid,
        headers: parsed.headers,
      })
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Error";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
