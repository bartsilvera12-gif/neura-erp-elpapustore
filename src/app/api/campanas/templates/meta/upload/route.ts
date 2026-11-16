import { NextRequest, NextResponse } from "next/server";
import { getChatServiceClientForEmpresa } from "@/app/api/chat/_chat-service-client";
import { successResponse, errorResponse } from "@/lib/api/response";
import { requireCampanasApiAccess } from "@/lib/campaigns/campaign-auth";
import type { SupabaseAdmin } from "@/lib/chat/types";
import {
  getMetaChannelCreds,
  HEADER_FILE_RULES,
  uploadMetaHeaderSample,
} from "@/lib/campaigns/meta-template-management";
import { saveTmpTemplateHeaderFile } from "@/lib/campaigns/template-header-default";

export const maxDuration = 60;

/** Sube el archivo de muestra del encabezado directo a Meta y devuelve el handle para crear la plantilla. */
export async function POST(request: NextRequest) {
  const auth = await requireCampanasApiAccess(request);
  if (!auth.ok) return NextResponse.json(errorResponse(auth.message), { status: auth.status });

  try {
    const form = await request.formData();
    const channelId = String(form.get("channel_id") ?? "").trim();
    const kind = String(form.get("kind") ?? "").trim() as keyof typeof HEADER_FILE_RULES;
    const file = form.get("file");
    if (!channelId) return NextResponse.json(errorResponse("channel_id es obligatorio"), { status: 400 });
    const rule = HEADER_FILE_RULES[kind];
    if (!rule) return NextResponse.json(errorResponse("Tipo de encabezado inválido"), { status: 400 });
    if (!(file instanceof File)) return NextResponse.json(errorResponse("Falta el archivo"), { status: 400 });

    const mime = (file.type || "").toLowerCase();
    if (!rule.mimes.test(mime)) {
      return NextResponse.json(errorResponse(`Formato no válido: tiene que ser ${rule.label}.`), { status: 400 });
    }
    if (file.size > rule.maxBytes) {
      return NextResponse.json(
        errorResponse(`El archivo pesa ${(file.size / 1024 / 1024).toFixed(1)} MB; el máximo es ${rule.label}.`),
        { status: 400 }
      );
    }

    const sb = await getChatServiceClientForEmpresa(auth.empresaId);
    const c = await getMetaChannelCreds({ supabase: sb as unknown as SupabaseAdmin, empresaId: auth.empresaId, channelId });
    if (!c.ok) return NextResponse.json(errorResponse(c.error), { status: 400 });

    const bytes = new Uint8Array(await file.arrayBuffer());
    const handle = await uploadMetaHeaderSample(c.creds, bytes, mime);
    // Copia en el storage del ERP: al crear la plantilla queda como archivo por defecto de sus campañas.
    const storagePath = await saveTmpTemplateHeaderFile({ empresaId: auth.empresaId, bytes, mime });
    return NextResponse.json(successResponse({ handle, storage_path: storagePath }));
  } catch (e) {
    return NextResponse.json(errorResponse(e instanceof Error ? e.message : "Error"), { status: 502 });
  }
}
