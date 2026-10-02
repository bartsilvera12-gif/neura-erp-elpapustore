import type {
  SorteoCompradorCompraRow,
  SorteoCompradorRankingRow,
  SorteoCuponOrdenRow,
  SorteoEntrada,
  SorteoEntradaEstadoPago,
} from "@/lib/sorteos/types";
import {
  getChatPostgresPool,
  getChatPostgresConnectionString,
  isPgPoolExhaustionMessage,
  logPgPoolStats,
  quoteSchemaTable,
} from "@/lib/supabase/chat-pg-pool";
import {
  assertAllowedChatDataSchema,
  isLikelyUnexposedTenantChatSchema,
} from "@/lib/supabase/chat-data-schema";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { getEmpresaIdForCurrentUserServer } from "@/lib/supabase/empresa-data-server";
import { getChatServiceClientForEmpresa } from "@/lib/supabase/chat-service-role-empresa";

const SORTEOS_QUERY_SOURCE = "src/lib/sorteos/server-queries.ts";

const SORTEOS_LIST_CACHE_TTL_MS = 4000;
const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 100;

type NormalizedListParams = {
  page: number;
  limit: number;
  offset: number;
  sorteoId: string | null;
  q: string | null;
  estadoPago: SorteoEntradaEstadoPago | null;
};

const listCache = new Map<
  string,
  { at: number; payload: SorteoEntradasServerResult | SorteoCuponesServerResult }
>();
const listInflight = new Map<string, Promise<SorteoEntradasServerResult | SorteoCuponesServerResult>>();

function normalizeListParams(raw?: SorteoEntradasListParams): NormalizedListParams {
  const pageRaw = raw?.page ?? 1;
  const limitRaw = raw?.limit ?? DEFAULT_PAGE_LIMIT;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.min(MAX_PAGE_LIMIT, Math.max(1, Math.floor(limitRaw)))
      : DEFAULT_PAGE_LIMIT;
  const offset = (page - 1) * limit;
  const sorteoId = raw?.sorteoId?.trim() || null;
  const q = raw?.q?.trim() || null;
  const estadoPago = raw?.estadoPago ?? null;
  return { page, limit, offset, sorteoId, q, estadoPago };
}

function cacheKeyEntradas(empresaId: string, schema: string, p: NormalizedListParams) {
  return `ent:${schema}:${empresaId}:${p.page}:${p.limit}:${p.sorteoId ?? ""}:${p.q ?? ""}:${p.estadoPago ?? ""}`;
}

function cacheKeyCupones(empresaId: string, schema: string, p: NormalizedListParams) {
  return `cup:${schema}:${empresaId}:${p.page}:${p.limit}:${p.sorteoId ?? ""}:${p.q ?? ""}:${p.estadoPago ?? ""}`;
}

function normalizeRowTimestamps<T extends Record<string, unknown>>(row: T): T {
  const out = { ...row } as Record<string, unknown>;
  for (const k of ["created_at", "updated_at", "fecha_pago", "validado_at"]) {
    const v = out[k];
    if (v instanceof Date) out[k] = v.toISOString();
  }
  return out as T;
}

function resolveModoEjecucion(dataSchema: string): string {
  const tieneDirectUrl = Boolean(getChatPostgresConnectionString());
  if (isLikelyUnexposedTenantChatSchema(dataSchema)) {
    return tieneDirectUrl ? "postgres_directo" : "tenant_sin_direct_url";
  }
  return "postgrest_service_role";
}

export type SorteoEntradasListParams = {
  page?: number;
  limit?: number;
  sorteoId?: string | null;
  q?: string | null;
  estadoPago?: SorteoEntradaEstadoPago | null;
};

export type SorteoEntradasServerResult = {
  data: SorteoEntrada[];
  error: string | null;
  total_count: number;
  page: number;
  limit: number;
  transient_error?: boolean;
};

export type SorteoCuponesServerResult = {
  data: SorteoCuponOrdenRow[];
  error: string | null;
  total_count: number;
  page: number;
  limit: number;
  transient_error?: boolean;
};

export type SorteoOption = {
  id: string;
  nombre: string;
  estado: string;
  fecha_sorteo: string | null;
  created_at: string | null;
};

/**
 * Lista liviana de sorteos (para el selector de las pestañas Entradas/Cupones/Tickets).
 * Server-side; usa el mismo cliente que el resto (PG shim en single_client / PostgREST si expuesto).
 */
export async function fetchSorteosListServer(): Promise<{
  empresaId: string | null;
  sorteos: SorteoOption[];
}> {
  const empresaId = await getEmpresaIdForCurrentUserServer();
  if (!empresaId) return { empresaId: null, sorteos: [] };
  try {
    const sb = await getChatServiceClientForEmpresa(empresaId);
    const { data, error } = await sb
      .from("sorteos")
      .select("id, nombre, estado, fecha_sorteo, created_at")
      .eq("empresa_id", empresaId)
      .order("created_at", { ascending: false });
    if (error || !Array.isArray(data)) return { empresaId, sorteos: [] };
    const sorteos: SorteoOption[] = (data as Record<string, unknown>[]).map((r) => ({
      id: String(r.id),
      nombre: typeof r.nombre === "string" ? r.nombre : "",
      estado: typeof r.estado === "string" ? r.estado : "activo",
      fecha_sorteo: r.fecha_sorteo != null ? String(r.fecha_sorteo) : null,
      created_at: r.created_at != null ? String(r.created_at) : null,
    }));
    return { empresaId, sorteos };
  } catch {
    return { empresaId, sorteos: [] };
  }
}

/**
 * Sorteo "actual" por defecto: primero el más reciente con estado='activo';
 * si no hay activo, el más reciente. Recencia por fecha_sorteo y, en su defecto, created_at.
 */
export function pickDefaultSorteoId(sorteos: SorteoOption[]): string | null {
  if (!sorteos.length) return null;
  const recency = (s: SorteoOption): number => {
    const t = s.fecha_sorteo ?? s.created_at;
    const n = t ? Date.parse(t) : NaN;
    return Number.isFinite(n) ? n : 0;
  };
  const sorted = [...sorteos].sort((a, b) => recency(b) - recency(a));
  const activo = sorted.find((s) => s.estado === "activo");
  return (activo ?? sorted[0]).id;
}

