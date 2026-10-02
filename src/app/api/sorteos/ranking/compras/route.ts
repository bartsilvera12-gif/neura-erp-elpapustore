import { NextRequest, NextResponse } from "next/server";
import { successResponse, errorResponse } from "@/lib/api/response";
import { requireAnyModuleSlug } from "@/lib/middleware/module-guard";
import { fetchSorteoComprasByWhatsappServer } from "@/lib/sorteos/server-queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/sorteos/ranking/compras?whatsapp=...&sorteo_id=...
 * Compras de un comprador (por WhatsApp) con su comprobante, para auditar desde el Ranking.
 */
export async function GET(request: NextRequest) {
  try {
    const guard = await requireAnyModuleSlug(request, ["sorteos"]);
    if (!guard.ok) {
      return NextResponse.json(errorResponse(guard.message), { status: guard.status });
    }

    const url = new URL(request.url);
    const whatsapp = url.searchParams.get("whatsapp")?.trim() || "";
    const sorteoId = url.searchParams.get("sorteo_id")?.trim() || null;
    if (!whatsapp) {
      return NextResponse.json(errorResponse("Falta el parámetro whatsapp."), { status: 400 });
    }

    const res = await fetchSorteoComprasByWhatsappServer(whatsapp, sorteoId);
    if (res.error) {
      return NextResponse.json(errorResponse(res.error), {
        status: res.transient_error ? 503 : 400,
      });
    }
    return NextResponse.json(successResponse(res.data));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
