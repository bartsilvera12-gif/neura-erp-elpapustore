import { NextRequest, NextResponse } from "next/server";
import { getChatPostgresPool, quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";
import { getSingleClientSchemaOrNull, isSingleClientMode } from "@/lib/instance/single-client";
import { assertAllowedChatDataSchema } from "@/lib/supabase/chat-data-schema";
import { getAuthWithRol, isAdmin } from "@/lib/middleware/auth";
import { cerrarSorteosVencidos } from "@/lib/sorteos/sorteo-cierre-ventas";

export const dynamic = "force-dynamic";

/**
 * /api/cron/sorteos-cierre — pasa a `cerrado` los sorteos activos cuya `fecha_sorteo` ya llegó.
 * Lo llama `scripts/cron-dispatch.mjs` cada minuto con `Authorization: Bearer CRON_SECRET`.
 * `?dryRun=1` (admin logueado o cron): solo lista cuáles se cerrarían, sin tocar nada.
 */
async function handle(request: NextRequest) {
  const url = new URL(request.url);
  const dryRun = ["1", "true"].includes((url.searchParams.get("dryRun") ?? "").trim().toLowerCase());

  const secret = (process.env.CRON_SECRET ?? "").trim();
  const bearer = (request.headers.get("authorization") ?? "").trim();
  const esCron = Boolean(secret) && bearer === `Bearer ${secret}`;
  if (!esCron) {
    if (!dryRun) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    const auth = await getAuthWithRol(request);
    if (!auth?.empresa_id || !isAdmin(auth)) {
      return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }
  }

  if (!isSingleClientMode()) {
    return NextResponse.json({ ok: false, error: "cron_disabled_in_multi_tenant" }, { status: 400 });
  }
  const raw = getSingleClientSchemaOrNull();
  if (!raw) return NextResponse.json({ ok: false, error: "single_client_schema_missing" }, { status: 500 });
  const schema = assertAllowedChatDataSchema(raw);
  const pool = getChatPostgresPool();
  if (!pool) return NextResponse.json({ ok: false, error: "pool_unavailable" }, { status: 503 });

  const empQ = await pool.query<{ id: string }>(`SELECT id::text AS id FROM "${schema}".empresas LIMIT 1`);
  const empresaId = empQ.rows[0]?.id;
  if (!empresaId) return NextResponse.json({ ok: false, error: "empresa_not_found" }, { status: 404 });

  if (dryRun) {
    const r = await pool.query(
      `SELECT id::text, nombre, estado, fecha_sorteo::text,
              (fecha_sorteo IS NOT NULL AND fecha_sorteo <= now()) AS vencido
         FROM ${quoteSchemaTable(schema, "sorteos")}
        WHERE empresa_id = $1::uuid AND estado = 'activo'
        ORDER BY fecha_sorteo NULLS LAST`,
      [empresaId]
    );
    return NextResponse.json({ ok: true, dryRun: true, activos: r.rows });
  }

  const cerrados = await cerrarSorteosVencidos(pool, schema, empresaId);
  if (cerrados.length > 0) console.info("[cron-sorteos-cierre] cerrados", cerrados);
  return NextResponse.json({ ok: true, cerrados });
}

export async function GET(request: NextRequest) {
  try {
    return await handle(request);
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "error" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  return GET(request);
}
