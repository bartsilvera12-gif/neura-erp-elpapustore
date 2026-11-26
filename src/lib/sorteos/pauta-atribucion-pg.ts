import "server-only";

import type { Pool } from "pg";
import { quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";

export type PautaResumen = {
  personas: number;
  compraron: number;
  boletas: number;
  monto: number;
  conversion: number;
};

export type PautaAnuncio = {
  ad_id: string;
  headline: string | null;
  desde: string;
  hasta: string;
  personas: number;
  compraron: number;
  boletas: number;
  monto: number;
  conversion: number;
};

export type PautaDia = { dia: string; entraron: number; compraron: number; boletas: number };

export type PautaComprador = {
  nombre: string;
  telefono: string | null;
  boletas: number;
  monto: number;
  cuando: string;
  ad_id: string;
};

export type PautaAtribucion = {
  resumen: PautaResumen;
  porAnuncio: PautaAnuncio[];
  porDia: PautaDia[];
  compradores: PautaComprador[];
};

/**
 * Sorteo activo más reciente; null si no hay ninguno. Vive acá porque El Papu no tiene el módulo
 * de ranking de revendedores de donde la importa Grupo BIRM, y es la única pieza que faltaba.
 */
export async function sorteoActivoMasReciente(
  pool: Pool,
  schema: string,
  empresaId: string
): Promise<{ id: string; nombre: string } | null> {
  const t = quoteSchemaTable(schema, "sorteos");
  const r = await pool.query<{ id: string; nombre: string }>(
    `SELECT id::text AS id, nombre
       FROM ${t}
      WHERE empresa_id = $1::uuid AND estado = 'activo'
      ORDER BY created_at DESC
      LIMIT 1`,
    [empresaId]
  );
  const row = r.rows[0];
  return row ? { id: String(row.id), nombre: String(row.nombre ?? "") } : null;
}

/** Teléfono normalizado: solo dígitos, sin prefijo país 595 ni ceros a la izquierda. */
const NAT = (col: string) => `ltrim(regexp_replace(regexp_replace(${col},'\\D','','g'),'^595',''),'0')`;

/** Día calendario Paraguay (UTC-3) de un timestamptz, como 'YYYY-MM-DD'. */
function pyDay(d: unknown): string {
  return new Date(new Date(d as string).getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * Atribución de ventas a pauta (anuncios Click-to-WhatsApp de Meta). SOLO LECTURA.
 *
 * Cuando alguien entra desde un anuncio CTWA, Meta pega un objeto `referral` (con el id del
 * anuncio) al primer mensaje entrante del cliente; lo guardamos tal cual en
 * `chat_messages.raw_payload`. Acá cruzamos cada número que entró por un anuncio con sus compras
 * CONFIRMADAS del sorteo hechas DESPUÉS del clic.
 *
 * Dos reglas de atribución, elegidas para que la pantalla responda "qué anuncio está funcionando
 * AHORA" y no "por dónde apareció esta persona alguna vez":
 *
 * 1. Solo clics dentro de la ventana del sorteo (desde `sorteos.created_at`). Antes se miraban
 *    todos los clics de la historia, así que una compra de hoy le sumaba a un anuncio de un
 *    sorteo anterior, y las pautas que están corriendo quedaban subvaluadas.
 * 2. De cada persona cuenta su clic MÁS RECIENTE (last-click), no el más antiguo. Si entró por
 *    dos anuncios, la venta va al último que la trajo.
 *
 * Dedup por teléfono normalizado: una persona se cuenta una sola vez.
 */
export async function cargarPautaAtribucion(
  pool: Pool,
  schema: string,
  empresaId: string,
  sorteoId: string
): Promise<PautaAtribucion> {
  const tMsg = quoteSchemaTable(schema, "chat_messages");
  const tConv = quoteSchemaTable(schema, "chat_conversations");
  const tCont = quoteSchemaTable(schema, "chat_contacts");
  const tEnt = quoteSchemaTable(schema, "sorteo_entradas");
  const tSort = quoteSchemaTable(schema, "sorteos");

  /**
   * Costo: `ventas` se filtra primero por `sorteo_id` (índice `idx_sorteo_ent_sorteo`), así que
   * `sorteo_entradas` se recorre UNA vez por consulta. Antes había dos subconsultas
   * correlacionadas por persona, cada una comparando una función sobre `whatsapp_numero` —sin
   * índice posible—, o sea un escaneo completo de la tabla por cada número que entró por pauta.
   */
  const sql = `
    WITH ventana AS (
      SELECT created_at AS desde
        FROM ${tSort}
       WHERE id = $2::uuid AND empresa_id = $1::uuid
    ),
    refs AS (
      SELECT m.conversation_id AS conv, m.created_at AS ref_at,
             m.raw_payload->'referral'->>'source_id' AS ad_id,
             NULLIF(m.raw_payload->'referral'->>'headline', '') AS headline
        FROM ${tMsg} m
        JOIN ventana v ON m.created_at >= v.desde
       WHERE m.empresa_id = $1::uuid
         AND m.from_me = false
         AND m.raw_payload ? 'referral'
         AND m.raw_payload->'referral'->>'source_type' = 'ad'
    ),
    cc AS (
      SELECT r.ref_at, r.ad_id, r.headline,
             ct.phone_number, ct.name,
             ${NAT("ct.phone_number")} AS nat
        FROM refs r
        JOIN ${tConv} cv ON cv.id = r.conv
        JOIN ${tCont} ct ON ct.id = cv.contact_id
    ),
    pp AS (
      SELECT DISTINCT ON (nat) nat, ref_at, ad_id, headline, phone_number, name
        FROM cc
       ORDER BY nat, ref_at DESC
    ),
    ventas AS (
      SELECT ${NAT("e.whatsapp_numero")} AS nat, e.created_at, e.cantidad_boletos, e.monto_total
        FROM ${tEnt} e
       WHERE e.empresa_id = $1::uuid
         AND e.sorteo_id = $2::uuid
         AND e.estado_pago = 'confirmado'
    ),
    agg AS (
      SELECT pp.nat,
             SUM(v.cantidad_boletos)::int AS bol,
             SUM(v.monto_total)::numeric AS monto
        FROM pp
        JOIN ventas v ON v.nat = pp.nat AND v.created_at > pp.ref_at
       GROUP BY pp.nat
    )
    SELECT pp.ref_at, pp.ad_id, pp.headline, pp.phone_number, pp.name,
           COALESCE(a.bol, 0)::int AS bol,
           COALESCE(a.monto, 0)::numeric AS monto
      FROM pp
      LEFT JOIN agg a ON a.nat = pp.nat
     ORDER BY pp.ref_at DESC
  `;

  const r = await pool.query(sql, [empresaId, sorteoId]);
  const rows = (r.rows ?? []) as Array<Record<string, unknown>>;

  const resumen: PautaResumen = { personas: 0, compraron: 0, boletas: 0, monto: 0, conversion: 0 };
  const adMap = new Map<string, PautaAnuncio>();
  const diaMap = new Map<string, PautaDia>();
  const compradores: PautaComprador[] = [];

  for (const row of rows) {
    const bol = Number(row.bol) || 0;
    const monto = Number(row.monto) || 0;
    const adId = String(row.ad_id ?? "");
    const dia = pyDay(row.ref_at);
    const compro = bol > 0;

    resumen.personas++;
    if (compro) {
      resumen.compraron++;
      resumen.boletas += bol;
      resumen.monto += monto;
    }

    const a =
      adMap.get(adId) ??
      {
        ad_id: adId,
        headline: (row.headline as string) ?? null,
        desde: dia,
        hasta: dia,
        personas: 0,
        compraron: 0,
        boletas: 0,
        monto: 0,
        conversion: 0,
      };
    a.personas++;
    if (compro) {
      a.compraron++;
      a.boletas += bol;
      a.monto += monto;
    }
    if (dia < a.desde) a.desde = dia;
    if (dia > a.hasta) a.hasta = dia;
    adMap.set(adId, a);

    const d = diaMap.get(dia) ?? { dia, entraron: 0, compraron: 0, boletas: 0 };
    d.entraron++;
    if (compro) {
      d.compraron++;
      d.boletas += bol;
    }
    diaMap.set(dia, d);

    if (compro) {
      compradores.push({
        nombre: String(row.name ?? "").trim() || String(row.phone_number ?? ""),
        telefono: (row.phone_number as string) ?? null,
        boletas: bol,
        monto,
        cuando: dia,
        ad_id: adId,
      });
    }
  }

  resumen.conversion = resumen.personas ? resumen.compraron / resumen.personas : 0;

  const porAnuncio = [...adMap.values()]
    .map((a) => ({ ...a, conversion: a.personas ? a.compraron / a.personas : 0 }))
    .sort((x, y) => y.boletas - x.boletas || y.personas - x.personas);

  const porDia = [...diaMap.values()].sort((x, y) => (x.dia < y.dia ? -1 : 1));
  compradores.sort((x, y) => y.boletas - x.boletas || y.monto - x.monto);

  return { resumen, porAnuncio, porDia, compradores };
}
