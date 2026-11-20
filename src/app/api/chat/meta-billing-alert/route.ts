import { NextRequest, NextResponse } from "next/server";
import { getChatServiceClientForEmpresa } from "@/app/api/chat/_chat-service-client";
import { getTenantSupabaseFromAuthWithRol } from "@/lib/supabase/tenant-api";
import { esRolAdminEmpresaOGlobal } from "@/lib/auth/rol-empresa";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";

export const dynamic = "force-dynamic";

/**
 * Código de Meta para "Business eligibility payment issue": la cuenta no puede enviar por un
 * problema de facturación. Medido en producción: 5.452 mensajes fallidos con este código entre
 * el 7-oct y el 3-nov-2026 sin que nadie se enterara en el momento.
 */
const META_BILLING_ERROR_CODE = "131042";

/** Ventana de observación. Mientras el bloqueo dura, los fallos se renuevan solos. */
const WINDOW_HOURS = 24;

/** Tope de filas leídas: para el cartel alcanza con saber que pasa y desde cuándo. */
const MAX_ROWS = 50;

/**
 * GET /api/chat/meta-billing-alert
 *
 * Avisa si WhatsApp dejó de enviar por un problema de pago en Meta.
 *
 * Por qué el aviso vive acá y no se manda por WhatsApp: si Meta cortó la cuenta, ese canal
 * tampoco funciona. Justo cuando hace falta el aviso, no saldría.
 *
 * Solo administradores: el operador acotado al cupón manual no necesita esto en pantalla.
 *
 * Costo: filtra por `empresa_id` + rango de `created_at` (cubierto por
 * `idx_chat_messages_empresa_created_at`) y acota a 50 filas. No recorre la tabla entera.
 */
export async function GET(request: NextRequest) {
  try {
    const ctx = await getTenantSupabaseFromAuthWithRol(request);
    if (!ctx?.auth?.empresa_id) {
      return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    }

    /** Silencioso, no 403: el cartel simplemente no aparece para quien no es admin. */
    if (!esRolAdminEmpresaOGlobal(ctx.auth.rol)) {
      return NextResponse.json(successResponse({ activo: false }));
    }

    const empresaId = ctx.auth.empresa_id;

    /**
     * `?horas=` solo para verificar: permite mirar hacia atrás y comprobar que la cadena entera
     * funciona usando fallos reales ya ocurridos, sin esperar a que se corte el pago de nuevo.
     * Acotado a 2000 h (~83 días) para que no se convierta en una consulta cara por accidente.
     */
    const horasParam = Number(request.nextUrl.searchParams.get("horas"));
    const horas =
      Number.isFinite(horasParam) && horasParam > 0 ? Math.min(horasParam, 2000) : WINDOW_HOURS;

    const desdeIso = new Date(Date.now() - horas * 60 * 60 * 1000).toISOString();

    const sb = await getChatServiceClientForEmpresa(empresaId);
    const { data, error } = await sb
      .from("chat_messages")
      .select("created_at")
      .eq("empresa_id", empresaId)
      .eq("from_me", true)
      .gte("created_at", desdeIso)
      .eq("raw_payload->neura_meta_status->>error_code", META_BILLING_ERROR_CODE)
      .order("created_at", { ascending: false })
      .limit(MAX_ROWS);

    if (error) {
      /** Falla suave: el cartel no debe romper el ERP si la consulta no responde. */
      console.warn("[meta-billing-alert]", error.message);
      return NextResponse.json(successResponse({ activo: false }));
    }

    const filas = (data ?? []) as Array<{ created_at?: string }>;
    if (filas.length === 0) {
      return NextResponse.json(successResponse({ activo: false }));
    }

    const fechas = filas
      .map((r) => String(r.created_at ?? ""))
      .filter((s) => s.length > 0)
      .sort();

    return NextResponse.json(
      successResponse({
        activo: true,
        codigo: META_BILLING_ERROR_CODE,
        /** `truncado` avisa que hubo al menos este número, no exactamente este. */
        mensajes: filas.length,
        truncado: filas.length >= MAX_ROWS,
        primero: fechas[0] ?? null,
        ultimo: fechas[fechas.length - 1] ?? null,
        ventana_horas: horas,
      })
    );
  } catch (e) {
    console.warn("[meta-billing-alert]", e instanceof Error ? e.message : e);
    return NextResponse.json(successResponse({ activo: false }));
  }
}
