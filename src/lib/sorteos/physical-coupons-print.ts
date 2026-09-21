import type { SorteoEntradaEstadoPago } from "@/lib/sorteos/types";
import {
  getChatPostgresPool,
  getChatPostgresConnectionString,
  isPgPoolExhaustionMessage,
  quoteSchemaTable,
} from "@/lib/supabase/chat-pg-pool";
import {
  assertAllowedChatDataSchema,
  isLikelyUnexposedTenantChatSchema,
} from "@/lib/supabase/chat-data-schema";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { getEmpresaIdForCurrentUserServer } from "@/lib/supabase/empresa-data-server";
import { getChatServiceClientForEmpresa } from "@/lib/supabase/chat-service-role-empresa";
import { resolveCiudadByEntradaPostgrest } from "@/lib/sorteos/server-queries";

const SOURCE = "src/lib/sorteos/physical-coupons-print.ts";

/** Máximo de cupones por una sola vista de impresión (evita timeouts). */
export const PHYSICAL_COUPONS_PRINT_MAX = 8000;

export type PhysicalCouponPrintParams = {
  sorteoId: string;
  /** Si está definido, solo cupones de esa entrada; no se filtra por estado_pago (solo lectura de esa orden). */
  entradaId?: string | null;
  /**
   * Impresión por tandas: varias órdenes seleccionadas. Cuando viene (y no hay `entradaId`),
   * se imprimen los cupones de esas entradas sin filtrar por estado_pago (lectura de lo seleccionado).
   */
  entradaIds?: string[] | null;
  /** Si es null/undefined, se usa `confirmado` (ignorado cuando hay entradaId/entradaIds). */
  estadoPago?: SorteoEntradaEstadoPago | null;
  q?: string | null;
  /** ISO date YYYY-MM-DD inclusive (filtro sobre fecha de referencia). */
  fechaDesde?: string | null;
  fechaHasta?: string | null;
  /** Rango numérico por número de cupón (solo cupones con numero_cupon numérico). Inclusive. */
  cuponDesde?: number | null;
  cuponHasta?: number | null;
};

/** Filtro interno normalizado que comparten las dos rutas de lectura (pg-directo / PostgREST). */
type CouponFetchFilter = {
  sorteoId: string;
  estadoPago: SorteoEntradaEstadoPago;
  q: string | null;
  fechaDesde: string | null;
  fechaHasta: string | null;
  entradaId: string | null;
  entradaIds: string[] | null;
  cuponDesde: number | null;
  cuponHasta: number | null;
};

export type PhysicalCouponPrintRow = {
  cupon_id: string;
  numero_cupon: string;
  sorteo_nombre: string;
  numero_orden: number;
  nombre_participante: string | null;
  /** Documento completo (sin enmascarar): cupón físico operativo para urna/control interno. */
  documento: string | null;
  /** Teléfono completo (sin enmascarar): cupón físico operativo para urna/control interno. */
  whatsapp: string | null;
  /** Ciudad del comprador (clientes.ciudad vía sorteo_entradas.cliente_id). Null si no hay. */
  ciudad: string | null;
  /** Texto corto para la tarjeta: preferimos pago confirmado; si no hay, alta de la orden. */
  fecha_display: string;
};

function resolveModoEjecucion(dataSchema: string): string {
  const tieneDirectUrl = Boolean(getChatPostgresConnectionString());
  if (isLikelyUnexposedTenantChatSchema(dataSchema)) {
    return tieneDirectUrl ? "postgres_directo" : "tenant_sin_direct_url";
  }
  return "postgrest_service_role";
}

