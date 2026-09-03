import { NextRequest, NextResponse } from "next/server";
import { getChatServiceClientForEmpresa } from "@/app/api/chat/_chat-service-client";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import {
  createServiceRoleClientForEmpresa,
  fetchDataSchemaForEmpresaId,
} from "@/lib/supabase/empresa-data-schema";
import { getChatPostgresPool } from "@/lib/supabase/chat-pg-pool";
import { createSorteoManualCashSaleViaDirectPostgres } from "@/lib/sorteos/sorteo-order-manual-pg";
import { buildManualSaleOrderResultFromPg } from "@/lib/sorteos/sorteo-manual-order-result-pg";
import {
  buildOrderResultFromEntradaId,
  flowDataStubFromEntrada,
} from "@/lib/sorteos/sorteo-ticket-admin";
import { maybeGenerateAndSendSorteoTicketDelivery } from "@/lib/sorteos/sorteo-ticket-delivery";
import { requireAnyModuleSlug } from "@/lib/middleware/module-guard";

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s.trim());
}

export type ManualSaleBody = {
  sorteo_id?: string;
  nombre?: string;
  apellido?: string;
  cedula?: string;
  telefono?: string;
  ciudad?: string;
  cantidad_boletos?: number;
  monto_total?: number;
  observacion_interna?: string | null;
  generar_ticket_png?: boolean;
  idempotency_key?: string;
};

/**
 * POST /api/sorteos/manual-sale — venta presencial efectivo (sin WhatsApp ni chat).
 */
export async function POST(request: NextRequest) {
  try {
    /**
     * Antes bastaba con estar logueado en la empresa: cualquier usuario podía registrar una
     * venta por HTTP. Ahora exige el módulo del cupón manual (un admin con `sorteos` pasa por alias).
     */
    const guard = await requireAnyModuleSlug(request, ["cupon_manual"]);
    if (!guard.ok) {
      return NextResponse.json(errorResponse(guard.message), { status: guard.status });
    }

    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) {
      return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    }

    if (!getChatPostgresPool()) {
      return NextResponse.json(
        errorResponse(
          "El servidor no tiene configurada la conexión directa a Postgres (SUPABASE_DB_URL / DIRECT_URL). No se puede registrar la venta manual."
        ),
        { status: 503 }
      );
    }

    const body = (await request.json().catch(() => ({}))) as ManualSaleBody;
    const sorteoId = typeof body.sorteo_id === "string" ? body.sorteo_id.trim() : "";
    const nombre = typeof body.nombre === "string" ? body.nombre.trim() : "";
    const apellido = typeof body.apellido === "string" ? body.apellido.trim() : "";
    const cedula = typeof body.cedula === "string" ? body.cedula.trim() : "";
    const telefono = typeof body.telefono === "string" ? body.telefono.trim() : "";
    const ciudad = typeof body.ciudad === "string" ? body.ciudad.trim() : "";
    const idemRaw = typeof body.idempotency_key === "string" ? body.idempotency_key.trim() : "";
    const observacion =
      typeof body.observacion_interna === "string" ? body.observacion_interna.trim() : "";
    const generarTicket =
      typeof body.generar_ticket_png === "boolean" ? body.generar_ticket_png : true;

    if (!sorteoId || !isUuid(sorteoId)) {
      return NextResponse.json(errorResponse("sorteo_id inválido."), { status: 400 });
    }
    if (!nombre || !apellido) {
      return NextResponse.json(errorResponse("Nombre y apellido son obligatorios."), { status: 400 });
    }
    if (!telefono) {
      return NextResponse.json(errorResponse("Teléfono es obligatorio."), { status: 400 });
    }
    if (!idemRaw || !isUuid(idemRaw)) {
      return NextResponse.json(errorResponse("idempotency_key debe ser un UUID."), { status: 400 });
    }

    const cantidad = Number(body.cantidad_boletos);
    if (!Number.isFinite(cantidad) || cantidad < 1) {
      return NextResponse.json(errorResponse("cantidad_boletos debe ser mayor a 0."), { status: 400 });
    }

    const montoTotal = Number(body.monto_total);
    if (!Number.isFinite(montoTotal) || montoTotal < 0) {
      return NextResponse.json(errorResponse("monto_total debe ser un número mayor o igual a 0."), {
        status: 400,
      });
    }

    const empresaId = ctx.auth.empresa_id;
    const schema = await fetchDataSchemaForEmpresaId(empresaId);

    const created = await createSorteoManualCashSaleViaDirectPostgres({
      schema,
      empresaId,
      sorteoId,
      idempotencyKey: idemRaw,
      nombre,
      apellido,
      cedula,
      telefono,
      ciudad: ciudad || null,
      cantidadBoletos: Math.floor(cantidad),
      montoTotal,
      observacionInterna: observacion.length > 0 ? observacion : null,
      validadoPorUserId: ctx.auth.usuarioCatalogId ?? null,
    });

    if (!created.ok) {
      return NextResponse.json(errorResponse(created.message), { status: 400 });
    }

    const entradaId = created.entradaId;

    let ticket:
      | {
          attempted: boolean;
          delivery_ok?: boolean;
          skipped?: boolean;
          reason?: string;
          delivery_id?: string;
          last_status?: string;
        }
      | undefined;

    if (generarTicket) {
      const sbFlow = await getChatServiceClientForEmpresa(empresaId);
      const sb = await createServiceRoleClientForEmpresa(empresaId);
      const orderResult =
        (await buildOrderResultFromEntradaId(sb, entradaId, empresaId)) ??
        (await buildManualSaleOrderResultFromPg(schema, empresaId, entradaId));
      /** Shim PG: mismo origen que el ticket; PostgREST del tenant a veces no lee `sorteo_entradas`. */
      const fd = await flowDataStubFromEntrada(sbFlow, entradaId);
      /** Venta manual no tiene chat_flow_data: inyectamos la ciudad para que salga en la imagen del ticket. */
      if (ciudad) fd.ciudad = ciudad;

      if (orderResult) {
        const r = await maybeGenerateAndSendSorteoTicketDelivery({
          supabase: sbFlow,
          empresaId,
          sorteoId: orderResult.sorteoId,
          entradaId,
          conversationId: null,
          flowSessionId: null,
          contactId: "",
          channelId: "",
          orderResult,
          flowData: fd,
          trigger: "confirmacion_final",
          skipWhatsApp: true,
        });

        ticket = {
          attempted: true,
          delivery_ok: r.ok,
          skipped: r.skipped,
          reason: r.reason,
          delivery_id: r.deliveryId,
          last_status: r.lastStatus,
        };
      } else {
        ticket = {
          attempted: true,
          delivery_ok: false,
          reason: "order_snapshot_failed_postgrest_and_pg",
        };
      }
    } else {
      ticket = { attempted: false };
    }

    return NextResponse.json(
      successResponse({
        entrada_id: entradaId,
        numero_orden: created.numeroOrden,
        idempotent: created.idempotent,
        cupones: created.cupones,
        estado_pago: created.estadoPago,
        monto_total: created.montoTotal,
        ticket,
      })
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
