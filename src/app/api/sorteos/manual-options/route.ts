import { NextRequest, NextResponse } from "next/server";
import { getChatServiceClientForEmpresa } from "@/app/api/chat/_chat-service-client";
import { successResponse, errorResponse } from "@/lib/api/response";
import { requireAnyModuleSlug } from "@/lib/middleware/module-guard";

export const dynamic = "force-dynamic";

/**
 * GET /api/sorteos/manual-options — sorteos elegibles para cargar un cupón manual.
 *
 * Existe para que la pantalla de Cupón manual NO tenga que llamar a `GET /api/sorteos`, que
 * devuelve la fila entera (`select("*")`) con `total_boletos_vendidos`, `max_boletos` y
 * `ultimo_numero_cupon`. Un operador acotado al cupón manual no debe conocer el volumen de
 * ventas, y ocultarlo en la UI no alcanza: viajaba igual por la red.
 *
 * Devuelve solo `id` y `nombre`, y solo de sorteos **activos** — que son los únicos que la
 * transacción de venta manual acepta (`createSorteoManualCashSaleViaDirectPostgres` hace
 * ROLLBACK con "El sorteo no está activo"). Antes el formulario caía a listar todos cuando no
 * había ninguno activo, así que dejaba elegir un sorteo finalizado y fallaba recién al guardar.
 */
export async function GET(request: NextRequest) {
  try {
    const guard = await requireAnyModuleSlug(request, ["cupon_manual"]);
    if (!guard.ok) {
      return NextResponse.json(errorResponse(guard.message), { status: guard.status });
    }

    const sb = await getChatServiceClientForEmpresa(guard.empresaId);
    const { data, error } = await sb
      .from("sorteos")
      .select("id, nombre")
      .eq("empresa_id", guard.empresaId)
      .eq("estado", "activo")
      .order("created_at", { ascending: false });

    if (error) {
      return NextResponse.json(errorResponse(error.message), { status: 400 });
    }

    const rows = ((data ?? []) as Array<{ id?: unknown; nombre?: unknown }>).map((r) => ({
      id: String(r.id ?? ""),
      nombre: String(r.nombre ?? ""),
    }));

    return NextResponse.json(successResponse(rows.filter((r) => r.id.length > 0)));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Error";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
