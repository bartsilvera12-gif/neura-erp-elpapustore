/**
 * Creación de orden sorteo + cupones vía Postgres directo (sin PostgREST RPC).
 * Usado cuando `sorteos_ensure_order_from_chat` no está expuesto o falla PGRST202.
 *
 * Solo importar desde código servidor (API, flow engine). No desde `"use client"`.
 */
import "server-only";

import pg from "pg";
import { getChatPostgresPool } from "@/lib/supabase/chat-pg-pool";
import { insertSorteoCuponesAndUpdateSorteoCounters } from "@/lib/sorteos/sorteo-order-cupones-pg";

const FLOW_SORTEO_LOG = "[flow-sorteo]" as const;

function quoteIdent(schema: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(schema)) {
    throw new Error("schema inválido");
  }
  return `"${schema.replace(/"/g, '""')}"`;
}

export type DirectPgSorteoInput = {
  schema: string;
  empresaId: string;
  sorteoId: string;
  conversationId: string;
  flowCode: string;
  idempotencyKey: string;
  whatsappNumero: string;
  nombreCompleto: string;
  cedula: string;
  ciudad: string;
  cantidadBoletos: number;
  comprobanteUrl: string;
  validadoPor: string;
  montoCompra: number | null;
  promoNombre: string;
  precioRegularReferencia: number | null;
  revendedorId: string | null;
  codigoReferidoSnapshot: string | null;
  comprobanteValidacionId: string | null;
};

export type DirectPgSorteoOk = {
  ok: true;
  idempotent: boolean;
  entradaId: string;
  numeroOrden: number;
  cupones: { id: string; numero_cupon: string }[];
  cantidadBoletos: number;
  montoTotal: number;
  promoNombre: string;
  precioFuente: "lista" | "promo";
  estadoPago: string;
};

export type DirectPgSorteoFail = {
  ok: false;
  message: string;
};

