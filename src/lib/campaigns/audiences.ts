import "server-only";
import { getChatPostgresPool, quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";

/**
 * Audiencias para campañas: arma listas de teléfonos según comportamiento (escribió, compró, no compró…)
 * en un período. Solo lectura, con timeout. Los teléfonos se normalizan igual que en el resto del ERP
 * (sin 595, sin ceros adelante) para cruzar chat con ventas aunque estén cargados distinto.
 */

export const AUDIENCE_KINDS = [
  "interactuaron",
  "no_compraron",
  "compraron",
  "comprobante_pendiente",
  "tocaron_boton",
  "respondieron_campana",
  "compraron_otro_sorteo",
  "abandonaron",
] as const;
export type AudienceKind = (typeof AUDIENCE_KINDS)[number];

export const PERIOD_PRESETS = ["hoy", "ayer", "ultimos_7", "ultimos_30", "sorteo_actual", "todo", "personalizado"] as const;
export type PeriodPreset = (typeof PERIOD_PRESETS)[number];

/** Períodos por días: aceptan hora de inicio (primer día) y hora de fin (último día). */
export const PERIODS_CON_HORA: readonly PeriodPreset[] = ["hoy", "ayer", "ultimos_7", "ultimos_30", "personalizado"];

export type AudienceFilters = {
  /** Uno o más tipos: la audiencia es la suma (sin repetir personas). */
  kinds: AudienceKind[];
  period: PeriodPreset;
  desde?: string | null;
  hasta?: string | null;
  /** "HH:MM" opcional: hora de inicio del primer día del período. */
  horaDesde?: string | null;
  /** "HH:MM" opcional: hora de fin (incluida) del último día del período. */
  horaHasta?: string | null;
  /** Uno o más sorteos (vacío = sin filtro de sorteo). */
  sorteoIds: string[];
  campaignId?: string | null;
  excluirPendientes?: boolean;
  excluirTelefonos?: string[];
  agregarTelefonos?: string[];
  /** Solo `compraron_otro_sorteo`: sorteos donde SÍ compraron (los de `sorteoIds` son donde NO). */
  sorteoAnteriorIds: string[];
  /** Rango de boletas compradas (suma por persona). Aplica a los tipos basados en compras. */
  boletasMin?: number | null;
  boletasMax?: number | null;
  /** Saca a quienes recibieron cualquier campaña en las últimas N horas (para no saturar). */
  excluirCampanaHoras?: number | null;
};

/** Tipos de audiencia que se calculan a partir de compras y aceptan el filtro de boletas. */
export const KINDS_CON_BOLETAS: readonly AudienceKind[] = ["compraron", "comprobante_pendiente", "compraron_otro_sorteo"];

/** Tipos que no miran el período (comparan sorteos completos). */
const KINDS_SIN_PERIODO: readonly AudienceKind[] = ["compraron_otro_sorteo"];

export type AudienceRow = { telefono: string; nombre: string; ultimo: string | null; detalle: string | null };

const TZ = "America/Asuncion";
const MAX_ROWS = 15000;

const NAT = (col: string) => `ltrim(regexp_replace(regexp_replace(${col},'\\D','','g'),'^595',''),'0')`;

function isUuid(s: string | null | undefined): s is string {
  return !!s && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}
function isDate(s: string | null | undefined): s is string {
  return !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
}
/** "HH:MM" → minutos desde 00:00, o null si no es una hora válida. */
function minutosDeHora(s: string | null | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec((s ?? "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h <= 23 && min <= 59 ? h * 60 + min : null;
}

export function normalizeNat(raw: string): string {
  return raw.replace(/\D/g, "").replace(/^595/, "").replace(/^0+/, "");
}

export function parseAudienceFilters(body: Record<string, unknown>): AudienceFilters {
  const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  /** Acepta lista (`kinds`, `sorteo_ids`…) y también el campo suelto viejo (`kind`, `sorteo_id`…). */
  const list = (many: unknown, one: unknown): string[] => [
    ...new Set([...(Array.isArray(many) ? many : []), one].map(s).filter(Boolean)),
  ];
  return {
    kinds: list(body.kinds, body.kind) as AudienceKind[],
    period: s(body.period) as PeriodPreset,
    desde: s(body.desde) || null,
    hasta: s(body.hasta) || null,
    horaDesde: s(body.hora_desde) || null,
    horaHasta: s(body.hora_hasta) || null,
    sorteoIds: list(body.sorteo_ids, body.sorteo_id),
    campaignId: s(body.campaign_id) || null,
    excluirPendientes: body.excluir_pendientes !== false,
    excluirTelefonos: phoneList(body.excluir_telefonos),
    agregarTelefonos: phoneList(body.agregar_telefonos),
    sorteoAnteriorIds: list(body.sorteo_anterior_ids, body.sorteo_anterior_id),
    boletasMin: intOrNull(body.boletas_min),
    boletasMax: intOrNull(body.boletas_max),
    excluirCampanaHoras: intOrNull(body.excluir_campana_horas),
  };
}

/** Entero ≥ 0 o null si viene vacío; NaN si viene algo que no es un entero (lo rechaza la validación). */
function intOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).trim());
  return Number.isInteger(n) && n >= 0 ? n : NaN;
}