/** `tableAlias` ej. `se` cuando la FROM usa `FROM … se`. */
function buildEntradaWhereParts(
  empresaId: string,
  p: NormalizedListParams,
  startParamIndex: number,
  tableAlias?: string
): { sql: string; params: unknown[]; nextIdx: number } {
  const a = tableAlias ? `${tableAlias}.` : "";
  const conds: string[] = [`${a}empresa_id = $${startParamIndex}::uuid`];
  const params: unknown[] = [empresaId];
  let i = startParamIndex + 1;

  if (p.sorteoId) {
    conds.push(`${a}sorteo_id = $${i}::uuid`);
    params.push(p.sorteoId);
    i++;
  }
  if (p.q && p.q.length > 0) {
    const term = `%${p.q.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")}%`;
    conds.push(
      `(${a}nombre_participante ILIKE $${i} ESCAPE '\\'
        OR COALESCE(${a}documento::text, '') ILIKE $${i} ESCAPE '\\'
        OR ${a}whatsapp_numero ILIKE $${i} ESCAPE '\\'
        OR CAST(${a}numero_orden AS text) ILIKE $${i} ESCAPE '\\')`
    );
    params.push(term);
    i++;
  }
  if (p.estadoPago) {
    conds.push(`${a}estado_pago = $${i}::text`);
    params.push(p.estadoPago);
    i++;
  }

  return { sql: conds.join(" AND "), params, nextIdx: i };
}

function mapRowsToSorteoEntrada(
  rows: Record<string, unknown>[],
  nombreById: Record<string, string>
): SorteoEntrada[] {
  return rows.map((raw) => {
    const r = normalizeRowTimestamps(raw);
    const sid = r.sorteo_id != null ? String(r.sorteo_id) : "";
    const nm = sid && nombreById[sid] ? { nombre: nombreById[sid] } : null;
    return { ...r, sorteos: nm } as unknown as SorteoEntrada;
  });
}

async function fetchSorteoEntradasPgDirect(
  empresaId: string,
  dataSchema: string,
  listParams: NormalizedListParams
): Promise<SorteoEntradasServerResult> {
  const pool = getChatPostgresPool();
  if (!pool) {
    return {
      data: [],
      error:
        "Falta SUPABASE_DB_URL o DIRECT_URL en el servidor: no se puede leer el esquema del tenant sin conexión Postgres directa.",
      total_count: 0,
      page: listParams.page,
      limit: listParams.limit,
    };
  }

  const sch = assertAllowedChatDataSchema(dataSchema);
  const tEnt = quoteSchemaTable(sch, "sorteo_entradas");
  const tSort = quoteSchemaTable(sch, "sorteos");

  const { sql: whereSql, params: baseParams } = buildEntradaWhereParts(empresaId, listParams, 1);

  const countSql = `SELECT COUNT(*)::bigint AS c FROM ${tEnt} WHERE ${whereSql}`;
  const countRes = await pool.query(countSql, baseParams);
  const total_count = Number((countRes.rows?.[0] as { c?: string | number } | undefined)?.c ?? 0) || 0;

  const limIdx = baseParams.length + 1;
  const offIdx = baseParams.length + 2;
  const listSql = `
    SELECT * FROM ${tEnt}
    WHERE ${whereSql}
    ORDER BY created_at DESC NULLS LAST
    LIMIT $${limIdx}::int OFFSET $${offIdx}::int
  `;
  const listArgs = [...baseParams, listParams.limit, listParams.offset];
  const entRes = await pool.query(listSql, listArgs);

  const rows = (entRes.rows ?? []) as Record<string, unknown>[];
  const sorteoIds = [...new Set(rows.map((r) => r.sorteo_id).filter(Boolean).map(String))];

  const nombreById: Record<string, string> = {};
  if (sorteoIds.length > 0) {
    const sortRes = await pool.query(
      `SELECT id, nombre FROM ${tSort} WHERE empresa_id = $1::uuid AND id = ANY($2::uuid[])`,
      [empresaId, sorteoIds]
    );
    for (const s of sortRes.rows as { id: string; nombre: string }[]) {
      nombreById[String(s.id)] = s.nombre;
    }
  }

  return {
    data: mapRowsToSorteoEntrada(rows, nombreById),
    error: null,
    total_count,
    page: listParams.page,
    limit: listParams.limit,
  };
}