async function loadColumns(client: pg.PoolClient, schema: string, table: string): Promise<Set<string>> {
  const r = await client.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = $2`,
    [schema, table]
  );
  return new Set(r.rows.map((x) => x.column_name));
}

function mapRowToOk(
  ex: { id: string; numero_orden: number; estado_pago: string },
  cupRes: { rows: { id: string; numero_cupon: string }[] },
  er: {
    cantidad_boletos?: number;
    monto_total?: string | number | null;
    promo_nombre?: string | null;
    precio_fuente?: string | null;
  } | undefined,
  qtyFallback: number,
  idempotent: boolean
): DirectPgSorteoOk {
  return {
    ok: true,
    idempotent,
    entradaId: ex.id,
    numeroOrden: ex.numero_orden,
    cupones: cupRes.rows.map((r) => ({ id: r.id, numero_cupon: r.numero_cupon })),
    cantidadBoletos:
      typeof er?.cantidad_boletos === "number" ? er.cantidad_boletos : qtyFallback,
    montoTotal: Number(er?.monto_total ?? 0) || 0,
    promoNombre: String(er?.promo_nombre ?? ""),
    precioFuente: er?.precio_fuente === "promo" ? "promo" : "lista",
    estadoPago: ex.estado_pago,
  };
}

/** Respuesta alineada al parser existente en `ensureSorteoOrderFromChat`. */
export async function ensureSorteoOrderViaDirectPostgres(
  input: DirectPgSorteoInput
): Promise<DirectPgSorteoOk | DirectPgSorteoFail> {
  const sch = input.schema.trim();
  const poolInst = getChatPostgresPool();
  if (!poolInst) {
    return { ok: false, message: "No hay conexión directa a la base de datos configurada." };
  }

  // Reintenta el connect ante blips transitorios (ECONNREFUSED / timeout del pool). Si igual falla,
  // devolvemos {ok:false} con mensaje EN VEZ de tirar crudo: antes la excepción subía sin catch y el
  // paso quedaba MUDO — el cliente tocaba Confirmado y no se generaba la boleta ni un aviso. Ahora,
  // o el reintento lo absorbe, o el cliente recibe un mensaje para reintentar.
  let clientOrNull: pg.PoolClient | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      clientOrNull = await poolInst.connect();
      break;
    } catch (e) {
      if (attempt >= 3) {
        console.error(FLOW_SORTEO_LOG, "[order-create]", "[connect-failed]", {
          schema: sch,
          error: e instanceof Error ? e.message : String(e),
        });
      } else {
        await new Promise((r) => setTimeout(r, 400 * attempt));
      }
    }
  }
  if (!clientOrNull) {
    return {
      ok: false,
      message:
        "No pudimos registrar tu compra en este momento por un problema de conexión. Tocá Confirmado de nuevo en unos segundos y listo.",
    };
  }
  const client = clientOrNull;
  const qsch = quoteIdent(sch);

  try {
    const entCols = await loadColumns(client, sch, "sorteo_entradas");
    const cupCols = await loadColumns(client, sch, "sorteo_cupones");
    const sortCols = await loadColumns(client, sch, "sorteos");
    const cliCols = await loadColumns(client, sch, "clientes");

    if (
      !sortCols.has("id") ||
      !entCols.has("empresa_id") ||
      !cupCols.has("entrada_id") ||
      !cliCols.has("empresa_id")
    ) {
      console.error(FLOW_SORTEO_LOG, "[order-create]", "[direct-sql-error]", {
        schema: sch,
        sorteo_entradas_sample: [...entCols].slice(0, 40),
        sorteo_cupones_sample: [...cupCols].slice(0, 25),
        sorteos_sample: [...sortCols].slice(0, 40),
        clientes_sample: [...cliCols].slice(0, 25),
        error: "columnas mínimas ausentes en tablas del tenant",
      });
      return {
        ok: false,
        message: "No se pudo validar las tablas de sorteo en el servidor. Contactá soporte.",
      };
    }

    await client.query("BEGIN");

    const idemRes = await client.query<{ id: string; numero_orden: number; estado_pago: string }>(
      `SELECT id, numero_orden, estado_pago FROM ${qsch}.sorteo_entradas WHERE idempotency_key = $1 LIMIT 1`,
      [input.idempotencyKey]
    );
    if (idemRes.rows[0]) {
      const ex = idemRes.rows[0];
      const cupRes = await client.query<{ id: string; numero_cupon: string }>(
        `SELECT id, numero_cupon FROM ${qsch}.sorteo_cupones WHERE entrada_id = $1 ORDER BY numero_cupon`,
        [ex.id]
      );
      const ec = await client.query(
        `SELECT cantidad_boletos, monto_total, promo_nombre, precio_fuente FROM ${qsch}.sorteo_entradas WHERE id = $1`,
        [ex.id]
      );
      await client.query("COMMIT");
      return mapRowToOk(
        ex,
        cupRes,
        ec.rows[0] as {
          cantidad_boletos?: number;
          monto_total?: string | number | null;
          promo_nombre?: string | null;
          precio_fuente?: string | null;
        },
        input.cantidadBoletos,
        true
      );
    }

    const sortSelectCols = [
      "id",
      "empresa_id",
      "estado",
      "precio_por_boleto",
      "max_boletos",
      "total_boletos_vendidos",
      "ultimo_numero_cupon",
      "ultimo_numero_orden",
    ];
    if (sortCols.has("coupon_numbering_enabled")) sortSelectCols.push("coupon_numbering_enabled");
    if (sortCols.has("coupon_number_start")) sortSelectCols.push("coupon_number_start");
    if (sortCols.has("coupon_number_mode")) sortSelectCols.push("coupon_number_mode");
    if (sortCols.has("coupon_number_limit")) sortSelectCols.push("coupon_number_limit");

    const sRes = await client.query(
      `SELECT ${sortSelectCols.join(", ")}
       FROM ${qsch}.sorteos WHERE id = $1 FOR UPDATE`,
      [input.sorteoId]
    );
    const s = sRes.rows[0] as
      | {
          empresa_id: string;
          estado: string;
          precio_por_boleto: string | number;
          max_boletos: number;
          total_boletos_vendidos: number;
          ultimo_numero_cupon: number;
          ultimo_numero_orden: number;
          coupon_numbering_enabled?: boolean;
          coupon_number_start?: number | null;
          coupon_number_mode?: string | null;
          coupon_number_limit?: number | null;
        }
      | undefined;
    if (!s) {
      await client.query("ROLLBACK");
      return { ok: false, message: "Sorteo no encontrado." };
    }
    if (s.empresa_id !== input.empresaId) {
      await client.query("ROLLBACK");
      return { ok: false, message: "El sorteo no pertenece a la empresa indicada." };
    }
    if (String(s.estado) !== "activo") {
      await client.query("ROLLBACK");
      return { ok: false, message: "El sorteo no está activo." };
    }
    const qty = input.cantidadBoletos;
    if (s.total_boletos_vendidos + qty > s.max_boletos) {
      await client.query("ROLLBACK");
      return { ok: false, message: "No hay boletos disponibles para esta cantidad." };
    }

    const precioBase = Number(s.precio_por_boleto);
    const listaCalc = (Number.isFinite(precioBase) ? precioBase : 0) * qty;
    let montoTotal: number;
    let precioFuenteIns: "lista" | "promo";
    let precioRegularRef: number | null = null;

    if (input.montoCompra != null && input.montoCompra > 0) {
      montoTotal = Math.round(input.montoCompra);
      precioFuenteIns = "promo";
      precioRegularRef =
        input.precioRegularReferencia != null && input.precioRegularReferencia > 0
          ? Math.round(input.precioRegularReferencia)
          : listaCalc;
    } else {
      montoTotal = listaCalc;
      precioFuenteIns = "lista";
      precioRegularRef = null;
    }

    let clienteId: string | null = null;
    const ce = input.cedula.trim();
    const wa = input.whatsappNumero.trim();

    const deletedClause = cliCols.has("deleted_at") ? "AND deleted_at IS NULL" : "";

    const findCli = await client.query<{ id: string }>(
      `SELECT id FROM ${qsch}.clientes
       WHERE empresa_id = $1 ${deletedClause}
         AND (
           ($2::text IS NOT NULL AND $2::text <> '' AND documento IS NOT NULL AND trim(documento) = $2)
           OR trim(telefono) = $3
         )
       LIMIT 1`,
      [input.empresaId, ce || null, wa]
    );
    if (findCli.rows[0]) {
      clienteId = findCli.rows[0].id;
    } else {
      const insCli = await client.query<{ id: string }>(
        `INSERT INTO ${qsch}.clientes (
           empresa_id, tipo_cliente, nombre_contacto, nombre, documento, telefono, ciudad, origen
         ) VALUES ($1, 'persona', $2, $2, $3, $4, $5, 'SORTEO_CHAT')
         RETURNING id`,
        [input.empresaId, input.nombreCompleto, ce || null, wa, input.ciudad.trim() || null]
      );
      clienteId = insCli.rows[0]?.id ?? null;
    }

    const numeroOrden = Number(s.ultimo_numero_orden) + 1;
    const ultCupon = Number(s.ultimo_numero_cupon);

    const rowEnt: Record<string, unknown> = {
      empresa_id: input.empresaId,
      sorteo_id: input.sorteoId,
      conversacion_id: null,
      cliente_id: clienteId,
      whatsapp_numero: wa,
      nombre_participante: input.nombreCompleto.trim(),
      documento: ce || null,
      cantidad_boletos: qty,
      monto_total: montoTotal,
      moneda: "PYG",
      estado_pago: "pendiente_revision",
      comprobante_url: input.comprobanteUrl.trim() || null,
      validado_por: input.validadoPor.trim() || "chat_flow",
      numero_orden: numeroOrden,
      chat_conversation_id: input.conversationId,
      flow_code: input.flowCode.trim(),
      idempotency_key: input.idempotencyKey,
      promo_nombre: input.promoNombre.trim() || null,
      precio_fuente: precioFuenteIns,
      precio_regular_referencia: precioRegularRef,
    };

    if (entCols.has("comprobante_validacion_id") && input.comprobanteValidacionId?.trim()) {
      rowEnt.comprobante_validacion_id = input.comprobanteValidacionId.trim();
    }
    if (entCols.has("revendedor_id") && input.revendedorId?.trim()) {
      rowEnt.revendedor_id = input.revendedorId.trim();
    }
    if (entCols.has("codigo_referido_snapshot") && input.codigoReferidoSnapshot?.trim()) {
      rowEnt.codigo_referido_snapshot = input.codigoReferidoSnapshot.trim();
    }

    const insertCols = Object.keys(rowEnt).filter((k) => entCols.has(k));
    const vals = insertCols.map((k) => rowEnt[k]);
    const placeholders = insertCols.map((_, i) => `$${i + 1}`).join(", ");
    const colQuoted = insertCols.map((c) => `"${c.replace(/"/g, '""')}"`).join(", ");

    let entradaId: string;
    try {
      const insE = await client.query<{ id: string }>(
        `INSERT INTO ${qsch}.sorteo_entradas (${colQuoted}) VALUES (${placeholders}) RETURNING id`,
        vals as unknown[]
      );
      entradaId = insE.rows[0]?.id ?? "";
    } catch (e: unknown) {
      const pgE = e as { code?: string };
      if (pgE.code === "23505") {
        await client.query("ROLLBACK");
        const again = await client.query<{ id: string; numero_orden: number; estado_pago: string }>(
          `SELECT id, numero_orden, estado_pago FROM ${qsch}.sorteo_entradas WHERE idempotency_key = $1 LIMIT 1`,
          [input.idempotencyKey]
        );
        if (again.rows[0]) {
          const ex = again.rows[0];
          const cupRes = await client.query<{ id: string; numero_cupon: string }>(
            `SELECT id, numero_cupon FROM ${qsch}.sorteo_cupones WHERE entrada_id = $1 ORDER BY numero_cupon`,
            [ex.id]
          );
          const ec = await client.query(
            `SELECT cantidad_boletos, monto_total, promo_nombre, precio_fuente FROM ${qsch}.sorteo_entradas WHERE id = $1`,
            [ex.id]
          );
          return mapRowToOk(ex, cupRes, ec.rows[0], input.cantidadBoletos, true);
        }
      }
      throw e;
    }

    if (!entradaId) {
      await client.query("ROLLBACK");
      return { ok: false, message: "No se pudo crear la entrada del sorteo." };
    }

    const cupInsert = await insertSorteoCuponesAndUpdateSorteoCounters({
      client,
      schemaQuoted: qsch,
      sortCols,
      cupCols,
      s,
      empresaId: input.empresaId,
      sorteoId: input.sorteoId,
      entradaId,
      qty,
      ultCupon,
      numeroOrden,
    });
    if (!cupInsert.ok) {
      await client.query("ROLLBACK");
      return { ok: false, message: cupInsert.message };
    }

    await client.query("COMMIT");

    return {
      ok: true,
      idempotent: false,
      entradaId,
      numeroOrden,
      cupones: cupInsert.cupones,
      cantidadBoletos: qty,
      montoTotal,
      promoNombre: input.promoNombre.trim(),
      precioFuente: precioFuenteIns,
      estadoPago: "pendiente_revision",
    };
  } catch (err: unknown) {
    await client.query("ROLLBACK").catch(() => {});
    const e = err as { message?: string; code?: string };
    console.error(FLOW_SORTEO_LOG, "[order-create]", "[direct-sql-error]", {
      schema: input.schema,
      tablas: ["sorteo_entradas", "sorteo_cupones", "sorteos", "clientes"],
      message: e.message,
      code: e.code,
    });
    return {
      ok: false,
      message:
        "No pudimos registrar tu compra en el sorteo. Intentá de nuevo en unos minutos o escribí a soporte.",
    };
  } finally {
    client.release();
  }
}

/** Lectura de metadatos del sorteo vía SQL directo (tenant sin PostgREST expuesto). */
export async function fetchSorteoRowTicketFieldsFromPg(
  schema: string,
  sorteoId: string
): Promise<{
  nombre: string | null;
  ticket_delivery_mode: string | null;
  ticket_image_config: unknown;
} | null> {
  const pool = getChatPostgresPool();
  if (!pool) return null;
  const schemaSql = quoteIdent(schema);
  try {
    const r = await pool.query<{
      nombre: string | null;
      ticket_delivery_mode: string | null;
      ticket_image_config: unknown;
    }>(
      `SELECT nombre, ticket_delivery_mode, ticket_image_config
       FROM ${schemaSql}.sorteos
       WHERE id = $1::uuid
       LIMIT 1`,
      [sorteoId]
    );
    if (!r.rows.length) return null;
    return r.rows[0];
  } catch (err: unknown) {
    const e = err as { message?: string };
    console.warn("[flow-sorteo] fetchSorteoRowTicketFieldsFromPg_failed", {
      schema,
      sorteoId: String(sorteoId).slice(0, 8),
      message: e.message,
    });
    return null;
  }
}
