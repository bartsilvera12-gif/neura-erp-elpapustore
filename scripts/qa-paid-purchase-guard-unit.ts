/**
 * QA unitario (sin DB real): una compra YA PAGADA sin orden no se reinicia por "boletas" / "hola".
 *
 * Contexto (29/30-sep, Papu_store): Pablo pagó 20.000, faltaba su celular, escribió "Y mis boletas"
 * y el bot le arrancó una compra nueva; al reenviar el comprobante se rechazó como duplicado y nunca
 * recibió sus boletas. Igual Vane ("Hola, ¿cómo sé mi número?"), Rosa ("Holaaa"), Richar.
 *
 * Ejecutar: npx tsx scripts/qa-paid-purchase-guard-unit.ts
 */
process.env.NEURA_INSTANCE_MODE = "single_client";
process.env.NEURA_CLIENT_SCHEMA = "elpapustore_erp";

import type { SupabaseAdmin } from "../src/lib/chat/types";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}
let passed = 0;
function ok(msg: string) {
  passed += 1;
  console.log("OK:", msg);
}

type Row = Record<string, unknown>;
type Db = Record<string, Row[]>;

/** Supabase en memoria (subconjunto encadenable). `failTables`: toda lectura de esa tabla falla. */
function fakeSupabase(db: Db, opts: { failTables?: Set<string> } = {}) {
  let seq = 1;
  function from(table: string) {
    const filters: ((r: Row) => boolean)[] = [];
    let op: "select" | "insert" | "update" = "select";
    let patch: Row = {};
    let inserted: Row[] = [];
    let orderCol: string | null = null;
    let asc = true;
    let lim: number | null = null;
    let terminal: "many" | "maybeSingle" | "single" = "many";
    const b = {
      select() {
        return b;
      },
      insert(row: Row) {
        op = "insert";
        inserted = [{ id: `new-${seq++}`, created_at: new Date().toISOString(), ...row }];
        return b;
      },
      update(p: Row) {
        op = "update";
        patch = p;
        return b;
      },
      eq(c: string, v: unknown) {
        filters.push((r) => r[c] === v);
        return b;
      },
      is(c: string, v: unknown) {
        filters.push((r) => (r[c] ?? null) === v);
        return b;
      },
      order(c: string, o?: { ascending?: boolean }) {
        orderCol = c;
        asc = o?.ascending !== false;
        return b;
      },
      limit(n: number) {
        lim = n;
        return b;
      },
      maybeSingle() {
        terminal = "maybeSingle";
        return b;
      },
      single() {
        terminal = "single";
        return b;
      },
      then(resolve: (v: unknown) => void) {
        resolve(exec());
      },
    };
    function exec() {
      const rows = (db[table] ??= []);
      if (op === "insert") {
        rows.push(...inserted);
        return { data: terminal === "many" ? inserted : inserted[0], error: null };
      }
      if (op === "update") {
        const hit = rows.filter((r) => filters.every((f) => f(r)));
        hit.forEach((r) => Object.assign(r, patch));
        return { data: hit, error: null };
      }
      if (opts.failTables?.has(table)) return { data: null, error: { message: "520" } };
      let out = rows.filter((r) => filters.every((f) => f(r)));
      if (orderCol) {
        const c = orderCol;
        out = [...out].sort((a, z) => (String(a[c]) < String(z[c]) ? -1 : 1) * (asc ? 1 : -1));
      }
      if (lim != null) out = out.slice(0, lim);
      return { data: terminal === "many" ? out : (out[0] ?? null), error: null };
    }
    return b;
  }
  return { from } as unknown as SupabaseAdmin;
}

const E = "emp";
const C = "conv";
const F = "Papu_store";

/** Pablo: sesión activa, comprobante válido, sin orden, esperando el celular. */
function pabloDb(over: { estado?: string; entradaLink?: string | null; sesStatus?: string; entrada?: boolean } = {}): Db {
  return {
    chat_conversations: [
      { id: C, empresa_id: E, flow_code: F, flow_current_node: "solicitud_de_nro_de_celular", active_flow_session_id: "s1" },
    ],
    chat_flow_sessions: [
      { id: "s1", empresa_id: E, conversation_id: C, flow_code: F, status: over.sesStatus ?? "active", created_at: "2026-09-29T20:48:00Z" },
    ],
    chat_flow_data: [{ flow_session_id: "s1", field_name: "sorteo_comprobante_validacion_id", field_value: "v1" }],
    chat_comprobante_validaciones: [
      { id: "v1", estado_validacion: over.estado ?? "valido", sorteo_entrada_id: over.entradaLink ?? null },
    ],
    sorteo_entradas: over.entrada ? [{ id: "e1", comprobante_validacion_id: "v1" }] : [],
    chat_flows: [
      {
        empresa_id: E,
        flow_code: F,
        activo: true,
        channel: "whatsapp",
        flow_config: {
          restart_enabled: true,
          restart_node_code: "Mensaje_de_bienvenida",
          restart_when_abandoned: true,
          restart_when_completed: true,
          restart_strong_keywords: ["el papu sorteos", "papu sorteos", "sorteo el papu", "el papu sorteo", "boletas"],
          do_not_restart_when_human_taken_over: true,
        },
      },
    ],
    chat_flow_nodes: [],
  };
}