function phoneList(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  if (typeof v !== "string") return [];
  // Separadores: renglón, coma o punto y coma. Los espacios solo separan si el trozo tiene más de un número
  // (un celular PY con 595 tiene 12 dígitos), así "0981 772 872" queda como un solo número.
  return v
    .split(/[\n,;]+/)
    .flatMap((chunk) => (chunk.replace(/\D/g, "").length > 12 ? chunk.split(/\s+/) : [chunk]))
    .map((x) => x.trim())
    .filter(Boolean);
}

export function validateAudienceFilters(f: AudienceFilters): string | null {
  if (f.kinds.length === 0 || !f.kinds.every((k) => AUDIENCE_KINDS.includes(k))) return "Elegí qué personas querés.";
  const usaPeriodo = f.kinds.some((k) => !KINDS_SIN_PERIODO.includes(k));
  if (usaPeriodo) {
    if (!PERIOD_PRESETS.includes(f.period)) return "Elegí un período.";
    if (f.period === "personalizado" && (!isDate(f.desde) || !isDate(f.hasta))) return "Completá las fechas desde y hasta.";
    if (f.period === "personalizado" && f.desde! > f.hasta!) return "La fecha desde no puede ser posterior a la fecha hasta.";
    if (f.period === "sorteo_actual" && f.sorteoIds.length === 0) return "Elegí al menos un sorteo.";
    if (f.horaDesde && minutosDeHora(f.horaDesde) == null) return "La hora de inicio no es válida (HH:MM).";
    if (f.horaHasta && minutosDeHora(f.horaHasta) == null) return "La hora de fin no es válida (HH:MM).";
    const unSoloDia =
      f.period === "hoy" || f.period === "ayer" || (f.period === "personalizado" && f.desde === f.hasta);
    const md = minutosDeHora(f.horaDesde);
    const mh = minutosDeHora(f.horaHasta);
    if (unSoloDia && md != null && mh != null && md > mh)
      return "En un solo día, la hora de inicio no puede ser posterior a la de fin.";
  }
  if (f.kinds.some((k) => k === "tocaron_boton" || k === "respondieron_campana") && !isUuid(f.campaignId))
    return "Elegí la campaña.";
  if (!f.sorteoIds.every(isUuid) || !f.sorteoAnteriorIds.every(isUuid)) return "Sorteo inválido.";
  if (f.kinds.includes("compraron_otro_sorteo")) {
    if (f.sorteoAnteriorIds.length === 0) return "Elegí al menos un sorteo donde compraron.";
    if (f.sorteoIds.length === 0) return "Elegí al menos un sorteo donde todavía no compraron.";
    if (f.sorteoAnteriorIds.some((id) => f.sorteoIds.includes(id)))
      return "Un mismo sorteo no puede estar en \"compraron en\" y en \"todavía no compraron en\".";
  }
  if (Number.isNaN(f.boletasMin) || Number.isNaN(f.boletasMax)) return "Las boletas tienen que ser un número entero.";
  if (f.boletasMin != null && f.boletasMax != null && f.boletasMin > f.boletasMax)
    return "El mínimo de boletas no puede ser mayor que el máximo.";
  if (Number.isNaN(f.excluirCampanaHoras) || (f.excluirCampanaHoras != null && f.excluirCampanaHoras > 720))
    return "Las horas para excluir campañas tienen que ser un número entre 1 y 720.";
  return null;
}

