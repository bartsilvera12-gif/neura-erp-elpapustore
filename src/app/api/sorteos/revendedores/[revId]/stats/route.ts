import { NextRequest, NextResponse } from "next/server";
import { getChatServiceClientForEmpresa } from "@/app/api/chat/_chat-service-client";
import { successResponse, errorResponse } from "@/lib/api/response";
import { requireRevendedoresAdmin } from "@/lib/sorteos/revendedores-admin-guard";

export type RevendedorStatsPayload = {
  clicks: number;
  clicks_redeemed: number;
  sesiones_atribuidas: number;
  ordenes: number;
  monto_total: number;
  cupones: number;
};

/**
 * GET /api/sorteos/revendedores/:revId/stats — métricas de referidos (PG shim).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ revId: string }> }
) {
  try {
    const guard = await requireRevendedoresAdmin(request);
    if (!guard.ok) {
      return NextResponse.json(errorResponse(guard.message), { status: guard.status });
    }
    const empresaId = guard.empresaId;
    const { revId } = await params;
    const revendedorId = revId.trim();
    if (!revendedorId) {
      return NextResponse.json(errorResponse("Revendedor inválido."), { status: 400 });
    }

    const sb = await getChatServiceClientForEmpresa(empresaId);

    const { count: clicks, error: e1 } = await sb
      .from("sorteo_revendedor_clicks")
      .select("id", { count: "exact", head: true })
      .eq("revendedor_id", revendedorId)
      .eq("empresa_id", empresaId);
    if (e1) {
      return NextResponse.json(errorResponse(e1.message), { status: 400 });
    }

    const { count: clicksRedeemed, error: e2 } = await sb
      .from("sorteo_revendedor_clicks")
      .select("id", { count: "exact", head: true })
      .eq("revendedor_id", revendedorId)
      .eq("empresa_id", empresaId)
      .not("redeemed_at", "is", null);
    if (e2) {
      return NextResponse.json(errorResponse(e2.message), { status: 400 });
    }

    const { count: sesiones, error: e3 } = await sb
      .from("chat_flow_sessions")
      .select("id", { count: "exact", head: true })
      .eq("revendedor_id", revendedorId)
      .eq("empresa_id", empresaId);
    if (e3) {
      return NextResponse.json(errorResponse(e3.message), { status: 400 });
    }

    // Órdenes: count exacto (antes se traían las filas y se hacía .length, que PostgREST topa en
    // 1000 → un revendedor con >1000 entradas quedaba clavado en 1000 y no se le contaban las ventas).
    const { count: ordenesCount, error: e4 } = await sb
      .from("sorteo_entradas")
      .select("id", { count: "exact", head: true })
      .eq("revendedor_id", revendedorId)
      .eq("empresa_id", empresaId);
    if (e4) {
      return NextResponse.json(errorResponse(e4.message), { status: 400 });
    }
    const ordenes = ordenesCount ?? 0;

    // Monto y cupones: SUM sobre TODAS las filas. No se puede con count → paginamos con .range()
    // en lotes de 1000 hasta agotar, para no quedar topados (mismo bug que arriba pero en la suma).
    let monto_total = 0;
    let cupones = 0;
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const { data: pageRows, error: ePage } = await sb
        .from("sorteo_entradas")
        .select("monto_total, cantidad_boletos")
        .eq("revendedor_id", revendedorId)
        .eq("empresa_id", empresaId)
        .order("id", { ascending: true })
        .range(from, from + PAGE - 1);
      if (ePage) {
        return NextResponse.json(errorResponse(ePage.message), { status: 400 });
      }
      const rows = pageRows ?? [];
      for (const r of rows) {
        const row = r as { monto_total?: unknown; cantidad_boletos?: unknown };
        const m = Number(row.monto_total);
        if (Number.isFinite(m)) monto_total += m;
        const c = Number(row.cantidad_boletos);
        if (Number.isFinite(c) && c > 0) cupones += Math.trunc(c);
      }
      if (rows.length < PAGE) break;
    }

    const payload: RevendedorStatsPayload = {
      clicks: clicks ?? 0,
      clicks_redeemed: clicksRedeemed ?? 0,
      sesiones_atribuidas: sesiones ?? 0,
      ordenes,
      monto_total,
      cupones,
    };

    return NextResponse.json(successResponse(payload));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