async function fetchSorteoCuponesOrdenesPgDirect(
  empresaId: string,
  dataSchema: string,
  listParams: NormalizedListParams
): Promise<SorteoCuponesServerResult> {
  const pool = getChatPostgresPool();
  if (!pool) {
    return {
      data: [],
      error:
        "Falta SUPABASE_DB_URL o DIRECT_URL en el servidor: no se puede leer el esquema del tenant sin conexión Postgres directa.",
      total_count: 0,
      page: listParams.page,
      limit: listParams.limit,
    };
  }

  const sch = assertAllowedChatDataSchema(dataSchema);
  const tEnt = quoteSchemaTable(sch, "sorteo_entradas");
  const tCup = quoteSchemaTable(sch, "sorteo_cupones");
  const tSort = quoteSchemaTable(sch, "sorteos");
  const tCli = quoteSchemaTable(sch, "clientes");
  const tFlowData = quoteSchemaTable(sch, "chat_flow_data");

  const { sql: whereSe, params: baseParams } = buildEntradaWhereParts(empresaId, listParams, 1, "se");
  const existsCupon = `EXISTS (
    SELECT 1 FROM ${tCup} c
    WHERE c.entrada_id = se.id AND c.empresa_id = se.empresa_id
  )`;

  const countSql = `
    SELECT COUNT(*)::bigint AS c
    FROM ${tEnt} se
    WHERE ${whereSe} AND ${existsCupon}
  `;
  const countRes = await pool.query(countSql, baseParams);
  const total_count = Number((countRes.rows?.[0] as { c?: string | number } | undefined)?.c ?? 0) || 0;

  const limIdx = baseParams.length + 1;
  const offIdx = baseParams.length + 2;
  // Ciudad: la fuente más completa es chat_flow_data (capturada al final del flujo);
  // clientes.ciudad puede quedar vacía si el cliente ya existía. Preferimos flow_data
  // y caemos a clientes. Subconsulta correlacionada sobre la página (LIMIT) → costo acotado.
  const listSql = `
    SELECT se.*,
      COALESCE(
        (SELECT NULLIF(TRIM(fd.field_value), '')
           FROM ${tFlowData} fd
           WHERE fd.conversation_id = se.chat_conversation_id
             AND fd.empresa_id = se.empresa_id
             AND fd.field_name = 'ciudad'
             AND NULLIF(TRIM(fd.field_value), '') IS NOT NULL
           ORDER BY fd.created_at DESC
           LIMIT 1),
        NULLIF(TRIM(cl.ciudad), '')
      ) AS ciudad
    FROM ${tEnt} se
    LEFT JOIN ${tCli} cl ON cl.id = se.cliente_id AND cl.empresa_id = se.empresa_id
    WHERE ${whereSe} AND ${existsCupon}
    ORDER BY se.created_at DESC NULLS LAST
    LIMIT $${limIdx}::int OFFSET $${offIdx}::int
  `;
  const listArgs = [...baseParams, listParams.limit, listParams.offset];
  const entRes = await pool.query(listSql, listArgs);

  const entradas = (entRes.rows ?? []) as Record<string, unknown>[];
  const entradaIds = entradas.map((r) => String(r.id)).filter(Boolean);

  let cuponesRows: { entrada_id: string; numero_cupon: string }[] = [];
  if (entradaIds.length > 0) {
    const cupRes = await pool.query(
      `SELECT entrada_id, numero_cupon FROM ${tCup}
       WHERE empresa_id = $1::uuid AND entrada_id = ANY($2::uuid[])`,
      [empresaId, entradaIds]
    );
    cuponesRows = cupRes.rows as { entrada_id: string; numero_cupon: string }[];
  }

  const cuponesByEntrada: Record<string, string[]> = {};
  for (const c of cuponesRows) {
    const id = String(c.entrada_id);
    if (!cuponesByEntrada[id]) cuponesByEntrada[id] = [];
    cuponesByEntrada[id].push(c.numero_cupon);
  }

  const sorteoIds = [...new Set(entradas.map((r) => r.sorteo_id).filter(Boolean).map(String))];
  const nombreById: Record<string, string> = {};
  if (sorteoIds.length > 0) {
    const sortRes = await pool.query(
      `SELECT id, nombre FROM ${tSort} WHERE empresa_id = $1::uuid AND id = ANY($2::uuid[])`,
      [empresaId, sorteoIds]
    );
    for (const s of sortRes.rows as { id: string; nombre: string }[]) {
      nombreById[String(s.id)] = s.nombre;
    }
  }

  const mapped = entradas
    .map((raw) => {
      const r = normalizeRowTimestamps(raw);
      const id = String(r.id);
      const numeros = (cuponesByEntrada[id] ?? []).filter(Boolean).sort();
      if (numeros.length === 0) return null;

      const sid = r.sorteo_id != null ? String(r.sorteo_id) : "";
      const sorteoNombre = sid && nombreById[sid] ? nombreById[sid] : "—";

      const mt =
        typeof r.monto_total === "number" && Number.isFinite(r.monto_total)
          ? r.monto_total
          : Number(r.monto_total);
      const montoTotal = Number.isFinite(mt) ? mt : 0;
      const pfRaw = r.precio_fuente;
      const pf = pfRaw === "promo" || pfRaw === "lista" ? pfRaw : null;
      const promoNom = r.promo_nombre;

      const cupImp = r.cupones_impresos_at;
      return {
        entrada_id: id,
        sorteo_id: sid,
        numero_orden: typeof r.numero_orden === "number" ? r.numero_orden : 0,
        nombre_participante: String(r.nombre_participante ?? ""),
        documento:
          typeof r.documento === "string" && r.documento.trim() ? r.documento.trim() : null,
        whatsapp_numero: String(r.whatsapp_numero ?? ""),
        ciudad: typeof r.ciudad === "string" && r.ciudad.trim() ? r.ciudad.trim() : null,
        cantidad_boletos: Number(r.cantidad_boletos ?? 0),
        monto_total: montoTotal,
        promo_nombre:
          typeof promoNom === "string" && promoNom.trim() ? promoNom.trim() : null,
        precio_fuente: pf,
        estado_pago: r.estado_pago as SorteoCuponOrdenRow["estado_pago"],
        created_at: String(r.created_at ?? ""),
        chat_conversation_id:
          r.chat_conversation_id == null ? null : String(r.chat_conversation_id),
        sorteo_nombre: sorteoNombre ?? "—",
        numeros_cupon: numeros,
        cupones_impresos_at:
          cupImp instanceof Date ? cupImp.toISOString() : cupImp != null ? String(cupImp) : null,
      };
    })
    .filter((x): x is SorteoCuponOrdenRow => x !== null);

  return {
    data: mapped,
    error: null,
    total_count,
    page: listParams.page,
    limit: listParams.limit,
  };
}

function handlePgListError(
  e: unknown,
  empresaId: string,
  dataSchema: string,
  fn: string,
  listParams: NormalizedListParams,
  kind: "entradas" | "cupones"
): SorteoEntradasServerResult | SorteoCuponesServerResult {
  const msg =
    e && typeof e === "object" && "message" in e
      ? String((e as { message: unknown }).message)
      : String(e);
  const code =
    e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : undefined;
  const pool = getChatPostgresPool();
  const exhausted = isPgPoolExhaustionMessage(msg);

  console.error(`[sorteos][${kind}-list]`, "pg_error", {
    empresa_id: empresaId,
    schema: dataSchema,
    modo: "postgres_directo",
    archivo: SORTEOS_QUERY_SOURCE,
    sql_error: msg.slice(0, 400),
    sql_code: code,
  });

  if (exhausted && pool) {
    logPgPoolStats(`sorteos_${kind}_list`, pool, {
      schema: dataSchema,
      empresa_id: empresaId,
      funcion: fn,
    });
    console.error(`[sorteos][${kind}-list][pg-pool-exhausted]`, {
      schema: dataSchema,
      empresa_id: empresaId,
      funcion: fn,
      totalCount: pool.totalCount,
      idleCount: pool.idleCount,
      waitingCount: pool.waitingCount,
      max: (pool as unknown as { options?: { max?: number } }).options?.max,
    });
  }

  const emptyBase = {
    error: exhausted ? "Servidor de base de datos saturado; reintentá en unos segundos." : msg,
    total_count: 0,
    page: listParams.page,
    limit: listParams.limit,
    transient_error: exhausted,
  };

  if (kind === "entradas") {
    return { data: [], ...emptyBase } as SorteoEntradasServerResult;
  }
  return { data: [], ...emptyBase } as SorteoCuponesServerResult;
}