/** Arma la consulta. Los valores van como parámetros; solo se interpolan nombres de tablas ya validados y fragmentos fijos. */
function buildQuery(schema: string, empresaId: string, f: AudienceFilters, limit: number) {
  const t = (name: string) => quoteSchemaTable(schema, name);
  const params: unknown[] = [empresaId];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };

  const dayStart = `(date_trunc('day', now() AT TIME ZONE '${TZ}') AT TIME ZONE '${TZ}')`;
  let desde = "'-infinity'::timestamptz";
  let hasta = "'infinity'::timestamptz";
  /** Inicio (00:00 Paraguay) del primer y del último día, para los períodos por días. */
  let primerDia: string | null = null;
  let ultimoDia: string | null = null;
  switch (f.period) {
    case "hoy":
      primerDia = dayStart;
      ultimoDia = dayStart;
      break;
    case "ayer":
      primerDia = `(${dayStart} - interval '1 day')`;
      ultimoDia = primerDia;
      break;
    case "ultimos_7":
      primerDia = `(${dayStart} - interval '6 days')`;
      ultimoDia = dayStart;
      break;
    case "ultimos_30":
      primerDia = `(${dayStart} - interval '29 days')`;
      ultimoDia = dayStart;
      break;
    case "sorteo_actual":
      // Con varios sorteos: desde que empezó el más viejo de los elegidos.
      desde = `(SELECT MIN(created_at) FROM ${t("sorteos")} WHERE id = ANY(${p(f.sorteoIds)}::uuid[]))`;
      break;
    case "personalizado":
      primerDia = `(${p(f.desde)}::date::timestamp AT TIME ZONE '${TZ}')`;
      ultimoDia = `(${p(f.hasta)}::date::timestamp AT TIME ZONE '${TZ}')`;
      break;
  }
  if (primerDia && ultimoDia) {
    // Sin horas: día completo (00:00 del primero a 00:00 del día siguiente al último).
    // Con horas: la de inicio corre el comienzo del primer día; la de fin (incluido ese minuto) el final del último.
    const md = minutosDeHora(f.horaDesde);
    const mh = minutosDeHora(f.horaHasta);
    desde = md != null ? `(${primerDia} + make_interval(mins => ${p(md)}::int))` : primerDia;
    hasta =
      mh != null ? `(${ultimoDia} + make_interval(mins => ${p(mh + 1)}::int))` : `(${ultimoDia} + interval '1 day')`;
  }
  const inRange = (col: string) => `${col} >= (SELECT desde FROM rango) AND ${col} < (SELECT hasta FROM rango)`;
  /**
   * Se arma recién al usarse: un parámetro que se agrega y no aparece en el SQL hace fallar la consulta
   * ("could not determine data type of parameter"), por ejemplo en tipos que no miran compras.
   */
  const haySorteo = f.sorteoIds.length > 0;
  const sorteoFilter = () => (haySorteo ? `AND e.sorteo_id = ANY(${p(f.sorteoIds)}::uuid[])` : "");

  const interactuaron = `
    SELECT ${NAT("ct.phone_number")} AS nat, MAX(NULLIF(trim(ct.name), '')) AS nombre,
           MAX(m.created_at) AS ultimo, NULL::text AS detalle
      FROM ${t("chat_messages")} m
      JOIN ${t("chat_conversations")} cv ON cv.id = m.conversation_id
      JOIN ${t("chat_contacts")} ct ON ct.id = cv.contact_id
     WHERE m.empresa_id = $1::uuid AND m.from_me = false AND ${inRange("m.created_at")}
     GROUP BY 1`;

  /** Filtro de boletas (suma por persona). Se arma por consulta para no dejar parámetros sin usar. */
  const having = () => {
    const parts: string[] = [];
    if (f.boletasMin != null) parts.push(`SUM(e.cantidad_boletos) >= ${p(f.boletasMin)}::int`);
    if (f.boletasMax != null) parts.push(`SUM(e.cantidad_boletos) <= ${p(f.boletasMax)}::int`);
    return parts.length ? `HAVING ${parts.join(" AND ")}` : "";
  };

  /** Compras agrupadas por persona. `filtro` reemplaza al de período + sorteo cuando hace falta otro criterio. */
  const entradas = (estados: string, fechaCol: string, filtro = `AND ${inRange(fechaCol)} ${sorteoFilter()}`) => `
    SELECT ${NAT("e.whatsapp_numero")} AS nat, MAX(NULLIF(trim(e.nombre_participante), '')) AS nombre,
           MAX(${fechaCol}) AS ultimo,
           SUM(e.cantidad_boletos)::text || ' boleta(s) · Gs ' || replace(to_char(SUM(e.monto_total), 'FM999,999,999'), ',', '.') AS detalle
      FROM ${t("sorteo_entradas")} e
     WHERE e.empresa_id = $1::uuid AND e.estado_pago IN ${estados} ${filtro}
     GROUP BY 1 ${having()}`;

  /** Saca de `inner` a quienes compraron (en el sorteo elegido, o si no hay sorteo, dentro del período). */
  const sinCompra = (inner: string, sorteoSql: string, ventanaSql: string) => {
    const estados = f.excluirPendientes === false ? "('confirmado')" : "('confirmado','pendiente_revision')";
    // Compradores calculados una sola vez y descontados con un anti-join (un NOT EXISTS correlacionado
    // recalculaba el teléfono normalizado de todas las compras por cada persona y tardaba demasiado).
    return `
        SELECT i.* FROM (${inner}) i
          LEFT JOIN (
            SELECT DISTINCT ${NAT("e.whatsapp_numero")} AS nat
              FROM ${t("sorteo_entradas")} e
             WHERE e.empresa_id = $1::uuid AND e.estado_pago IN ${estados} ${sorteoSql} ${ventanaSql}
          ) comp ON comp.nat = i.nat
         WHERE comp.nat IS NULL`;
  };

  // Sin sorteo elegido, "no compró" se mira dentro del período.
  const ventanaSinSorteo = () => (haySorteo ? "" : `AND ${inRange("COALESCE(e.fecha_pago, e.created_at)")}`);

  const baseDe = (kind: AudienceKind): string => {
    let base = "";
    switch (kind) {
      case "interactuaron":
        base = interactuaron;
        break;
      case "compraron":
        base = entradas("('confirmado')", "COALESCE(e.fecha_pago, e.created_at)");
        break;
      case "comprobante_pendiente":
        base = entradas("('pendiente_revision')", "e.created_at");
        break;
      case "compraron_otro_sorteo": {
        // Compraron (confirmado o comprobante enviado) en el sorteo anterior, en cualquier fecha…
        const anterior = entradas(
          "('confirmado','pendiente_revision')",
          "COALESCE(e.fecha_pago, e.created_at)",
          `AND e.sorteo_id = ANY(${p(f.sorteoAnteriorIds)}::uuid[])`
        );
        // …y no compraron nunca en el sorteo elegido.
        base = sinCompra(anterior, sorteoFilter(), "");
        break;
      }
      case "abandonaron": {
        // Tocaron un combo (opción con cantidad) en el período y no terminaron de comprar.
        const eligieron = `
          SELECT ${NAT("ct.phone_number")} AS nat, MAX(NULLIF(trim(ct.name), '')) AS nombre,
                 MAX(ev.created_at) AS ultimo,
                 'Eligió ' || (array_agg(o.label ORDER BY ev.created_at DESC))[1] AS detalle
            FROM ${t("chat_flow_events")} ev
            JOIN ${t("chat_flow_options")} o ON o.id = ev.selected_option_id
            JOIN ${t("chat_conversations")} cv ON cv.id = ev.conversation_id
            JOIN ${t("chat_contacts")} ct ON ct.id = cv.contact_id
           WHERE ev.empresa_id = $1::uuid AND ev.event_type = 'button_selected'
             AND o.option_payload ? 'cantidad' AND ${inRange("ev.created_at")}
           GROUP BY 1`;
        base = sinCompra(eligieron, sorteoFilter(), ventanaSinSorteo());
        break;
      }
      case "no_compraron":
        // Con sorteo elegido: no compró en ese sorteo (en cualquier fecha). Sin sorteo: no compró dentro del período.
        base = sinCompra(interactuaron, sorteoFilter(), ventanaSinSorteo());
        break;
      case "tocaron_boton":
        base = `
          SELECT ${NAT("ct.phone_number")} AS nat, MAX(NULLIF(trim(ct.name), '')) AS nombre,
                 MAX(ev.created_at) AS ultimo, NULL::text AS detalle
            FROM ${t("chat_campaign_events")} ev
            JOIN ${t("chat_contacts")} ct ON ct.id = (ev.event_payload_json->>'contact_id')::uuid
           WHERE ev.empresa_id = $1::uuid AND ev.campaign_id = ${p(f.campaignId)}::uuid
             AND ev.event_type = 'campaign_button_action_executed' AND ${inRange("ev.created_at")}
           GROUP BY 1`;
        break;
      case "respondieron_campana":
        base = `
          SELECT ${NAT("r.phone_e164")} AS nat, MAX(NULLIF(trim(r.row_payload_json->>'nombre'), '')) AS nombre,
                 MAX(r.first_reply_at) AS ultimo, NULL::text AS detalle
            FROM ${t("chat_campaign_recipients")} r
           WHERE r.empresa_id = $1::uuid AND r.campaign_id = ${p(f.campaignId)}::uuid
             AND r.first_reply_at IS NOT NULL AND ${inRange("r.first_reply_at")}
           GROUP BY 1`;
        break;
    }
    return base;
  };

  /**
   * Compraron + comprobante pendiente juntos van en UNA consulta de compras: así el filtro de boletas
   * suma las aprobadas y las pendientes de la misma persona. (Para pendientes `fecha_pago` es null,
   * así que `COALESCE(fecha_pago, created_at)` es la misma fecha que usa ese tipo solo.)
   */
  let kinds = [...new Set(f.kinds)];
  const bases: string[] = [];
  if (kinds.includes("compraron") && kinds.includes("comprobante_pendiente")) {
    bases.push(entradas("('confirmado','pendiente_revision')", "COALESCE(e.fecha_pago, e.created_at)"));
    kinds = kinds.filter((k) => k !== "compraron" && k !== "comprobante_pendiente");
  }
  for (const k of kinds) bases.push(baseDe(k));
  const base =
    bases.length === 1
      ? bases[0]
      : `SELECT u.nat, MAX(u.nombre) AS nombre, MAX(u.ultimo) AS ultimo,
                string_agg(DISTINCT u.detalle, ' · ') AS detalle
           FROM (${bases.map((b) => `(${b})`).join("\n UNION ALL \n")}) u
          GROUP BY u.nat`;

  const excl = (f.excluirTelefonos ?? []).map(normalizeNat).filter((x) => x.length >= 6);
  const exclSql = excl.length ? `AND b.nat <> ALL(${p(excl)}::text[])` : "";
  const horas = f.excluirCampanaHoras;
  const exclCampanaSql =
    horas != null && horas > 0
      ? `AND b.nat NOT IN (
           SELECT ${NAT("r.phone_e164")} FROM ${t("chat_campaign_recipients")} r
            WHERE r.empresa_id = $1::uuid AND r.phone_e164 IS NOT NULL AND r.sent_at > now() - make_interval(hours => ${p(horas)}::int))`
      : "";
  // Agregados a mano: siempre entran (aunque estén en "excluir"), primero en la lista y sin duplicarse.
  const extra = [...new Set((f.agregarTelefonos ?? []).map(normalizeNat).filter((x) => x.length >= 6))];
  const extraParam = p(extra);

  const sql = `
    WITH rango AS (SELECT ${desde} AS desde, ${hasta} AS hasta),
         b AS (${base}),
         man AS (SELECT DISTINCT x.nat FROM unnest(${extraParam}::text[]) AS x(nat) WHERE x.nat ~ '^9[0-9]{8}$'),
         todos AS (
           SELECT b.nat, b.nombre, b.ultimo, b.detalle, false AS manual
             FROM b
            WHERE b.nat ~ '^9[0-9]{8}$' ${exclSql} ${exclCampanaSql} AND b.nat NOT IN (SELECT nat FROM man)
           UNION ALL
           SELECT man.nat, NULL, NULL::timestamptz, 'Agregado a mano', true FROM man
         )
    SELECT '595' || t.nat AS telefono, COALESCE(t.nombre, '') AS nombre,
           to_char(t.ultimo AT TIME ZONE '${TZ}', 'DD/MM/YYYY HH24:MI') AS ultimo, t.detalle,
           COUNT(*) OVER () AS total
      FROM todos t
     ORDER BY t.manual DESC, t.ultimo DESC NULLS LAST
     LIMIT ${Math.max(1, Math.min(limit, MAX_ROWS))}`;
  return { sql, params };
}

