import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { requireAnyModuleSlug } from "@/lib/middleware/module-guard";
import {
  bloquearParticipante,
  desbloquearParticipante,
} from "@/lib/sorteos/participante-bloqueo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = { whatsapp?: unknown; accion?: unknown; motivo?: unknown };

/**
 * POST /api/sorteos/participantes/bloqueo
 * body: { whatsapp, accion: "bloquear" | "desbloquear", motivo? }
 * Bloquea o desbloquea a un participante para comprar en sorteos. No borra su historial.
 */
export async function POST(request: NextRequest) {
  try {
    const guard = await requireAnyModuleSlug(request, ["sorteos"]);
    if (!guard.ok) {
      return NextResponse.json(errorResponse(guard.message), { status: guard.status });
    }
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) {
      return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    }

    const body = (await request.json().catch(() => ({}))) as Body;
    const whatsapp = typeof body.whatsapp === "string" ? body.whatsapp.trim() : "";
    const accion = typeof body.accion === "string" ? body.accion.trim() : "";
    const motivo = typeof body.motivo === "string" ? body.motivo.trim() : "";

    if (!whatsapp) {
      return NextResponse.json(errorResponse("Falta el número de WhatsApp."), { status: 400 });
    }
    if (accion !== "bloquear" && accion !== "desbloquear") {
      return NextResponse.json(errorResponse("accion debe ser 'bloquear' o 'desbloquear'."), {
        status: 400,
      });
    }

    const empresaId = ctx.auth.empresa_id;
    const dataSchema = await fetchDataSchemaForEmpresaId(empresaId);
    const bloqueadoPor = (ctx.auth.user?.email ?? "").trim() || (ctx.auth.usuarioCatalogId ?? "").trim();

    const res =
      accion === "bloquear"
        ? await bloquearParticipante({ empresaId, dataSchema, whatsappNumero: whatsapp, motivo, bloqueadoPor })
        : await desbloquearParticipante({ empresaId, dataSchema, whatsappNumero: whatsapp });

    if (!res.ok) {
      const falta = /migración|migracion/i.test(res.error ?? "");
      return NextResponse.json(errorResponse(res.error ?? "No se pudo completar la acción."), {
        status: falta ? 409 : 400,
      });
    }

    return NextResponse.json(successResponse({ whatsapp, accion, bloqueado: accion === "bloquear" }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