async function fetchSorteoEntradasPostgrest(
  empresaId: string,
  dataSchema: string,
  listParams: NormalizedListParams,
  modo: string
): Promise<SorteoEntradasServerResult> {
  const sb = await getChatServiceClientForEmpresa(empresaId);
  const from = listParams.offset;
  const to = listParams.offset + listParams.limit - 1;

  let qb = sb.from("sorteo_entradas").select("*", { count: "exact" }).eq("empresa_id", empresaId);

  if (listParams.sorteoId) qb = qb.eq("sorteo_id", listParams.sorteoId);
  if (listParams.estadoPago) qb = qb.eq("estado_pago", listParams.estadoPago);
  if (listParams.q && listParams.q.length > 0) {
    const t = `%${listParams.q}%`;
    qb = qb.or(`nombre_participante.ilike.${t},documento.ilike.${t},whatsapp_numero.ilike.${t}`);
  }

  const { data: entradas, error: e1, count } = await qb
    .order("created_at", { ascending: false })
    .range(from, to);

  if (e1) {
    console.error("[sorteos][entradas-list]", "error", {
      empresa_id: empresaId,
      schema: dataSchema,
      modo,
      archivo: SORTEOS_QUERY_SOURCE,
      error: e1.message,
    });
    return {
      data: [],
      error: e1.message,
      total_count: 0,
      page: listParams.page,
      limit: listParams.limit,
    };
  }

  const rows = (entradas ?? []) as Record<string, unknown>[];
  const sorteoIds = [...new Set(rows.map((r) => r.sorteo_id).filter(Boolean).map(String))];

  const nombreById: Record<string, string> = {};
  if (sorteoIds.length > 0) {
    const { data: sos, error: e2 } = await sb
      .from("sorteos")
      .select("id, nombre")
      .eq("empresa_id", empresaId)
      .in("id", sorteoIds);

    if (e2) {
      console.error("[sorteos][entradas-list]", "sorteos_lookup", {
        empresa_id: empresaId,
        schema: dataSchema,
        modo,
        error: e2.message,
      });
    } else if (sos) {
      for (const s of sos as { id: string; nombre: string }[]) {
        nombreById[s.id] = s.nombre;
      }
    }
  }

  return {
    data: mapRowsToSorteoEntrada(rows, nombreById),
    error: null,
    total_count: count ?? rows.length,
    page: listParams.page,
    limit: listParams.limit,
  };
}

/**
 * Resuelve ciudad por entrada en el path PostgREST (schemas expuestos como `*_erp`).
 * Fuente: chat_flow_data (field_name ciudad/localidad/ubicacion, último valor válido por
 * conversación) → fallback clientes.ciudad → null. Hace 2 consultas batch (no por fila).
 * `entradaRows` deben traer: id, chat_conversation_id, cliente_id. Devuelve { [entradaId]: ciudad }.
 */
export async function resolveCiudadByEntradaPostgrest(
  sb: Awaited<ReturnType<typeof getChatServiceClientForEmpresa>>,
  empresaId: string,
  entradaRows: Record<string, unknown>[]
): Promise<Record<string, string>> {
  const convIds = [
    ...new Set(
      entradaRows
        .map((r) => (r.chat_conversation_id == null ? "" : String(r.chat_conversation_id).trim()))
        .filter(Boolean)
    ),
  ];
  const cliIds = [
    ...new Set(
      entradaRows.map((r) => (r.cliente_id == null ? "" : String(r.cliente_id).trim())).filter(Boolean)
    ),
  ];

  const byConv: Record<string, string> = {};
  if (convIds.length > 0) {
    const { data, error } = await sb
      .from("chat_flow_data")
      .select("conversation_id, field_value, created_at")
      .eq("empresa_id", empresaId)
      .in("conversation_id", convIds)
      .in("field_name", ["ciudad", "localidad", "ubicacion"])
      .order("created_at", { ascending: false });
    if (error) {
      console.warn("[sorteos][ciudad-postgrest] chat_flow_data:", error.message);
    } else {
      for (const row of (data ?? []) as { conversation_id?: string; field_value?: string }[]) {
        const c = String(row.conversation_id ?? "").trim();
        const v = String(row.field_value ?? "").trim();
        if (c && v && !byConv[c]) byConv[c] = v; // primera = más reciente (orden desc)
      }
    }
  }

  const byCli: Record<string, string> = {};
  if (cliIds.length > 0) {
    const { data, error } = await sb
      .from("clientes")
      .select("id, ciudad")
      .eq("empresa_id", empresaId)
      .in("id", cliIds);
    if (error) {
      console.warn("[sorteos][ciudad-postgrest] clientes:", error.message);
    } else {
      for (const row of (data ?? []) as { id?: string; ciudad?: string | null }[]) {
        const c = String(row.id ?? "").trim();
        const v = String(row.ciudad ?? "").trim();
        if (c && v) byCli[c] = v;
      }
    }
  }

  const out: Record<string, string> = {};
  for (const r of entradaRows) {
    const eid = String(r.id ?? "").trim();
    if (!eid) continue;
    const conv = r.chat_conversation_id == null ? "" : String(r.chat_conversation_id).trim();
    const cli = r.cliente_id == null ? "" : String(r.cliente_id).trim();
    const c = (conv && byConv[conv]) || (cli && byCli[cli]) || "";
    if (c) out[eid] = c;
  }
  return out;
}