/** Fecha de referencia única: fecha_pago si existe; si no, created_at de la entrada. */
export function fechaReferenciaEntrada(fechaPago: string | null | undefined, createdAt: string): Date {
  if (fechaPago) {
    const d = new Date(fechaPago);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date(createdAt);
}

function normalizeDocumento(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const t = String(raw).trim();
  return t || null;
}

function normalizeWhatsapp(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const t = String(raw).trim();
  return t || null;
}

function normalizeCiudad(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const t = String(raw).trim();
  return t || null;
}

function formatFechaDisplay(d: Date): string {
  try {
    return d.toLocaleString("es-PY", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return d.toISOString().slice(0, 16);
  }
}

function parseYmdBoundary(s: string, endOfDay: boolean): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  const dt = new Date(y, mo, d, endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

/** Búsqueda en cliente (PostgREST): nombre, doc, tel y número de orden como texto. */
function entradaMatchesQuery(
  se: Record<string, unknown>,
  q: string | null | undefined
): boolean {
  if (!q || !q.trim()) return true;
  const t = q.trim().toLowerCase();
  const nom = String(se.nombre_participante ?? "").toLowerCase();
  const doc = String(se.documento ?? "").toLowerCase();
  const wa = String(se.whatsapp_numero ?? "").toLowerCase();
  const ord = String(se.numero_orden ?? "");
  return nom.includes(t) || doc.includes(t) || wa.includes(t) || ord.includes(t);
}

function passesDateRange(ref: Date, fechaDesde: string | null | undefined, fechaHasta: string | null | undefined): boolean {
  if (fechaDesde) {
    const from = parseYmdBoundary(fechaDesde, false);
    if (from && ref < from) return false;
  }
  if (fechaHasta) {
    const to = parseYmdBoundary(fechaHasta, true);
    if (to && ref > to) return false;
  }
  return true;
}

function mapRow(args: {
  cupon_id: string;
  numero_cupon: string;
  sorteo_nombre: string;
  numero_orden: number;
  nombre_participante: string;
  documento: string | null;
  whatsapp_numero: string;
  ciudad: string | null;
  fecha_pago: string | null;
  entrada_created_at: string;
}): PhysicalCouponPrintRow {
  const ref = fechaReferenciaEntrada(args.fecha_pago, args.entrada_created_at);
  const nom = args.nombre_participante?.trim() || null;
  return {
    cupon_id: args.cupon_id,
    numero_cupon: args.numero_cupon,
    sorteo_nombre: args.sorteo_nombre,
    numero_orden: args.numero_orden,
    nombre_participante: nom,
    documento: normalizeDocumento(args.documento),
    whatsapp: normalizeWhatsapp(args.whatsapp_numero),
    ciudad: normalizeCiudad(args.ciudad),
    fecha_display: formatFechaDisplay(ref),
  };
}

export type EntradaImpresionContext = {
  entrada_id: string;
  numero_orden: number;
  nombre_participante: string;
  cantidad_cupones: number;
  cupones_impresos_at: string | null;
};

export type PhysicalCouponsPrintResult = {
  data: PhysicalCouponPrintRow[];
  error: string | null;
  entrada_context?: EntradaImpresionContext | null;
};

async function fetchPhysicalCouponsPgDirect(
  empresaId: string,
  dataSchema: string,
  f: CouponFetchFilter
): Promise<PhysicalCouponsPrintResult> {
  const { sorteoId, estadoPago, q, fechaDesde, fechaHasta, entradaId, entradaIds, cuponDesde, cuponHasta } = f;
  const pool = getChatPostgresPool();
  if (!pool) {
    return {
      data: [],
      error:
        "Falta SUPABASE_DB_URL o DIRECT_URL en el servidor: no se puede leer el esquema del tenant sin conexión Postgres directa.",
    };
  }

  const sch = assertAllowedChatDataSchema(dataSchema);
  const tCup = quoteSchemaTable(sch, "sorteo_cupones");
  const tEnt = quoteSchemaTable(sch, "sorteo_entradas");
  const tSort = quoteSchemaTable(sch, "sorteos");
  const tCli = quoteSchemaTable(sch, "clientes");
  const tFlowData = quoteSchemaTable(sch, "chat_flow_data");

  const params: unknown[] = [empresaId, sorteoId];
  let i = 3;
  const conds: string[] = [
    `c.empresa_id = $1::uuid`,
    `c.sorteo_id = $2::uuid`,
    `se.empresa_id = c.empresa_id`,
    `so.id = c.sorteo_id`,
    `so.empresa_id = c.empresa_id`,
    /**
     * Una venta anulada no va a la urna: sus cupones no participan. Se filtra por
     * `estado_pago` (columna de siempre) y no por `sorteo_cupones.anulado_at`, que es nueva:
     * así la impresión no depende del orden en que se apliquen migración y deploy.
     */
    `se.estado_pago <> 'anulado'`,
  ];

  if (entradaId) {
    conds.push(`se.id = $${i}::uuid`);
    conds.push(`c.entrada_id = $${i}::uuid`);
    params.push(entradaId);
    i++;
  } else if (entradaIds && entradaIds.length > 0) {
    // Tanda: cupones de las órdenes seleccionadas, sin filtrar por estado_pago.
    conds.push(`c.entrada_id = ANY($${i}::uuid[])`);
    params.push(entradaIds);
    i++;
  } else {
    conds.push(`se.estado_pago = $${i}::text`);
    params.push(estadoPago);
    i++;
  }

  // Rango por número de cupón (solo cupones con numero_cupon numérico).
  if (cuponDesde != null) {
    conds.push(`(c.numero_cupon ~ '^[0-9]+$' AND c.numero_cupon::bigint >= $${i}::bigint)`);
    params.push(cuponDesde);
    i++;
  }
  if (cuponHasta != null) {
    conds.push(`(c.numero_cupon ~ '^[0-9]+$' AND c.numero_cupon::bigint <= $${i}::bigint)`);
    params.push(cuponHasta);
    i++;
  }

  if (q && q.length > 0) {
    const term = `%${q.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")}%`;
    conds.push(
      `(se.nombre_participante ILIKE $${i} ESCAPE '\\'
        OR COALESCE(se.documento::text, '') ILIKE $${i} ESCAPE '\\'
        OR se.whatsapp_numero ILIKE $${i} ESCAPE '\\'
        OR CAST(se.numero_orden AS text) ILIKE $${i} ESCAPE '\\')`
    );
    params.push(term);
    i++;
  }

  if (fechaDesde) {
    const fd = parseYmdBoundary(fechaDesde, false);
    if (!fd) {
      return { data: [], error: "Fecha desde inválida (usá YYYY-MM-DD)." };
    }
    conds.push(`(COALESCE(se.fecha_pago, se.created_at) >= $${i}::timestamptz)`);
    params.push(fd.toISOString());
    i++;
  }
  if (fechaHasta) {
    const fh = parseYmdBoundary(fechaHasta, true);
    if (!fh) {
      return { data: [], error: "Fecha hasta inválida (usá YYYY-MM-DD)." };
    }
    conds.push(`(COALESCE(se.fecha_pago, se.created_at) <= $${i}::timestamptz)`);
    params.push(fh.toISOString());
    i++;
  }

  const whereSql = conds.join(" AND ");

  const sql = `
    SELECT
      c.id AS cupon_id,
      c.numero_cupon,
      so.nombre AS sorteo_nombre,
      se.numero_orden,
      se.nombre_participante,
      se.documento,
      se.whatsapp_numero,
      COALESCE(
        (SELECT NULLIF(TRIM(fd.field_value), '')
           FROM ${tFlowData} fd
           WHERE fd.conversation_id = se.chat_conversation_id
             AND fd.empresa_id = se.empresa_id
             AND fd.field_name IN ('ciudad', 'localidad', 'ubicacion')
             AND NULLIF(TRIM(fd.field_value), '') IS NOT NULL
           ORDER BY fd.created_at DESC
           LIMIT 1),
        NULLIF(TRIM(cl.ciudad), '')
      ) AS ciudad,
      se.fecha_pago,
      se.created_at AS entrada_created_at
    FROM ${tCup} c
    INNER JOIN ${tEnt} se ON se.id = c.entrada_id AND se.empresa_id = c.empresa_id
    INNER JOIN ${tSort} so ON so.id = c.sorteo_id AND so.empresa_id = c.empresa_id
    LEFT JOIN ${tCli} cl ON cl.id = se.cliente_id AND cl.empresa_id = se.empresa_id
    WHERE ${whereSql}
    ORDER BY c.created_at ASC NULLS LAST, c.numero_cupon ASC NULLS LAST
    LIMIT ${PHYSICAL_COUPONS_PRINT_MAX + 1}
  `;

  try {
    const res = await pool.query(sql, params);
    const rows = res.rows as Record<string, unknown>[];
    if (rows.length > PHYSICAL_COUPONS_PRINT_MAX) {
      return {
        data: [],
        error: `Hay más de ${PHYSICAL_COUPONS_PRINT_MAX} cupones con estos filtros. Acotá fechas o búsqueda.`,
      };
    }

    const data: PhysicalCouponPrintRow[] = rows.map((r) =>
      mapRow({
        cupon_id: String(r.cupon_id),
        numero_cupon: String(r.numero_cupon ?? ""),
        sorteo_nombre: String(r.sorteo_nombre ?? "—"),
        numero_orden: typeof r.numero_orden === "number" ? r.numero_orden : Number(r.numero_orden) || 0,
        nombre_participante: String(r.nombre_participante ?? ""),
        documento: r.documento != null ? String(r.documento) : null,
        whatsapp_numero: String(r.whatsapp_numero ?? ""),
        ciudad: r.ciudad != null ? String(r.ciudad) : null,
        fecha_pago: r.fecha_pago != null ? String(r.fecha_pago) : null,
        entrada_created_at: String(r.entrada_created_at ?? ""),
      })
    );
    return { data, error: null };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[sorteos][physical-print]", "pg_error", { empresa_id: empresaId, schema: dataSchema, msg: msg.slice(0, 400) });
    return { data: [], error: msg };
  }
}

async function fetchPhysicalCouponsPostgrest(
  empresaId: string,
  dataSchema: string,
  f: CouponFetchFilter,
  modo: string
): Promise<PhysicalCouponsPrintResult> {
  const { sorteoId, estadoPago, q, fechaDesde, fechaHasta, entradaId, entradaIds, cuponDesde, cuponHasta } = f;
  const sb = await getChatServiceClientForEmpresa(empresaId);

  let qb = sb
    .from("sorteo_cupones")
    .select(
      `
      id,
      numero_cupon,
      created_at,
      entrada_id,
      sorteo_entradas!inner (
        nombre_participante,
        documento,
        whatsapp_numero,
        numero_orden,
        estado_pago,
        fecha_pago,
        created_at,
        chat_conversation_id,
        cliente_id
      ),
      sorteos!inner ( nombre )
    `
    )
    .eq("empresa_id", empresaId)
    .eq("sorteo_id", sorteoId);

  if (entradaId) {
    qb = qb.eq("entrada_id", entradaId);
  } else if (entradaIds && entradaIds.length > 0) {
    qb = qb.in("entrada_id", entradaIds);
  } else {
    qb = qb.eq("sorteo_entradas.estado_pago", estadoPago);
  }

  const { data: raw, error: e1 } = await qb
    .order("created_at", { ascending: true })
    .order("numero_cupon", { ascending: true })
    .limit(PHYSICAL_COUPONS_PRINT_MAX + 1);

  if (e1) {
    console.error("[sorteos][physical-print]", "postgrest_error", {
      empresa_id: empresaId,
      schema: dataSchema,
      modo,
      archivo: SOURCE,
      error: e1.message,
    });
    return { data: [], error: e1.message };
  }

  const list = (raw ?? []) as Record<string, unknown>[];
  if (list.length > PHYSICAL_COUPONS_PRINT_MAX) {
    return {
      data: [],
      error: `Hay más de ${PHYSICAL_COUPONS_PRINT_MAX} cupones con estos filtros. Acotá fechas o búsqueda.`,
    };
  }

  // Ciudad (path PostgREST): mismo criterio que el listado — chat_flow_data → fallback clientes.
  const ciudadByEntrada = await resolveCiudadByEntradaPostgrest(
    sb,
    empresaId,
    list.map((row) => {
      const se = row.sorteo_entradas as Record<string, unknown> | null | undefined;
      return {
        id: row.entrada_id,
        chat_conversation_id: se?.chat_conversation_id ?? null,
        cliente_id: se?.cliente_id ?? null,
      };
    })
  );

  const out: PhysicalCouponPrintRow[] = [];

  for (const row of list) {
    const se = row.sorteo_entradas as Record<string, unknown> | null | undefined;
    const so = row.sorteos as Record<string, unknown> | null | undefined;
    if (!se || !so) continue;
    if (!entradaMatchesQuery(se, q)) continue;

    // Rango por número de cupón (numérico): se filtra en cliente para PostgREST.
    if (cuponDesde != null || cuponHasta != null) {
      const numStr = String(row.numero_cupon ?? "").trim();
      if (!/^[0-9]+$/.test(numStr)) continue;
      const n = Number(numStr);
      if (cuponDesde != null && n < cuponDesde) continue;
      if (cuponHasta != null && n > cuponHasta) continue;
    }

    const fechaPago = se.fecha_pago != null ? String(se.fecha_pago) : null;
    const entradaCreated = String(se.created_at ?? "");
    const ref = fechaReferenciaEntrada(fechaPago, entradaCreated);
    if (!passesDateRange(ref, fechaDesde, fechaHasta)) continue;

    const numeroOrden =
      typeof se.numero_orden === "number" ? se.numero_orden : Number(se.numero_orden) || 0;

    out.push(
      mapRow({
        cupon_id: String(row.id),
        numero_cupon: String(row.numero_cupon ?? ""),
        sorteo_nombre: String(so.nombre ?? "—"),
        numero_orden: numeroOrden,
        nombre_participante: String(se.nombre_participante ?? ""),
        documento: se.documento != null ? String(se.documento) : null,
        whatsapp_numero: String(se.whatsapp_numero ?? ""),
        ciudad: ciudadByEntrada[String(row.entrada_id ?? "").trim()] ?? null,
        fecha_pago: fechaPago,
        entrada_created_at: entradaCreated,
      })
    );
  }

  return { data: out, error: null };
}

async function runFetch(
  empresaId: string,
  dataSchema: string,
  f: CouponFetchFilter
): Promise<PhysicalCouponsPrintResult> {
  const modo = resolveModoEjecucion(dataSchema);

  if (isLikelyUnexposedTenantChatSchema(dataSchema)) {
    if (!getChatPostgresConnectionString()) {
      const err =
        "Tenant no expuesto en PostgREST: configurá SUPABASE_DB_URL o DIRECT_URL en el servidor para leer cupones.";
      console.error("[sorteos][physical-print]", "tenant_sin_pool", { empresa_id: empresaId, schema: dataSchema });
      return { data: [], error: err };
    }
    return fetchPhysicalCouponsPgDirect(empresaId, dataSchema, f);
  }

  /** Una entrada / tanda / rango / búsqueda con texto: SQL completo si hay pool. */
  const prefersPgDirect =
    Boolean(f.entradaId) ||
    Boolean(f.entradaIds && f.entradaIds.length > 0) ||
    f.cuponDesde != null ||
    f.cuponHasta != null ||
    Boolean(f.q?.trim());
  if (prefersPgDirect && getChatPostgresPool()) {
    return fetchPhysicalCouponsPgDirect(empresaId, dataSchema, f);
  }

  try {
    return await fetchPhysicalCouponsPostgrest(empresaId, dataSchema, f, modo);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const exhausted = isPgPoolExhaustionMessage(msg);
    console.error("[sorteos][physical-print]", "catch", { empresa_id: empresaId, schema: dataSchema, error: msg });
    return {
      data: [],
      error: exhausted ? "Servidor de base de datos saturado; reintentá en unos segundos." : msg,
    };
  }
}

/**
 * Lista una fila imprimible por cada registro en sorteo_cupones (solo lectura).
 * Por defecto solo entradas con estado_pago confirmado (si no se pasa otro estado explícito).
 */
async function fetchEntradaImpresionContextForPrintServer(
  empresaId: string,
  dataSchema: string,
  sorteoId: string,
  entradaId: string
): Promise<EntradaImpresionContext | null> {
  if (isLikelyUnexposedTenantChatSchema(dataSchema)) {
    const pool = getChatPostgresPool();
    if (!pool) return null;
    try {
      const sch = assertAllowedChatDataSchema(dataSchema);
      const tEnt = quoteSchemaTable(sch, "sorteo_entradas");
      const tCup = quoteSchemaTable(sch, "sorteo_cupones");
      const res = await pool.query(
        `SELECT se.id,
                se.numero_orden,
                se.nombre_participante,
                se.cupones_impresos_at,
                (SELECT COUNT(*)::int FROM ${tCup} c
                 WHERE c.entrada_id = se.id AND c.empresa_id = se.empresa_id) AS cantidad_cupones
         FROM ${tEnt} se
         WHERE se.id = $1::uuid AND se.empresa_id = $2::uuid AND se.sorteo_id = $3::uuid
         LIMIT 1`,
        [entradaId, empresaId, sorteoId]
      );
      const r = res.rows?.[0] as Record<string, unknown> | undefined;
      if (!r) return null;
      const at = r.cupones_impresos_at;
      return {
        entrada_id: String(r.id),
        numero_orden: typeof r.numero_orden === "number" ? r.numero_orden : Number(r.numero_orden) || 0,
        nombre_participante: String(r.nombre_participante ?? ""),
        cantidad_cupones: typeof r.cantidad_cupones === "number" ? r.cantidad_cupones : Number(r.cantidad_cupones) || 0,
        cupones_impresos_at:
          at instanceof Date ? at.toISOString() : at != null ? String(at) : null,
      };
    } catch (e) {
      console.error("[sorteos][physical-print]", "entrada_context_pg", e);
      return null;
    }
  }

  try {
    const sb = await getChatServiceClientForEmpresa(empresaId);
    const { data: se, error: e1 } = await sb
      .from("sorteo_entradas")
      .select("id, numero_orden, nombre_participante, cupones_impresos_at")
      .eq("id", entradaId)
      .eq("empresa_id", empresaId)
      .eq("sorteo_id", sorteoId)
      .maybeSingle();

    if (e1 || !se || typeof se !== "object") return null;

    const row = se as Record<string, unknown>;
    const { count, error: e2 } = await sb
      .from("sorteo_cupones")
      .select("*", { count: "exact", head: true })
      .eq("empresa_id", empresaId)
      .eq("entrada_id", entradaId);

    if (e2) return null;

    const at = row.cupones_impresos_at;
    return {
      entrada_id: String(row.id),
      numero_orden: typeof row.numero_orden === "number" ? row.numero_orden : Number(row.numero_orden) || 0,
      nombre_participante: String(row.nombre_participante ?? ""),
      cantidad_cupones: count ?? 0,
      cupones_impresos_at:
        at instanceof Date ? at.toISOString() : at != null ? String(at) : null,
    };
  } catch (e) {
    console.error("[sorteos][physical-print]", "entrada_context_sr", e);
    return null;
  }
}

/** Verifica que el sorteo pertenezca a la empresa actual (lectura; mismo patrón multi-schema). */
export async function fetchSorteoNombreForEmpresaServer(sorteoId: string): Promise<string | null> {
  const empresaId = await getEmpresaIdForCurrentUserServer();
  if (!empresaId) return null;

  const dataSchema = await fetchDataSchemaForEmpresaId(empresaId);

  if (isLikelyUnexposedTenantChatSchema(dataSchema)) {
    const pool = getChatPostgresPool();
    if (!pool) return null;
    try {
      const sch = assertAllowedChatDataSchema(dataSchema);
      const tSort = quoteSchemaTable(sch, "sorteos");
      const res = await pool.query(
        `SELECT nombre FROM ${tSort} WHERE id = $1::uuid AND empresa_id = $2::uuid LIMIT 1`,
        [sorteoId, empresaId]
      );
      const row = res.rows?.[0] as { nombre?: string } | undefined;
      return row?.nombre != null ? String(row.nombre) : null;
    } catch (e) {
      console.error("[sorteos][physical-print]", "sorteo_lookup_pg", e);
      return null;
    }
  }

  try {
    const sb = await getChatServiceClientForEmpresa(empresaId);
    const { data, error } = await sb
      .from("sorteos")
      .select("nombre")
      .eq("id", sorteoId)
      .eq("empresa_id", empresaId)
      .maybeSingle();
    if (error) {
      console.error("[sorteos][physical-print]", "sorteo_lookup_sr", error.message);
      return null;
    }
    return data?.nombre != null ? String(data.nombre) : null;
  } catch (e) {
    console.error("[sorteos][physical-print]", "sorteo_lookup", e);
    return null;
  }
}

export async function fetchPhysicalCouponsForPrintServer(
  params: PhysicalCouponPrintParams
): Promise<PhysicalCouponsPrintResult> {
  const empresaId = await getEmpresaIdForCurrentUserServer();
  if (!empresaId) {
    return { data: [], error: "Sin sesión o empresa.", entrada_context: null };
  }

  const sorteoId = params.sorteoId?.trim();
  if (!sorteoId) {
    return { data: [], error: "Sorteo no especificado.", entrada_context: null };
  }

  const estadoPago: SorteoEntradaEstadoPago =
    params.estadoPago != null ? params.estadoPago : "confirmado";

  const q = params.q?.trim() || null;
  const fechaDesde = params.fechaDesde?.trim() || null;
  const fechaHasta = params.fechaHasta?.trim() || null;
  const entradaId = params.entradaId?.trim() || null;

  // Tanda: normaliza y deduplica IDs de orden (ignorado si hay un entradaId singular).
  const entradaIds: string[] | null = (() => {
    if (entradaId) return null;
    const raw = Array.isArray(params.entradaIds) ? params.entradaIds : [];
    const clean = [...new Set(raw.map((s) => String(s).trim()).filter(Boolean))];
    return clean.length > 0 ? clean : null;
  })();

  const toInt = (v: number | null | undefined): number | null => {
    if (v == null || !Number.isFinite(v)) return null;
    const n = Math.trunc(v);
    return n >= 0 ? n : null;
  };
  let cuponDesde = toInt(params.cuponDesde);
  let cuponHasta = toInt(params.cuponHasta);
  // Si vienen invertidos, los ordenamos para que el rango sea válido.
  if (cuponDesde != null && cuponHasta != null && cuponDesde > cuponHasta) {
    const tmp = cuponDesde;
    cuponDesde = cuponHasta;
    cuponHasta = tmp;
  }

  const dataSchema = await fetchDataSchemaForEmpresaId(empresaId);

  let entrada_context: EntradaImpresionContext | null = null;
  if (entradaId) {
    entrada_context = await fetchEntradaImpresionContextForPrintServer(
      empresaId,
      dataSchema,
      sorteoId,
      entradaId
    );
    if (!entrada_context) {
      return {
        data: [],
        error: "La orden no existe o no pertenece a este sorteo.",
        entrada_context: null,
      };
    }
  }

  const out = await runFetch(empresaId, dataSchema, {
    sorteoId,
    estadoPago,
    q,
    fechaDesde,
    fechaHasta,
    entradaId,
    entradaIds,
    cuponDesde,
    cuponHasta,
  });
  return { ...out, entrada_context };
}
