import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import {
  getChatPostgresPool,
  isPgPoolExhaustionMessage,
  logPgPoolStats,
  quoteSchemaTable,
} from "@/lib/supabase/chat-pg-pool";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { invalidateSorteosListCachesForEmpresa } from "@/lib/sorteos/server-queries";

const LOG = "[sorteos-cupones][anular-venta]";

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s.trim());
}

function sanitizeErr(msg: string): string {
  return msg.replace(/\b(password|token|secret|key)\s*=[^\s]+/gi, "[redacted]").slice(0, 280);
}

type Body = { motivo?: unknown };

type AnularRow = {
  id: string;
  numero_orden: number | null;
  cantidad_boletos: number;
  cupones_anulados: number;
  boletos_vendidos_despues: number | null;
};

/**
 * POST /api/sorteos/cupones/[entradaId]/anular
 *
 * Anula la venta: la orden pasa a `anulado`, sus cupones quedan marcados y el sorteo recupera
 * el cupo (`total_boletos_vendidos` baja). `ultimo_numero_cupon` NO se toca: los números
 * anulados quedan quemados y no se reasignan, porque el comprador ya tiene esa boleta.
 *
 * Todo en UNA sentencia con CTEs: o pasan los tres efectos o no pasa ninguno. Si se hicieran
 * tres UPDATE sueltos, un fallo en el medio dejaría la venta anulada con el cupo sin liberar.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ entradaId: string }> }
) {
  let empresaIdForLog = "";
  let schemaForLog = "";
  let entradaIdForLog = "";

  try {
    const authCtx = await getTenantSupabaseFromAuth(request);
    if (!authCtx) {
      return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    }

    const { entradaId: rawId } = await params;
    const entradaId = typeof rawId === "string" ? rawId.trim() : "";
    entradaIdForLog = entradaId;
    if (!entradaId || !isUuid(entradaId)) {
      return NextResponse.json(errorResponse("entradaId inválido."), { status: 400 });
    }

    const body = (await request.json().catch(() => ({}))) as Body;
    const motivo = typeof body.motivo === "string" ? body.motivo.trim().slice(0, 500) : "";

    const empresaId = authCtx.auth.empresa_id;
    empresaIdForLog = empresaId;
    const dataSchema = await fetchDataSchemaForEmpresaId(empresaId);
    schemaForLog = dataSchema;

    const pool = getChatPostgresPool();
    if (!pool) {
      console.error(LOG, {
        stage: "error",
        empresa_id: empresaId,
        schema: dataSchema,
        entrada_id: entradaId,
        error: "sin_pool_pg",
      });
      return NextResponse.json(
        errorResponse(
          "Anular una venta toca la orden, sus cupones y el cupo del sorteo en una sola transacción, y eso requiere conexión directa a Postgres (SUPABASE_DB_URL / DIRECT_URL) en el servidor."
        ),
        { status: 503 }
      );
    }

    const tEnt = quoteSchemaTable(dataSchema, "sorteo_entradas");
    const tCup = quoteSchemaTable(dataSchema, "sorteo_cupones");
    const tSort = quoteSchemaTable(dataSchema, "sorteos");
    const anuladaAt = new Date().toISOString();
    /** Auditoría: email del operador, o el id del usuario del catálogo si no hay email. */
    const anuladaPor =
      (authCtx.auth.user?.email ?? "").trim() || (authCtx.auth.usuarioCatalogId ?? "").trim();

    let row: AnularRow | null = null;
    try {
      const r = await pool.query<AnularRow>(
        `WITH ent AS (
           UPDATE ${tEnt}
              SET estado_pago = 'anulado',
                  anulada_at = $2::timestamptz,
                  anulada_por = NULLIF($3::text, ''),
                  anulacion_motivo = NULLIF($4::text, ''),
                  updated_at = $2::timestamptz
            WHERE id = $1::uuid
              AND empresa_id = $5::uuid
              AND estado_pago <> 'anulado'
           RETURNING id, sorteo_id, numero_orden, cantidad_boletos
         ), cup AS (
           UPDATE ${tCup} c
              SET anulado_at = $2::timestamptz
             FROM ent
            WHERE c.entrada_id = ent.id
              AND c.anulado_at IS NULL
           RETURNING c.id
         ), sor AS (
           UPDATE ${tSort} s
              SET total_boletos_vendidos = GREATEST(s.total_boletos_vendidos - ent.cantidad_boletos, 0),
                  updated_at = $2::timestamptz
             FROM ent
            WHERE s.id = ent.sorteo_id
              AND s.empresa_id = $5::uuid
           RETURNING s.total_boletos_vendidos
         )
         SELECT ent.id,
                ent.numero_orden,
                ent.cantidad_boletos,
                (SELECT count(*) FROM cup)::int AS cupones_anulados,
                (SELECT total_boletos_vendidos FROM sor) AS boletos_vendidos_despues
           FROM ent`,
        [entradaId, anuladaAt, anuladaPor, motivo, empresaId]
      );
      row = r.rows?.[0] ?? null;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const poolErr = isPgPoolExhaustionMessage(msg);
      if (poolErr) {
        logPgPoolStats("cupones_anular_venta", pool, { empresa_id: empresaId, schema: dataSchema });
      }
      console.error(LOG, {
        stage: "error",
        empresa_id: empresaId,
        schema: dataSchema,
        entrada_id: entradaId,
        error: sanitizeErr(msg),
      });
      /** La columna/estado nuevos vienen de 20260921140000: sin esa migración, esto falla. */
      const faltaMigracion =
        /anulada_at|anulado_at|anulacion_motivo|estado_pago_check/i.test(msg);
      return NextResponse.json(
        errorResponse(
          poolErr
            ? "Base de datos saturada momentáneamente; reintentá en unos segundos."
            : faltaMigracion
              ? "Falta aplicar la migración 20260921140000_sorteo_venta_anulacion en este schema."
              : sanitizeErr(msg) || "Error al anular la venta."
        ),
        { status: poolErr ? 503 : faltaMigracion ? 409 : 500 }
      );
    }

    if (!row) {
      const r2 = await pool.query<{ estado_pago: string | null }>(
        `SELECT estado_pago FROM ${tEnt} WHERE id = $1::uuid AND empresa_id = $2::uuid`,
        [entradaId, empresaId]
      );
      const cur = r2.rows?.[0];
      if (!cur) {
        return NextResponse.json(errorResponse("Entrada no encontrada."), { status: 404 });
      }
      return NextResponse.json(errorResponse("Esta venta ya estaba anulada."), { status: 409 });
    }

    console.info(LOG, {
      stage: "after_update",
      empresa_id: empresaId,
      schema: dataSchema,
      entrada_id: entradaId,
      numero_orden: row.numero_orden,
      cupones_anulados: row.cupones_anulados,
      boletos_liberados: row.cantidad_boletos,
      con_motivo: Boolean(motivo),
      resultado: "ok",
    });

    invalidateSorteosListCachesForEmpresa(empresaId, dataSchema);

    return NextResponse.json(
      successResponse({
        entrada_id: row.id,
        numero_orden: row.numero_orden,
        estado_pago: "anulado" as const,
        cupones_anulados: row.cupones_anulados,
        boletos_liberados: row.cantidad_boletos,
        boletos_vendidos_despues: row.boletos_vendidos_despues,
      })
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(LOG, {
      stage: "error",
      empresa_id: empresaIdForLog || undefined,
      schema: schemaForLog || undefined,
      entrada_id: entradaIdForLog || undefined,
      error: sanitizeErr(msg),
    });
    return NextResponse.json(errorResponse(sanitizeErr(msg) || "Error interno."), { status: 503 });
  }
}