async function fetchSorteoCuponesOrdenesPostgrest(
  empresaId: string,
  dataSchema: string,
  listParams: NormalizedListParams,
  modo: string
): Promise<SorteoCuponesServerResult> {
  const sb = await getChatServiceClientForEmpresa(empresaId);
  const from = listParams.offset;
  const to = listParams.offset + listParams.limit - 1;

  let qb = sb
    .from("sorteo_entradas")
    .select("*, sorteo_cupones!inner(entrada_id)", { count: "exact" })
    .eq("empresa_id", empresaId);

  if (listParams.sorteoId) qb = qb.eq("sorteo_id", listParams.sorteoId);
  if (listParams.estadoPago) qb = qb.eq("estado_pago", listParams.estadoPago);
  if (listParams.q && listParams.q.length > 0) {
    const t = `%${listParams.q}%`;
    qb = qb.or(`nombre_participante.ilike.${t},documento.ilike.${t},whatsapp_numero.ilike.${t}`);
  }

  const { data: entradasRaw, error: e1, count } = await qb
    .order("created_at", { ascending: false })
    .range(from, to);

  if (e1) {
    console.error("[sorteos][cupones-list]", "error", {
      empresa_id: empresaId,
      schema: dataSchema,
      modo,
      error: e1.message,
    });
    return {
      data: [],
      error: e1.message,
      total_count: 0,
      page: listParams.page,
      limit: listParams.limit,
    };
  }

  const entradas = (entradasRaw ?? []) as Record<string, unknown>[];
  const entradaIds = entradas.map((r) => String(r.id)).filter(Boolean);

  let cuponesRows: { entrada_id: string; numero_cupon: string }[] = [];
  if (entradaIds.length > 0) {
    const { data: cupones, error: e2 } = await sb
      .from("sorteo_cupones")
      .select("entrada_id, numero_cupon")
      .eq("empresa_id", empresaId)
      .in("entrada_id", entradaIds);

    if (e2) {
      console.error("[sorteos][cupones-list]", "cupones_lookup", {
        empresa_id: empresaId,
        schema: dataSchema,
        modo,
        error: e2.message,
      });
      return {
        data: [],
        error: e2.message,
        total_count: 0,
        page: listParams.page,
        limit: listParams.limit,
      };
    }
    cuponesRows = (cupones ?? []) as { entrada_id: string; numero_cupon: string }[];
  }

  const cuponesByEntrada: Record<string, string[]> = {};
  for (const c of cuponesRows) {
    const id = String(c.entrada_id);
    if (!cuponesByEntrada[id]) cuponesByEntrada[id] = [];
    cuponesByEntrada[id].push(c.numero_cupon);
  }

  const sorteoIds = [...new Set(entradas.map((r) => r.sorteo_id).filter(Boolean).map(String))];
  const nombreById: Record<string, string> = {};
  if (sorteoIds.length > 0) {
    const { data: sos, error: e3 } = await sb
      .from("sorteos")
      .select("id, nombre")
      .eq("empresa_id", empresaId)
      .in("id", sorteoIds);
    if (e3) {
      console.error("[sorteos][cupones-list]", "sorteos_lookup", {
        empresa_id: empresaId,
        schema: dataSchema,
        modo,
        error: e3.message,
      });
    } else if (sos) {
      for (const s of sos as { id: string; nombre: string }[]) {
        nombreById[s.id] = s.nombre;
      }
    }
  }

  // Ciudad (path PostgREST): la fuente más completa es chat_flow_data (capturada al final del
  // flujo); clientes.ciudad puede quedar vacía si el cliente ya existía. Preferimos flow_data por
  // chat_conversation_id y caemos a clientes.ciudad. En batch (no una query por fila).
  const ciudadByEntrada = await resolveCiudadByEntradaPostgrest(sb, empresaId, entradas);

  const mapped = entradas
    .map((raw) => {
      const r = normalizeRowTimestamps(raw);
      const id = String(r.id);
      const numeros = (cuponesByEntrada[id] ?? []).filter(Boolean).sort();
      if (numeros.length === 0) return null;

      const sid = r.sorteo_id != null ? String(r.sorteo_id) : "";
      const sorteoNombre = sid && nombreById[sid] ? nombreById[sid] : "—";

      const mt =
        typeof r.monto_total === "number" && Number.isFinite(r.monto_total)
          ? r.monto_total
          : Number(r.monto_total);
      const montoTotal = Number.isFinite(mt) ? mt : 0;
      const pfRaw = r.precio_fuente;
      const pf = pfRaw === "promo" || pfRaw === "lista" ? pfRaw : null;
      const promoNom = r.promo_nombre;

      const cupImp = r.cupones_impresos_at;
      return {
        entrada_id: id,
        sorteo_id: sid,
        numero_orden: typeof r.numero_orden === "number" ? r.numero_orden : 0,
        nombre_participante: String(r.nombre_participante ?? ""),
        documento:
          typeof r.documento === "string" && r.documento.trim() ? r.documento.trim() : null,
        whatsapp_numero: String(r.whatsapp_numero ?? ""),
        ciudad: typeof r.ciudad === "string" && r.ciudad.trim() ? r.ciudad.trim() : null,
        cantidad_boletos: Number(r.cantidad_boletos ?? 0),
        monto_total: montoTotal,
        promo_nombre:
          typeof promoNom === "string" && promoNom.trim() ? promoNom.trim() : null,
        precio_fuente: pf,
        estado_pago: r.estado_pago as SorteoCuponOrdenRow["estado_pago"],
        created_at: String(r.created_at ?? ""),
        chat_conversation_id:
          r.chat_conversation_id == null ? null : String(r.chat_conversation_id),
        sorteo_nombre: sorteoNombre ?? "—",
        numeros_cupon: numeros,
        cupones_impresos_at:
          cupImp instanceof Date ? cupImp.toISOString() : cupImp != null ? String(cupImp) : null,
      };
    })
    .filter((x): x is SorteoCuponOrdenRow => x !== null);

  // Completar ciudad (path PostgREST) desde el batch chat_flow_data → clientes.
  for (const row of mapped) {
    row.ciudad = ciudadByEntrada[row.entrada_id] ?? null;
  }

  return {
    data: mapped,
    error: null,
    total_count: count ?? mapped.length,
    page: listParams.page,
    limit: listParams.limit,
  };
}

async function runFetchEntradas(
  empresaId: string,
  dataSchema: string,
  listParams: NormalizedListParams
): Promise<SorteoEntradasServerResult> {
  const modo = resolveModoEjecucion(dataSchema);

  console.info("[sorteos][entradas-list][fetch-start]", {
    empresa_id: empresaId,
    schema: dataSchema,
    modo,
    archivo: SORTEOS_QUERY_SOURCE,
    funcion: "fetchSorteoEntradasServer",
    page: listParams.page,
    limit: listParams.limit,
    vercel_env: process.env.VERCEL_ENV ?? null,
    pool_configured: Boolean(getChatPostgresConnectionString()),
  });

  if (isLikelyUnexposedTenantChatSchema(dataSchema)) {
    if (!getChatPostgresConnectionString()) {
      const err =
        "Tenant no expuesto en PostgREST: configure SUPABASE_DB_URL o DIRECT_URL en el servidor para leer sorteo_entradas.";
      console.error("[sorteos][entradas-list]", "tenant_sin_pool", {
        empresa_id: empresaId,
        schema: dataSchema,
        error: err,
      });
      return {
        data: [],
        error: err,
        total_count: 0,
        page: listParams.page,
        limit: listParams.limit,
      };
    }
    try {
      const out = await fetchSorteoEntradasPgDirect(empresaId, dataSchema, listParams);
      console.info("[sorteos][entradas-list][fetch-result]", {
        empresa_id: empresaId,
        schema: dataSchema,
        modo: "postgres_directo",
        total_count: out.total_count,
        rows: out.data.length,
        page: out.page,
        limit: out.limit,
      });
      return out;
    } catch (e) {
      return handlePgListError(e, empresaId, dataSchema, "fetchSorteoEntradasServer", listParams, "entradas") as SorteoEntradasServerResult;
    }
  }

  try {
    const out = await fetchSorteoEntradasPostgrest(empresaId, dataSchema, listParams, modo);
    console.info("[sorteos][entradas-list][fetch-result]", {
      empresa_id: empresaId,
      schema: dataSchema,
      modo: "postgrest_service_role",
      total_count: out.total_count,
      rows: out.data.length,
    });
    return out;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[sorteos][entradas-list]", "catch", {
      empresa_id: empresaId,
      schema: dataSchema,
      error: msg,
    });
    return {
      data: [],
      error: msg,
      total_count: 0,
      page: listParams.page,
      limit: listParams.limit,
    };
  }
}

