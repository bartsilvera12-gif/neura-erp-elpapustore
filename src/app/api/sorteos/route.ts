import { NextRequest, NextResponse } from "next/server";
import { getChatServiceClientForEmpresa } from "@/app/api/chat/_chat-service-client";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { getChatPostgresPool } from "@/lib/supabase/chat-pg-pool";
import { isLikelyUnexposedTenantChatSchema } from "@/lib/supabase/chat-data-schema";
import { mergeCouponNumberingFromUnknown } from "@/lib/sorteos/coupon-numbering-api";
import { requireAnyModuleSlug } from "@/lib/middleware/module-guard";

/**
 * GET /api/sorteos — lista sorteos del tenant (Postgres shim si schema no expuesto).
 */
export async function GET(request: NextRequest) {
  try {
    /**
     * Exige el módulo `sorteos`, no solo sesión: la fila completa incluye
     * `total_boletos_vendidos`, `max_boletos` y `ultimo_numero_cupon`. Quien solo tiene
     * `cupon_manual` usa `/api/sorteos/manual-options`, que devuelve id + nombre.
     */
    const guard = await requireAnyModuleSlug(request, ["sorteos"]);
    if (!guard.ok) {
      return NextResponse.json(errorResponse(guard.message), { status: guard.status });
    }
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) {
      return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    }
    const empresaId = ctx.auth.empresa_id;
    const dataSchema = await fetchDataSchemaForEmpresaId(empresaId);
    const pool = getChatPostgresPool();
    const modo =
      pool && isLikelyUnexposedTenantChatSchema(dataSchema) ? "postgres_shim" : "postgrest_schema";

    console.info("[sorteos][list]", {
      empresa_id: empresaId,
      data_schema: dataSchema,
      modo,
    });

    const sb = await getChatServiceClientForEmpresa(empresaId);
    const { data, error } = await sb
      .from("sorteos")
      .select("*")
      .eq("empresa_id", empresaId)
      .order("created_at", { ascending: false });

    if (error) {
      return NextResponse.json(errorResponse(error.message), { status: 400 });
    }
    return NextResponse.json(successResponse(data ?? []));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}

export type SorteoCreateBody = {
  nombre?: string;
  descripcion?: string | null;
  precio_por_boleto?: number;
  max_boletos?: number;
  fecha_sorteo?: string | null;
  estado?: string;
  datos_bancarios?: Record<string, unknown>;
  imagen_url?: string | null;
  ticket_delivery_mode?: string;
  ticket_image_config?: Record<string, unknown>;
  coupon_numbering_enabled?: boolean;
  coupon_number_start?: number | null;
  coupon_number_mode?: string | null;
  coupon_number_limit?: number | null;
};

/**
 * POST /api/sorteos
 */
export async function POST(request: NextRequest) {
  try {
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) {
      return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    }
    const empresaId = ctx.auth.empresa_id;
    const dataSchema = await fetchDataSchemaForEmpresaId(empresaId);
    const pool = getChatPostgresPool();
    const modo =
      pool && isLikelyUnexposedTenantChatSchema(dataSchema) ? "postgres_shim" : "postgrest_schema";

    const body = (await request.json().catch(() => ({}))) as SorteoCreateBody;
    const nombre = typeof body.nombre === "string" ? body.nombre.trim() : "";
    if (!nombre) {
      return NextResponse.json(errorResponse("nombre es obligatorio"), { status: 400 });
    }

    const sb = await getChatServiceClientForEmpresa(empresaId);
    const numbering = mergeCouponNumberingFromUnknown(body as Record<string, unknown>);
    if ("error" in numbering) {
      return NextResponse.json(errorResponse(numbering.error), { status: 400 });
    }

    const row = {
      empresa_id: empresaId,
      nombre,
      descripcion: body.descripcion?.trim() || null,
      precio_por_boleto: Number(body.precio_por_boleto) || 0,
      max_boletos: Number(body.max_boletos) || 0,
      fecha_sorteo: body.fecha_sorteo || null,
      estado: (body.estado as string)?.trim() || "activo",
      datos_bancarios: body.datos_bancarios && typeof body.datos_bancarios === "object" ? body.datos_bancarios : {},
      imagen_url: body.imagen_url?.trim() || null,
      ticket_delivery_mode:
        typeof body.ticket_delivery_mode === "string" &&
        ["text_only", "text_and_image", "image_only"].includes(body.ticket_delivery_mode.trim())
          ? body.ticket_delivery_mode.trim()
          : "text_only",
      ticket_image_config:
        body.ticket_image_config && typeof body.ticket_image_config === "object"
          ? body.ticket_image_config
          : {},
      ...numbering,
    };

    const { data, error } = await sb.from("sorteos").insert(row).select("*").single();
    if (error) {
      return NextResponse.json(errorResponse(error.message), { status: 400 });
    }

    console.info("[sorteos][create]", {
      empresa_id: empresaId,
      data_schema: dataSchema,
      modo,
      sorteo_id: (data as { id?: string })?.id,
    });

    return NextResponse.json(successResponse(data));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