(async () => {
  const { findPaidPurchasePendingOrder } = await import("../src/lib/chat/paid-purchase-guard");
  const { maybeRestartForPurchaseIntent, PAID_PURCHASE_PENDING_ORDER_REASON } = await import(
    "../src/lib/chat/flow-restart-intent"
  );
  const quiet = { warn: console.warn, info: console.info, error: console.error };
  console.warn = console.info = console.error = () => undefined;
  try {
    {
      const r = await findPaidPurchasePendingOrder(fakeSupabase(pabloDb()), E, C);
      assert(r?.validationId === "v1" && r.flowSessionId === "s1", "no detectó la compra pagada");
      ok("caso real Pablo: comprobante válido sin orden → compra pagada pendiente");
    }
    {
      const r = await findPaidPurchasePendingOrder(fakeSupabase(pabloDb({ estado: "aprobado_manual" })), E, C);
      assert(r != null, "aprobado por asesor también cuenta");
      ok("caso real Vane: comprobante aprobado por asesor sin orden → compra pagada pendiente");
    }
    {
      assert((await findPaidPurchasePendingOrder(fakeSupabase(pabloDb({ entrada: true })), E, C)) === null, "con orden");
      assert(
        (await findPaidPurchasePendingOrder(fakeSupabase(pabloDb({ entradaLink: "e1" })), E, C)) === null,
        "validación ya vinculada"
      );
      ok("si la orden ya existe → NO bloquea (una compra nueva se reinicia como siempre)");
    }
    {
      for (const estado of ["duplicado_hash", "rechazado", "pendiente", ""]) {
        assert((await findPaidPurchasePendingOrder(fakeSupabase(pabloDb({ estado })), E, C)) === null, estado);
      }
      ok("comprobante duplicado / rechazado / sin validar → NO bloquea");
    }
    {
      assert(
        (await findPaidPurchasePendingOrder(fakeSupabase(pabloDb({ sesStatus: "completed" })), E, C)) === null,
        "sesión no activa"
      );
      ok("sesión terminada → NO bloquea");
    }
    {
      for (const t of ["chat_conversations", "chat_flow_sessions", "chat_flow_data", "chat_comprobante_validaciones", "sorteo_entradas"]) {
        const r = await findPaidPurchasePendingOrder(fakeSupabase(pabloDb(), { failTables: new Set([t]) }), E, C);
        assert(r === null, `error en ${t} debió devolver null`);
      }
      ok("cualquier lectura fallida → NO bloquea (comportamiento de siempre)");
    }
    {
      const db = pabloDb();
      const sb = fakeSupabase(db);
      const pi = await maybeRestartForPurchaseIntent(sb, E, C, {
        messageType: "text",
        content: "Y mis boletas",
        convFlow: F,
        convNode: "solicitud_de_nro_de_celular",
        convHuman: false,
        convFlowStatus: "bot",
        restartedThisMessage: false,
        blockRestart: async () => Boolean(await findPaidPurchasePendingOrder(sb, E, C)),
      });
      assert(!pi.restarted && pi.reason === PAID_PURCHASE_PENDING_ORDER_REASON, `reason=${pi.reason}`);
      assert(db.chat_flow_sessions.length === 1 && db.chat_flow_sessions[0].status === "active", "tocó la sesión");
      assert(db.chat_conversations[0].active_flow_session_id === "s1", "movió el puntero");
      ok('caso real Pablo: "Y mis boletas" con pago pendiente → NO reinicia, sesión y pago intactos');
    }
    {
      const db = pabloDb({ entrada: true });
      const sb = fakeSupabase(db);
      const pi = await maybeRestartForPurchaseIntent(sb, E, C, {
        messageType: "text",
        content: "quiero mas boletas",
        convFlow: F,
        convNode: "compra_realizada",
        convHuman: false,
        convFlowStatus: "bot",
        restartedThisMessage: false,
        blockRestart: async () => Boolean(await findPaidPurchasePendingOrder(sb, E, C)),
      });
      assert(pi.reason !== PAID_PURCHASE_PENDING_ORDER_REASON, "bloqueó una recompra legítima");
      ok("cliente con orden ya creada que pide más boletas → el reinicio NO se bloquea");
    }
  } finally {
    Object.assign(console, quiet);
  }
  console.log(`\n${passed} pruebas OK`);
})().catch((e) => {
  console.error("FALLO:", e instanceof Error ? e.message : e);
  process.exit(1);
});