export async function runAudience(
  empresaId: string,
  f: AudienceFilters,
  limit: number
): Promise<{ total: number; rows: AudienceRow[] }> {
  const pool = getChatPostgresPool();
  if (!pool) throw new Error("Sin conexión directa a la base para calcular audiencias.");
  const schema = await fetchDataSchemaForEmpresaId(empresaId);
  const { sql, params } = buildQuery(schema, empresaId, f, limit);

  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout = '25s'");
    const r = await client.query<AudienceRow & { total: string }>(sql, params);
    await client.query("COMMIT");
    return {
      total: r.rows.length ? Number(r.rows[0].total) : 0,
      rows: r.rows.map(({ telefono, nombre, ultimo, detalle }) => ({ telefono, nombre, ultimo, detalle })),
    };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function listAudienceOptions(empresaId: string): Promise<{
  sorteos: Array<{ id: string; nombre: string; estado: string; created_at: string }>;
  campaigns: Array<{ id: string; name: string; status: string; created_at: string }>;
}> {
  const pool = getChatPostgresPool();
  if (!pool) return { sorteos: [], campaigns: [] };
  const schema = await fetchDataSchemaForEmpresaId(empresaId);
  const [s, c] = await Promise.all([
    pool.query(
      `SELECT id::text, nombre, estado, created_at::text FROM ${quoteSchemaTable(schema, "sorteos")}
        WHERE empresa_id = $1::uuid ORDER BY (estado = 'activo') DESC, created_at DESC LIMIT 50`,
      [empresaId]
    ),
    pool.query(
      `SELECT id::text, name, status, created_at::text FROM ${quoteSchemaTable(schema, "chat_campaigns")}
        WHERE empresa_id = $1::uuid ORDER BY created_at DESC LIMIT 100`,
      [empresaId]
    ),
  ]);
  return { sorteos: s.rows, campaigns: c.rows };
}

export const AUDIENCE_LABEL: Record<AudienceKind, string> = {
  interactuaron: "Escribieron al bot",
  no_compraron: "Escribieron y no compraron",
  compraron: "Compraron",
  comprobante_pendiente: "Comprobante pendiente",
  tocaron_boton: "Tocaron el botón de una campaña",
  respondieron_campana: "Respondieron una campaña",
  compraron_otro_sorteo: "Compraron en otro sorteo y no en este",
  abandonaron: "Eligieron un combo y no compraron",
};