async function runFetchCupones(
  empresaId: string,
  dataSchema: string,
  listParams: NormalizedListParams
): Promise<SorteoCuponesServerResult> {
  const modo = resolveModoEjecucion(dataSchema);

  console.info("[sorteos][cupones-list][fetch-start]", {
    empresa_id: empresaId,
    schema: dataSchema,
    modo,
    archivo: SORTEOS_QUERY_SOURCE,
    funcion: "fetchSorteoCuponesOrdenesServer",
    page: listParams.page,
    limit: listParams.limit,
    pool_configured: Boolean(getChatPostgresConnectionString()),
  });

  if (isLikelyUnexposedTenantChatSchema(dataSchema)) {
    if (!getChatPostgresConnectionString()) {
      const err =
        "Tenant no expuesto en PostgREST: configure SUPABASE_DB_URL o DIRECT_URL en el servidor para leer sorteo_entradas / sorteo_cupones.";
      console.error("[sorteos][cupones-list]", "tenant_sin_pool", { empresa_id: empresaId, schema: dataSchema, error: err });
      return {
        data: [],
        error: err,
        total_count: 0,
        page: listParams.page,
        limit: listParams.limit,
      };
    }
    try {
      const out = await fetchSorteoCuponesOrdenesPgDirect(empresaId, dataSchema, listParams);
      console.info("[sorteos][cupones-list][fetch-result]", {
        empresa_id: empresaId,
        schema: dataSchema,
        rows: out.data.length,
        total_count: out.total_count,
      });
      return out;
    } catch (e) {
      return handlePgListError(e, empresaId, dataSchema, "fetchSorteoCuponesOrdenesServer", listParams, "cupones") as SorteoCuponesServerResult;
    }
  }

  try {
    const out = await fetchSorteoCuponesOrdenesPostgrest(empresaId, dataSchema, listParams, modo);
    console.info("[sorteos][cupones-list][fetch-result]", {
      empresa_id: empresaId,
      schema: dataSchema,
      rows: out.data.length,
      total_count: out.total_count,
    });
    return out;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[sorteos][cupones-list]", "catch", {
      empresa_id: empresaId,
      schema: dataSchema,
      error: msg,
    });
    return {
      data: [],
      error: msg,
      total_count: 0,
      page: listParams.page,
      limit: listParams.limit,
    };
  }
}

export async function fetchSorteoEntradasServer(
  params?: SorteoEntradasListParams
): Promise<SorteoEntradasServerResult> {
  const empresaId = await getEmpresaIdForCurrentUserServer();
  if (!empresaId) {
    return { data: [], error: "Sin sesión o empresa.", total_count: 0, page: 1, limit: DEFAULT_PAGE_LIMIT };
  }

  const dataSchema = await fetchDataSchemaForEmpresaId(empresaId);
  const listParams = normalizeListParams(params);
  const ck = cacheKeyEntradas(empresaId, dataSchema, listParams);

  const hit = listCache.get(ck);
  if (hit && Date.now() - hit.at < SORTEOS_LIST_CACHE_TTL_MS && !hit.payload.transient_error) {
    return hit.payload as SorteoEntradasServerResult;
  }

  const inflight = listInflight.get(ck);
  if (inflight) return inflight as Promise<SorteoEntradasServerResult>;

  const promise = runFetchEntradas(empresaId, dataSchema, listParams).then((payload) => {
    if (!payload.error && !payload.transient_error) {
      listCache.set(ck, { at: Date.now(), payload });
    }
    return payload;
  });

  listInflight.set(ck, promise);
  void promise.finally(() => listInflight.delete(ck));
  return promise;
}

/** Invalida listas cacheadas de Entradas/Cupones para una empresa tras mutaciones (p. ej. estado de pago). */
export function invalidateSorteosListCachesForEmpresa(empresaId: string, dataSchema: string): void {
  const p1 = `cup:${dataSchema}:${empresaId}:`;
  const p2 = `ent:${dataSchema}:${empresaId}:`;
  for (const k of listCache.keys()) {
    if (k.startsWith(p1) || k.startsWith(p2)) listCache.delete(k);
  }
  for (const k of listInflight.keys()) {
    if (k.startsWith(p1) || k.startsWith(p2)) listInflight.delete(k);
  }
}

// ---------------------------------------------------------------------------
// Ranking de compradores
// ---------------------------------------------------------------------------

/**
 * Estados que cuentan como "compra real" en el ranking: la venta confirmada y la que está en
 * revisión. Se excluyen `anulado` y `rechazado` (no son ventas) y `pendiente` (sin comprobante aún).
 */
const RANKING_ESTADOS: SorteoEntradaEstadoPago[] = ["confirmado", "pendiente_revision"];
const RANKING_DEFAULT_LIMIT = 100;
const RANKING_MAX_LIMIT = 500;
/** Tope de filas al agregar en JS (solo path PostgREST; El Papu usa PG directo). */
const RANKING_POSTGREST_SCAN_CAP = 10000;

export type SorteoRankingParams = {
  sorteoId?: string | null;
  limit?: number;
  q?: string | null;
};

export type SorteoRankingServerResult = {
  data: SorteoCompradorRankingRow[];
  error: string | null;
  transient_error?: boolean;
  /** true si el agregado JS alcanzó el tope y el ranking podría estar incompleto. */
  truncated?: boolean;
};

export type SorteoCompradorComprasServerResult = {
  data: SorteoCompradorCompraRow[];
  error: string | null;
  transient_error?: boolean;
};

function normalizeRankingLimit(raw?: number): number {
  if (!Number.isFinite(raw) || !raw || raw <= 0) return RANKING_DEFAULT_LIMIT;
  return Math.min(RANKING_MAX_LIMIT, Math.max(1, Math.floor(raw as number)));
}

