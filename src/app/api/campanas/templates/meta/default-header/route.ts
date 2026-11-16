import { NextRequest, NextResponse } from "next/server";
import { successResponse, errorResponse } from "@/lib/api/response";
import { requireCampanasApiAccess } from "@/lib/campaigns/campaign-auth";
import { HEADER_FILE_RULES } from "@/lib/campaigns/meta-template-management";
import { promoteTemplateHeaderFile, saveTmpTemplateHeaderFile } from "@/lib/campaigns/template-header-default";

export const maxDuration = 60;

/**
 * Sube o reemplaza el archivo por defecto (foto/video/PDF) que usan las campañas de una plantilla ya existente.
 * Solo guarda en el storage del ERP; no toca la plantilla en Meta.
 */
export async function POST(request: NextRequest) {
  const auth = await requireCampanasApiAccess(request);
  if (!auth.ok) return NextResponse.json(errorResponse(auth.message), { status: auth.status });

  try {
    const form = await request.formData();
    const channelId = String(form.get("channel_id") ?? "").trim();
    const name = String(form.get("name") ?? "").trim();
    const language = String(form.get("language") ?? "").trim();
    const kind = String(form.get("kind") ?? "").trim().toLowerCase() as keyof typeof HEADER_FILE_RULES;
    const file = form.get("file");
    if (!channelId || !name || !language) {
      return NextResponse.json(errorResponse("Faltan canal, nombre o idioma de la plantilla"), { status: 400 });
    }
    const rule = HEADER_FILE_RULES[kind];
    if (!rule) return NextResponse.json(errorResponse("Esta plantilla no tiene encabezado con archivo"), { status: 400 });
    if (!(file instanceof File)) return NextResponse.json(errorResponse("Falta el archivo"), { status: 400 });

    const mime = (file.type || "").toLowerCase();
    if (!rule.mimes.test(mime)) {
      return NextResponse.json(errorResponse(`Formato no válido: tiene que ser ${rule.label}.`), { status: 400 });
    }
    if (file.size > rule.maxBytes) {
      return NextResponse.json(errorResponse(`El archivo supera el máximo: ${rule.label}.`), { status: 400 });
    }

    const tmp = await saveTmpTemplateHeaderFile({
      empresaId: auth.empresaId,
      bytes: new Uint8Array(await file.arrayBuffer()),
      mime,
    });
    if (!tmp) return NextResponse.json(errorResponse("No se pudo guardar el archivo"), { status: 500 });

    const url = await promoteTemplateHeaderFile({ empresaId: auth.empresaId, channelId, name, language, tmpPath: tmp });
    if (!url) return NextResponse.json(errorResponse("No se pudo guardar el archivo"), { status: 500 });
    return NextResponse.json(successResponse({ url }));
  } catch (e) {
    return NextResponse.json(errorResponse(e instanceof Error ? e.message : "Error"), { status: 500 });
  }
}
