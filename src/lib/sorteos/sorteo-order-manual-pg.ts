/**
 * Venta presencial / manual en ERP: sorteo_entradas + cupones sin WhatsApp ni chat.
 * Transacción PG directa + idempotencia por `idempotency_key` (misma fila que el flujo chat).
 */
import "server-only";

import pg from "pg";
import { getChatPostgresPool } from "@/lib/supabase/chat-pg-pool";
import { insertSorteoCuponesAndUpdateSorteoCounters } from "@/lib/sorteos/sorteo-order-cupones-pg";
import type { DirectPgSorteoOk } from "@/lib/sorteos/sorteo-order-direct-pg";

const MANUAL_SORTEO_LOG = "[sorteo-manual]" as const;

function quoteIdent(schema: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(schema)) {
    throw new Error("schema inválido");
  }
  return `"${schema.replace(/"/g, '""')}"`;
}

function normalizeTelefonoSorteo(raw: string): string {
  const d = raw.replace(/\D/g, "");
  return d.length > 0 ? d : raw.trim();
}

async function loadColumns(client: pg.PoolClient, schema: string, table: string): Promise<Set<string>> {
  const r = await client.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = $2`,
    [schema, table]
  );
  return new Set(r.rows.map((x) => x.column_name));
}

export type SorteoManualCashInput = {
  schema: string;
  empresaId: string;
  sorteoId: string;
  idempotencyKey: string;
  nombre: string;
  apellido: string;
  cedula: string;
  telefono: string;
  ciudad?: string | null;
  cantidadBoletos: number;
  /** Monto total informado por el operador (>= 0). */
  montoTotal: number;
  observacionInterna?: string | null;
  validadoPorUserId?: string | null;
};

export type SorteoManualCashFail = { ok: false; message: string };

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

/**
 * Crea orden confirmada en efectivo (mostrador). No escribe chat_flow_data ni mensajes.
 */
export async function createSorteoManualCashSaleViaDirectPostgres(
  input: SorteoManualCashInput
): Promise<DirectPgSorteoOk | SorteoManualCashFail> {
  const sch = input.schema.trim();
  const idem = input.idempotencyKey.trim();
  if (!idem) {
    return { ok: false, message: "Falta idempotency_key." };
  }

  const nombreCompleto = `${input.nombre.trim()} ${input.apellido.trim()}`.trim();
  if (!nombreCompleto) {
    return { ok: false, message: "Nombre y apellido son obligatorios." };
  }

  const qty = input.cantidadBoletos;
  if (!Number.isFinite(qty) || qty < 1) {
    return { ok: false, message: "La cantidad de boletos debe ser mayor a 0." };
  }

  const montoRounded = Math.round(Number(input.montoTotal));
  if (!Number.isFinite(montoRounded) || montoRounded < 0) {
    return { ok: false, message: "El monto total debe ser un número mayor o igual a 0." };
  }

  const poolInst = getChatPostgresPool();
  if (!poolInst) {
    return { ok: false, message: "No hay conexión directa a la base de datos configurada." };
  }

  const client = await poolInst.connect();
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
      console.error(MANUAL_SORTEO_LOG, "columnas_mínimas_ausentes", { schema: sch });
      return {
        ok: false,
        message: "No se pudo validar las tablas de sorteo en el servidor. Contactá soporte.",
      };
    }

    await client.query("BEGIN");

    const idemRes = await client.query<{ id: string; numero_orden: number; estado_pago: string }>(
      `SELECT id, numero_orden, estado_pago FROM ${qsch}.sorteo_entradas WHERE idempotency_key = $1 LIMIT 1`,
      [idem]
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
        qty,
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
    if (s.total_boletos_vendidos + qty > s.max_boletos) {
      await client.query("ROLLBACK");
      return { ok: false, message: "No hay boletos disponibles para esta cantidad." };
    }

    const precioBase = Number(s.precio_por_boleto);
    const listaCalc = (Number.isFinite(precioBase) ? precioBase : 0) * qty;
    let precioFuenteIns: "lista" | "promo";
    let precioRegularRef: number | null = null;
    if (montoRounded === listaCalc) {
      precioFuenteIns = "lista";
    } else {
      precioFuenteIns = "promo";
      precioRegularRef = listaCalc;
    }

    const wa = normalizeTelefonoSorteo(input.telefono);
    const ce = input.cedula.trim();
    const ciudad = (input.ciudad ?? "").trim();

    let clienteId: string | null = null;
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
      /** Cliente existente: completar ciudad solo si vino y estaba vacía (no pisar una ya cargada). */
      if (ciudad && cliCols.has("ciudad")) {
        await client.query(
          `UPDATE ${qsch}.clientes SET ciudad = $2
           WHERE id = $1 AND (ciudad IS NULL OR trim(ciudad) = '')`,
          [clienteId, ciudad]
        );
      }
    } else {
      const insCli = await client.query<{ id: string }>(
        `INSERT INTO ${qsch}.clientes (
           empresa_id, tipo_cliente, nombre_contacto, nombre, documento, telefono, ciudad, origen
         ) VALUES ($1, 'persona', $2, $2, $3, $4, $5, 'SORTEO')
         RETURNING id`,
        [input.empresaId, nombreCompleto, ce || null, wa, ciudad || null]
      );
      clienteId = insCli.rows[0]?.id ?? null;
    }

    const numeroOrden = Number(s.ultimo_numero_orden) + 1;
    const ultCupon = Number(s.ultimo_numero_cupon);
    const nowIso = new Date().toISOString();

    const rowEnt: Record<string, unknown> = {
      empresa_id: input.empresaId,
      sorteo_id: input.sorteoId,
      conversacion_id: null,
      cliente_id: clienteId,
      whatsapp_numero: wa,
      nombre_participante: nombreCompleto,
      documento: ce || null,
      cantidad_boletos: qty,
      monto_total: montoRounded,
      moneda: "PYG",
      estado_pago: "confirmado",
      fecha_pago: nowIso,
      monto_pagado: montoRounded,
      banco_origen: "EFECTIVO",
      comprobante_url: null,
      validado_por: "erp_manual_presencial",
      numero_orden: numeroOrden,
      chat_conversation_id: null,
      flow_code: null,
      idempotency_key: idem,
      promo_nombre: null,
      precio_fuente: precioFuenteIns,
      precio_regular_referencia: precioRegularRef,
    };

    if (entCols.has("validado_at")) {
      rowEnt.validado_at = nowIso;
    }
    if (entCols.has("validado_por_user_id") && input.validadoPorUserId?.trim()) {
      rowEnt.validado_por_user_id = input.validadoPorUserId.trim();
    }
    if (entCols.has("observacion_interna")) {
      const note = (input.observacionInterna ?? "").trim();
      rowEnt.observacion_interna = note.length > 0 ? note : null;
    }
    if (entCols.has("venta_origen")) {
      rowEnt.venta_origen = "erp_manual";
    }
    if (entCols.has("venta_canal")) {
      rowEnt.venta_canal = "local";
    }
    if (entCols.has("pago_metodo")) {
      rowEnt.pago_metodo = "efectivo";
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
          [idem]
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
          return mapRowToOk(ex, cupRes, ec.rows[0], qty, true);
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
      montoTotal: montoRounded,
      promoNombre: "",
      precioFuente: precioFuenteIns,
      estadoPago: "confirmado",
    };
  } catch (err: unknown) {
    await client.query("ROLLBACK").catch(() => {});
    const e = err as { message?: string; code?: string };
    console.error(MANUAL_SORTEO_LOG, "sql_error", {
      schema: input.schema,
      message: e.message,
      code: e.code,
    });
    return {
      ok: false,
      message: "No se pudo registrar la venta manual. Intentá de nuevo o contactá soporte.",
    };
  } finally {
    client.release();
  }
}