async function fetchRankingPgDirect(
  empresaId: string,
  dataSchema: string,
  sorteoId: string | null,
  limit: number,
  q: string | null
): Promise<SorteoRankingServerResult> {
  const pool = getChatPostgresPool();
  if (!pool) {
    return { data: [], error: "Falta SUPABASE_DB_URL / DIRECT_URL para leer el ranking." };
  }
  const sch = assertAllowedChatDataSchema(dataSchema);
  const tEnt = quoteSchemaTable(sch, "sorteo_entradas");

  const conds: string[] = [
    "empresa_id = $1::uuid",
    "estado_pago = ANY($2::text[])",
    "COALESCE(TRIM(whatsapp_numero), '') <> ''",
  ];
  const params: unknown[] = [empresaId, RANKING_ESTADOS];
  let i = 3;
  if (sorteoId) {
    conds.push(`sorteo_id = $${i}::uuid`);
    params.push(sorteoId);
    i++;
  }
  if (q && q.trim()) {
    const term = `%${q.trim().replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")}%`;
    conds.push(
      `(nombre_participante ILIKE $${i} ESCAPE '\\'
        OR COALESCE(documento::text, '') ILIKE $${i} ESCAPE '\\'
        OR whatsapp_numero ILIKE $${i} ESCAPE '\\')`
    );
    params.push(term);
    i++;
  }
  const limIdx = i;
  params.push(limit);

  const sql = `
    SELECT
      whatsapp_numero,
      (array_agg(nombre_participante ORDER BY created_at DESC))[1] AS nombre_participante,
      (array_agg(NULLIF(TRIM(documento), '') ORDER BY created_at DESC)
         FILTER (WHERE NULLIF(TRIM(documento), '') IS NOT NULL))[1] AS documento,
      COUNT(*)::int AS compras,
      COALESCE(SUM(cantidad_boletos), 0)::int AS total_boletos,
      COALESCE(SUM(monto_total), 0)::numeric AS total_monto,
      MAX(created_at) AS ultima_compra
    FROM ${tEnt}
    WHERE ${conds.join(" AND ")}
    GROUP BY whatsapp_numero
    ORDER BY total_monto DESC, total_boletos DESC, compras DESC
    LIMIT $${limIdx}::int
  `;
  const res = await pool.query(sql, params);
  const data: SorteoCompradorRankingRow[] = (res.rows ?? []).map((raw) => {
    const r = raw as Record<string, unknown>;
    const ua = r.ultima_compra;
    return {
      whatsapp_numero: String(r.whatsapp_numero ?? ""),
      nombre_participante: String(r.nombre_participante ?? "").trim(),
      documento:
        typeof r.documento === "string" && r.documento.trim() ? r.documento.trim() : null,
      compras: Number(r.compras ?? 0) || 0,
      total_boletos: Number(r.total_boletos ?? 0) || 0,
      total_monto: Number(r.total_monto ?? 0) || 0,
      ultima_compra: ua instanceof Date ? ua.toISOString() : ua != null ? String(ua) : null,
    };
  });
  return { data, error: null };
}

async function fetchRankingPostgrest(
  empresaId: string,
  sorteoId: string | null,
  limit: number,
  q: string | null
): Promise<SorteoRankingServerResult> {
  const sb = await getChatServiceClientForEmpresa(empresaId);
  let qb = sb
    .from("sorteo_entradas")
    .select("whatsapp_numero, nombre_participante, documento, cantidad_boletos, monto_total, created_at")
    .eq("empresa_id", empresaId)
    .in("estado_pago", RANKING_ESTADOS);
  if (sorteoId) qb = qb.eq("sorteo_id", sorteoId);
  if (q && q.trim()) {
    const t = `%${q.trim()}%`;
    qb = qb.or(`nombre_participante.ilike.${t},documento.ilike.${t},whatsapp_numero.ilike.${t}`);
  }
  const { data, error } = await qb
    .order("created_at", { ascending: false })
    .range(0, RANKING_POSTGREST_SCAN_CAP - 1);
  if (error) return { data: [], error: error.message };

  const rows = (data ?? []) as Record<string, unknown>[];
  const truncated = rows.length >= RANKING_POSTGREST_SCAN_CAP;
  const byPhone = new Map<string, SorteoCompradorRankingRow>();
  for (const r of rows) {
    const phone = String(r.whatsapp_numero ?? "").trim();
    if (!phone) continue;
    const mt = Number(r.monto_total ?? 0) || 0;
    const bol = Number(r.cantidad_boletos ?? 0) || 0;
    const createdAt = r.created_at != null ? String(r.created_at) : null;
    const existing = byPhone.get(phone);
    if (!existing) {
      // rows vienen ordenadas por created_at desc → la primera es la más reciente (nombre/doc).
      byPhone.set(phone, {
        whatsapp_numero: phone,
        nombre_participante: String(r.nombre_participante ?? "").trim(),
        documento:
          typeof r.documento === "string" && r.documento.trim() ? r.documento.trim() : null,
        compras: 1,
        total_boletos: bol,
        total_monto: mt,
        ultima_compra: createdAt,
      });
    } else {
      existing.compras += 1;
      existing.total_boletos += bol;
      existing.total_monto += mt;
      if (!existing.documento && typeof r.documento === "string" && r.documento.trim()) {
        existing.documento = r.documento.trim();
      }
    }
  }
  const sorted = [...byPhone.values()]
    .sort(
      (a, b) =>
        b.total_monto - a.total_monto ||
        b.total_boletos - a.total_boletos ||
        b.compras - a.compras
    )
    .slice(0, limit);
  return { data: sorted, error: null, truncated };
}

/**
 * Ranking de compradores: agrupa `sorteo_entradas` por número de WhatsApp y acumula
 * compras, boletas y monto. Prefiere PG directo (agregación en la base) cuando hay pool;
 * si no, cae a PostgREST agregando en memoria (con tope). Solo lectura.
 */
export async function fetchSorteoCompradoresRankingServer(
  params?: SorteoRankingParams
): Promise<SorteoRankingServerResult> {
  const empresaId = await getEmpresaIdForCurrentUserServer();
  if (!empresaId) return { data: [], error: "Sin sesión o empresa." };

  const dataSchema = await fetchDataSchemaForEmpresaId(empresaId);
  const sorteoId = params?.sorteoId?.trim() || null;
  const limit = normalizeRankingLimit(params?.limit);
  const q = params?.q?.trim() || null;

  try {
    // Para una agregación GROUP BY conviene siempre la base: si hay pool, PG directo.
    if (getChatPostgresPool()) {
      return await fetchRankingPgDirect(empresaId, dataSchema, sorteoId, limit, q);
    }
    return await fetchRankingPostgrest(empresaId, sorteoId, limit, q);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const transient = isPgPoolExhaustionMessage(msg);
    console.error("[sorteos][ranking]", "error", {
      empresa_id: empresaId,
      schema: dataSchema,
      error: msg.slice(0, 400),
    });
    return {
      data: [],
      error: transient ? "Servidor de base de datos saturado; reintentá en unos segundos." : msg,
      transient_error: transient,
    };
  }
}

