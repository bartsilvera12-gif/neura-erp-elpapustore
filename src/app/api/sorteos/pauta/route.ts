import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { getChatPostgresPool } from "@/lib/supabase/chat-pg-pool";
import { getSingleClientSchemaOrNull } from "@/lib/instance/single-client";
import {
  cargarPautaAtribucion,
  sorteoActivoMasReciente,
} from "@/lib/sorteos/pauta-atribucion-pg";

export const dynamic = "force-dynamic";

/**
 * GET /api/sorteos/pauta
 *
 * Atribución de ventas a pauta del sorteo activo (anuncios Click-to-WhatsApp de Meta). Solo
 * lectura: cruza el `referral` guardado en los mensajes entrantes con las compras confirmadas.
 * Sin sorteo activo devuelve 200 con `sorteo: null`; no es un error.
 */
export async function GET(request: NextRequest) {
  try {
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });

    const pool = getChatPostgresPool();
    const schema = getSingleClientSchemaOrNull();
    if (!pool || !schema) {
      return NextResponse.json(errorResponse("Servidor sin conexión directa a Postgres."), {
        status: 503,
      });
    }

    const empresaId = ctx.auth.empresa_id;
    const sorteo = await sorteoActivoMasReciente(pool, schema, empresaId);
    if (!sorteo) {
      return NextResponse.json(
        successResponse({ sorteo: null, resumen: null, porAnuncio: [], porDia: [], compradores: [] })
      );
    }

    const data = await cargarPautaAtribucion(pool, schema, empresaId, sorteo.id);
    return NextResponse.json(successResponse({ sorteo, ...data }));
  } catch (e) {
    console.error("[api/sorteos/pauta]", e instanceof Error ? e.message : e);
    return NextResponse.json(errorResponse("No se pudo cargar la atribución de pauta."), {
      status: 500,
    });
  }
}
