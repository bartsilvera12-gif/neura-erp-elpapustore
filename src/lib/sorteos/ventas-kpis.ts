"use server";

import { getUserAndEmpresa } from "@/lib/middleware/auth";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { getChatServiceClientForEmpresa } from "@/lib/supabase/chat-service-role-empresa";
import { asuncionDayBoundsUtc } from "@/lib/sorteos/kpis-time-bounds";
import type { Pool } from "pg";
import { getChatPostgresPool, quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";
import { assertAllowedChatDataSchema } from "@/lib/supabase/chat-data-schema";

/**
 * KPIs de ventas de sorteos (página principal, solo lectura).
 *
 * Columnas (ver `20250326000003_modulo_sorteos.sql` y migraciones posteriores):
 * - `sorteos`: id, empresa_id, nombre, estado, created_at
 * - `sorteo_entradas`: empresa_id, sorteo_id, cantidad_boletos, monto_total, estado_pago, created_at
 * - `sorteo_cupones`: entrada_id, empresa_id, sorteo_id (1 fila por número de cupón)
 *
 * Dos ventanas:
 * - HOY: entradas creadas hoy (calendario America/Asuncion), toda la empresa.
 * - SORTEO: acumulado del sorteo vigente **desde que inició** (todas sus entradas, sin ventana de
 *   fecha), filtrando por `sorteo_id`. "Vigente" = sorteo `activo` más reciente; si no hay activo,
 *   el sorteo más reciente por `created_at`.
 *
 * Boletos: COUNT de `sorteo_cupones` unido a `sorteo_entradas` (un boleto = un cupón).
 * Montos: SUM(monto_total) en `sorteo_entradas`. Excluye `estado_pago` `rechazado` y `anulado`.
 * Calendario del día: America/Asuncion (ver `kpis-time-bounds.ts`).
 */
export type SorteosVentasKpis = {
  boletosHoy: number;
  boletosSorteo: number;
  montoHoy: number;
  montoSorteo: number;
  /** Nombre del sorteo vigente que alimenta las tarjetas "del sorteo" (para el sub-label). */
  sorteoNombre: string | null;
};

const LOG_ERR = "[sorteos][dashboard-summary][error]";
const LOG_DBG = "[sorteos][dashboard-summary][debug]";

function logDashboardError(empresaId: string, schema: string, err: unknown) {
  const message =
    err instanceof Error
      ? err.message.slice(0, 200)
      : String(err).slice(0, 200);
  console.error(LOG_ERR, { empresa_id: empresaId, schema, message });
}

function sumRows(
  rows: Array<{ cantidad_boletos?: number | null; monto_total?: number | string | null; estado_pago?: string | null }>
): { boletos: number; monto: number } {
  let boletos = 0;
  let monto = 0;
  for (const r of rows) {
    const ep = (r.estado_pago ?? "").trim();
    if (ep === "rechazado" || ep === "anulado") continue;
    boletos += Number(r.cantidad_boletos) || 0;
    monto += Number(r.monto_total) || 0;
  }
  return { boletos, monto };
}

type SorteoRef = { id: string; nombre: string };

/**
 * Elige el sorteo "vigente": el `activo` más reciente; si no hay ninguno activo, el más reciente
 * por `created_at`. Espejo en JS de la query pgDirect para el camino PostgREST.
 */
function pickCurrentSorteo(
  rows: Array<{ id?: string | null; nombre?: string | null; estado?: string | null; created_at?: string | null }>
): SorteoRef | null {
  const valid = rows.filter((r): r is { id: string } & typeof r => typeof r.id === "string" && r.id.length > 0);
  if (valid.length === 0) return null;
  const sorted = [...valid].sort((a, b) => {
    const aActive = (a.estado ?? "").trim() === "activo" ? 1 : 0;
    const bActive = (b.estado ?? "").trim() === "activo" ? 1 : 0;
    if (aActive !== bActive) return bActive - aActive; // activo primero
    const at = a.created_at ? Date.parse(a.created_at) : 0;
    const bt = b.created_at ? Date.parse(b.created_at) : 0;
    return bt - at; // más reciente primero
  });
  const top = sorted[0];
  return { id: top.id, nombre: (top.nombre ?? "").trim() };
}

async function logDashboardDebug(
  pool: Pool | null,
  schema: string,
  empresaId: string,
  day: { start: string; end: string },
  current: SorteoRef | null,
  source: "pg" | "postgrest",
  kpis: SorteosVentasKpis
): Promise<void> {
  if (process.env.SORTEOS_KPIS_DEBUG?.trim() !== "1") return;
  let cuponesHoy = 0;
  let cuponesSorteo = 0;
  if (pool) {
    try {
      const sch = assertAllowedChatDataSchema(schema);
      const tent = quoteSchemaTable(sch, "sorteo_entradas");
      const tcup = quoteSchemaTable(sch, "sorteo_cupones");
      const [ch, cs] = await Promise.all([
        pool.query(
          `SELECT COUNT(c.id)::bigint AS n FROM ${tcup} c
           INNER JOIN ${tent} e ON e.id = c.entrada_id
           WHERE e.empresa_id = $1::uuid AND e.created_at >= $2::timestamptz AND e.created_at <= $3::timestamptz
           AND e.estado_pago NOT IN ('rechazado', 'anulado')`,
          [empresaId, day.start, day.end]
        ),
        current
          ? pool.query(
              `SELECT COUNT(c.id)::bigint AS n FROM ${tcup} c
               INNER JOIN ${tent} e ON e.id = c.entrada_id
               WHERE e.empresa_id = $1::uuid AND e.sorteo_id = $2::uuid
               AND e.estado_pago NOT IN ('rechazado', 'anulado')`,
              [empresaId, current.id]
            )
          : Promise.resolve({ rows: [{ n: "0" }] } as { rows: Array<{ n?: string }> }),
      ]);
      cuponesHoy = Number((ch.rows?.[0] as { n?: string } | undefined)?.n) || 0;
      cuponesSorteo = Number((cs.rows?.[0] as { n?: string } | undefined)?.n) || 0;
    } catch {
      /* no ensuciar: el error ya va por LOG_ERR si la query principal falló */
    }
  }
  console.info(LOG_DBG, {
    empresa_id: empresaId,
    schema,
    source,
    day_from: day.start,
    day_to: day.end,
    sorteo_vigente_id: current?.id ?? null,
    sorteo_vigente_nombre: current?.nombre ?? null,
    cupones_hoy_count: cuponesHoy,
    cupones_sorteo_count: cuponesSorteo,
    monto_hoy: kpis.montoHoy,
    monto_sorteo: kpis.montoSorteo,
    boletos_hoy: kpis.boletosHoy,
    boletos_sorteo: kpis.boletosSorteo,
  });
}

type PgKpiRow = { boletos: string | number | null; monto: string | number | null };

/** Boletos + monto de entradas creadas dentro de una ventana de fecha (para HOY). */
async function fetchKpiWindowFromPg(
  pool: Pool,
  schema: string,
  empresaId: string,
  start: string,
  end: string
): Promise<{ boletos: number; monto: number }> {
  const sch = assertAllowedChatDataSchema(schema);
  const tent = quoteSchemaTable(sch, "sorteo_entradas");
  const tcup = quoteSchemaTable(sch, "sorteo_cupones");

  const [bRes, mRes] = await Promise.all([
    pool.query(
      `SELECT COUNT(c.id) AS boletos
       FROM ${tcup} c
       INNER JOIN ${tent} e ON e.id = c.entrada_id
       WHERE e.empresa_id = $1::uuid
         AND e.created_at >= $2::timestamptz AND e.created_at <= $3::timestamptz
         AND e.estado_pago NOT IN ('rechazado', 'anulado')`,
      [empresaId, start, end]
    ),
    pool.query(
      `SELECT COALESCE(SUM(e.monto_total), 0) AS monto
       FROM ${tent} e
       WHERE e.empresa_id = $1::uuid
         AND e.created_at >= $2::timestamptz AND e.created_at <= $3::timestamptz
         AND e.estado_pago NOT IN ('rechazado', 'anulado')`,
      [empresaId, start, end]
    ),
  ]);

  const bRow = bRes.rows?.[0] as PgKpiRow | undefined;
  const mRow = mRes.rows?.[0] as PgKpiRow | undefined;
  const boletos = Number(bRow?.boletos) || 0;
  const monto = Number(mRow?.monto) || 0;
  return { boletos, monto };
}

/** Sorteo vigente (activo más reciente; si no, el más reciente) vía pgDirect. */
async function fetchCurrentSorteoFromPg(
  pool: Pool,
  schema: string,
  empresaId: string
): Promise<SorteoRef | null> {
  const sch = assertAllowedChatDataSchema(schema);
  const tsor = quoteSchemaTable(sch, "sorteos");
  const res = await pool.query(
    `SELECT id, nombre
       FROM ${tsor}
      WHERE empresa_id = $1::uuid
      ORDER BY (estado = 'activo') DESC, created_at DESC
      LIMIT 1`,
    [empresaId]
  );
  const row = res.rows?.[0] as { id?: string; nombre?: string } | undefined;
  if (!row?.id) return null;
  return { id: row.id, nombre: (row.nombre ?? "").trim() };
}

/** Acumulado del sorteo (todas sus entradas, sin ventana de fecha) vía pgDirect. */
async function fetchSorteoLifetimeFromPg(
  pool: Pool,
  schema: string,
  empresaId: string,
  sorteoId: string
): Promise<{ boletos: number; monto: number }> {
  const sch = assertAllowedChatDataSchema(schema);
  const tent = quoteSchemaTable(sch, "sorteo_entradas");
  const tcup = quoteSchemaTable(sch, "sorteo_cupones");

  const [bRes, mRes] = await Promise.all([
    pool.query(
      `SELECT COUNT(c.id) AS boletos
       FROM ${tcup} c
       INNER JOIN ${tent} e ON e.id = c.entrada_id
       WHERE e.empresa_id = $1::uuid
         AND e.sorteo_id = $2::uuid
         AND e.estado_pago NOT IN ('rechazado', 'anulado')`,
      [empresaId, sorteoId]
    ),
    pool.query(
      `SELECT COALESCE(SUM(e.monto_total), 0) AS monto
       FROM ${tent} e
       WHERE e.empresa_id = $1::uuid
         AND e.sorteo_id = $2::uuid
         AND e.estado_pago NOT IN ('rechazado', 'anulado')`,
      [empresaId, sorteoId]
    ),
  ]);

  const bRow = bRes.rows?.[0] as PgKpiRow | undefined;
  const mRow = mRes.rows?.[0] as PgKpiRow | undefined;
  const boletos = Number(bRow?.boletos) || 0;
  const monto = Number(mRow?.monto) || 0;
  return { boletos, monto };
}

export async function getSorteosVentasKpis(): Promise<SorteosVentasKpis> {
  const empty: SorteosVentasKpis = {
    boletosHoy: 0,
    boletosSorteo: 0,
    montoHoy: 0,
    montoSorteo: 0,
    sorteoNombre: null,
  };

  /** Misma resolución que `/api/sorteos`: `auth_user_id`, variantes de email, `ilike` (no solo `eq` email). */
  const auth = await getUserAndEmpresa(null);
  if (!auth?.empresa_id) {
    return empty;
  }

  const empresaId = auth.empresa_id;
  const schema = await fetchDataSchemaForEmpresaId(empresaId);

  const day = asuncionDayBoundsUtc();

  const pool = getChatPostgresPool();
  if (pool) {
    try {
      const current = await fetchCurrentSorteoFromPg(pool, schema, empresaId);
      const [d, s] = await Promise.all([
        fetchKpiWindowFromPg(pool, schema, empresaId, day.start, day.end),
        current
          ? fetchSorteoLifetimeFromPg(pool, schema, empresaId, current.id)
          : Promise.resolve({ boletos: 0, monto: 0 }),
      ]);
      const out: SorteosVentasKpis = {
        boletosHoy: d.boletos,
        montoHoy: d.monto,
        boletosSorteo: s.boletos,
        montoSorteo: s.monto,
        sorteoNombre: current?.nombre ?? null,
      };
      void logDashboardDebug(pool, schema, empresaId, day, current, "pg", out);
      return out;
    } catch (e) {
      logDashboardError(empresaId, schema, e);
    }
  }

  try {
    const supabase = await getChatServiceClientForEmpresa(empresaId);

    const sorteosRes = await supabase
      .from("sorteos")
      .select("id, nombre, estado, created_at")
      .eq("empresa_id", empresaId);
    if (sorteosRes.error) {
      logDashboardError(empresaId, schema, sorteosRes.error);
      return empty;
    }
    const current = pickCurrentSorteo(sorteosRes.data ?? []);

    const [dayRes, sorteoRes] = await Promise.all([
      supabase
        .from("sorteo_entradas")
        .select("cantidad_boletos, monto_total, estado_pago")
        .eq("empresa_id", empresaId)
        .gte("created_at", day.start)
        .lte("created_at", day.end),
      current
        ? supabase
            .from("sorteo_entradas")
            .select("cantidad_boletos, monto_total, estado_pago")
            .eq("empresa_id", empresaId)
            .eq("sorteo_id", current.id)
        : Promise.resolve({ data: [], error: null } as { data: unknown[]; error: null }),
    ]);

    if (dayRes.error || (sorteoRes as { error?: unknown }).error) {
      logDashboardError(empresaId, schema, dayRes.error ?? (sorteoRes as { error?: unknown }).error);
      return empty;
    }

    const sD = sumRows(dayRes.data ?? []);
    const sS = sumRows(((sorteoRes as { data?: unknown[] }).data ?? []) as Parameters<typeof sumRows>[0]);
    const out: SorteosVentasKpis = {
      boletosHoy: sD.boletos,
      montoHoy: sD.monto,
      boletosSorteo: sS.boletos,
      montoSorteo: sS.monto,
      sorteoNombre: current?.nombre ?? null,
    };
    void logDashboardDebug(pool, schema, empresaId, day, current, "postgrest", out);
    return out;
  } catch (e) {
    logDashboardError(empresaId, schema, e);
    return empty;
  }
}