/**
 * Compras de un comprador (por número de WhatsApp) con su comprobante, para auditar.
 * Devuelve TODAS las compras (incluye anuladas/rechazadas) para control. Solo lectura.
 */
export async function fetchSorteoComprasByWhatsappServer(
  whatsappNumero: string,
  sorteoId?: string | null
): Promise<SorteoCompradorComprasServerResult> {
  const phone = (whatsappNumero ?? "").trim();
  if (!phone) return { data: [], error: "Falta el número de WhatsApp." };

  const empresaId = await getEmpresaIdForCurrentUserServer();
  if (!empresaId) return { data: [], error: "Sin sesión o empresa." };

  const dataSchema = await fetchDataSchemaForEmpresaId(empresaId);
  const sid = sorteoId?.trim() || null;

  const mapRow = (raw: Record<string, unknown>, nombreById: Record<string, string>): SorteoCompradorCompraRow => {
    const r = normalizeRowTimestamps(raw);
    const sidRow = r.sorteo_id != null ? String(r.sorteo_id) : "";
    return {
      entrada_id: String(r.id ?? ""),
      numero_orden: typeof r.numero_orden === "number" ? r.numero_orden : r.numero_orden != null ? Number(r.numero_orden) || null : null,
      sorteo_nombre: (sidRow && nombreById[sidRow]) || "—",
      cantidad_boletos: Number(r.cantidad_boletos ?? 0) || 0,
      monto_total: Number(r.monto_total ?? 0) || 0,
      estado_pago: r.estado_pago as SorteoEntradaEstadoPago,
      comprobante_url:
        typeof r.comprobante_url === "string" && r.comprobante_url.trim()
          ? r.comprobante_url.trim()
          : null,
      created_at: String(r.created_at ?? ""),
    };
  };

  try {
    if (getChatPostgresPool()) {
      const pool = getChatPostgresPool()!;
      const sch = assertAllowedChatDataSchema(dataSchema);
      const tEnt = quoteSchemaTable(sch, "sorteo_entradas");
      const tSort = quoteSchemaTable(sch, "sorteos");
      const conds = ["empresa_id = $1::uuid", "whatsapp_numero = $2::text"];
      const args: unknown[] = [empresaId, phone];
      if (sid) {
        conds.push("sorteo_id = $3::uuid");
        args.push(sid);
      }
      const res = await pool.query(
        `SELECT id, sorteo_id, numero_orden, cantidad_boletos, monto_total, estado_pago, comprobante_url, created_at
           FROM ${tEnt}
          WHERE ${conds.join(" AND ")}
          ORDER BY created_at DESC
          LIMIT 300`,
        args
      );
      const rows = (res.rows ?? []) as Record<string, unknown>[];
      const sorteoIds = [...new Set(rows.map((r) => r.sorteo_id).filter(Boolean).map(String))];
      const nombreById: Record<string, string> = {};
      if (sorteoIds.length > 0) {
        const sortRes = await pool.query(
          `SELECT id, nombre FROM ${tSort} WHERE empresa_id = $1::uuid AND id = ANY($2::uuid[])`,
          [empresaId, sorteoIds]
        );
        for (const s of sortRes.rows as { id: string; nombre: string }[]) nombreById[String(s.id)] = s.nombre;
      }
      return { data: rows.map((r) => mapRow(r, nombreById)), error: null };
    }

    const sb = await getChatServiceClientForEmpresa(empresaId);
    let qb = sb
      .from("sorteo_entradas")
      .select("id, sorteo_id, numero_orden, cantidad_boletos, monto_total, estado_pago, comprobante_url, created_at")
      .eq("empresa_id", empresaId)
      .eq("whatsapp_numero", phone);
    if (sid) qb = qb.eq("sorteo_id", sid);
    const { data, error } = await qb.order("created_at", { ascending: false }).range(0, 299);
    if (error) return { data: [], error: error.message };
    const rows = (data ?? []) as Record<string, unknown>[];
    const sorteoIds = [...new Set(rows.map((r) => r.sorteo_id).filter(Boolean).map(String))];
    const nombreById: Record<string, string> = {};
    if (sorteoIds.length > 0) {
      const { data: sos } = await sb.from("sorteos").select("id, nombre").eq("empresa_id", empresaId).in("id", sorteoIds);
      for (const s of (sos ?? []) as { id: string; nombre: string }[]) nombreById[s.id] = s.nombre;
    }
    return { data: rows.map((r) => mapRow(r, nombreById)), error: null };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const transient = isPgPoolExhaustionMessage(msg);
    console.error("[sorteos][ranking-compras]", "error", {
      empresa_id: empresaId,
      schema: dataSchema,
      error: msg.slice(0, 400),
    });
    return {
      data: [],
      error: transient ? "Servidor de base de datos saturado; reintentá en unos segundos." : msg,
      transient_error: transient,
    };
  }
}

export async function fetchSorteoCuponesOrdenesServer(
  params?: SorteoEntradasListParams
): Promise<SorteoCuponesServerResult> {
  const empresaId = await getEmpresaIdForCurrentUserServer();
  if (!empresaId) {
    return { data: [], error: "Sin sesión o empresa.", total_count: 0, page: 1, limit: DEFAULT_PAGE_LIMIT };
  }

  const dataSchema = await fetchDataSchemaForEmpresaId(empresaId);
  const listParams = normalizeListParams(params);
  const ck = cacheKeyCupones(empresaId, dataSchema, listParams);

  const hit = listCache.get(ck);
  if (hit && Date.now() - hit.at < SORTEOS_LIST_CACHE_TTL_MS && !hit.payload.transient_error) {
    return hit.payload as SorteoCuponesServerResult;
  }

  const inflight = listInflight.get(ck);
  if (inflight) return inflight as Promise<SorteoCuponesServerResult>;

  const promise = runFetchCupones(empresaId, dataSchema, listParams).then((payload) => {
    if (!payload.error && !payload.transient_error) {
      listCache.set(ck, { at: Date.now(), payload });
    }
    return payload;
  });

  listInflight.set(ck, promise);
  void promise.finally(() => listInflight.delete(ck));
  return promise;
}
