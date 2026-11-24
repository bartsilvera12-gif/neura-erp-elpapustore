/**
 * QA unitario (sin DB real): el revendedor se hereda en los reinicios del mismo chat.
 *
 * Contexto (nov-2026, Papu_store): José entró por el link de RevJose, compró y después escribió
 * "boletas" (reinicio). La sesión nueva quedó sin revendedor y las órdenes 7452 / 7469 no se le
 * acreditaron. 92 órdenes confirmadas del sorteo vigente quedaron así.
 *
 * Ejecutar: npx tsx --conditions=react-server scripts/qa-referral-inheritance-unit.ts
 */
process.env.NEURA_INSTANCE_MODE = "single_client";
process.env.NEURA_CLIENT_SCHEMA = "elpapustore_erp";

import type { SupabaseAdmin } from "../src/lib/chat/types";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

type Row = Record<string, unknown>;
type Db = Record<string, Row[]>;

/** Supabase en memoria (subconjunto encadenable; filtros no modelados se ignoran). */
function fakeSupabase(db: Db) {
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
    function exec() {
      const rows = (db[table] ??= []);
      if (op === "insert") {
        rows.push(...inserted);
        return { data: terminal === "many" ? inserted : inserted[0], error: null };
      }
      if (op === "update") {
        const rs = patch.referral_source;
        if (table === "chat_flow_sessions" && rs != null && rs !== "click_token" && rs !== "inbound_text") {
          return { data: null, error: { message: 'violates check constraint "chat_flow_sessions_referral_source_check"' } };
        }
        const hit = rows.filter((r) => filters.every((f) => f(r)));
        hit.forEach((r) => Object.assign(r, patch));
        return { data: hit, error: null };
      }
      let out = rows.filter((r) => filters.every((f) => f(r)));
      if (orderCol) {
        const c = orderCol;
        out = [...out].sort((a, z) => (String(a[c]) < String(z[c]) ? -1 : 1) * (asc ? 1 : -1));
      }
      if (lim != null) out = out.slice(0, lim);
      return { data: terminal === "many" ? out : (out[0] ?? null), error: null };
    }
    const impl: Record<string, (...a: never[]) => void> = {
      select: () => undefined,
      insert(row: Row | Row[]) {
        op = "insert";
        const arr = Array.isArray(row) ? row : [row];
        inserted = arr.map((r) => ({ id: `new-${seq++}`, created_at: `2026-11-24T12:00:${String(seq).padStart(2, "0")}Z`, ...r }));
      },
      update(p: Row) {
        op = "update";
        patch = p;
      },
      eq(c: string, v: unknown) {
        filters.push((r) => r[c] === v);
      },
      neq(c: string, v: unknown) {
        filters.push((r) => r[c] !== v);
      },
      in(c: string, v: unknown[]) {
        filters.push((r) => v.includes(r[c]));
      },
      is(c: string, v: unknown) {
        filters.push((r) => (r[c] ?? null) === v);
      },
      ilike(c: string, v: string) {
        filters.push((r) => String(r[c] ?? "").toLowerCase() === v.toLowerCase());
      },
      not(c: string, o: string, v: unknown) {
        if (o === "is") filters.push((r) => (r[c] ?? null) !== v);
      },
      or(expr: string) {
        const parts = expr.split(",").map((p) => p.split("."));
        filters.push((r) =>
          parts.some(([c, o, ...rest]) => {
            const v = rest.join(".");
            if (o === "is" && v === "null") return (r[c] ?? null) === null;
            if (o === "eq") return String(r[c] ?? "") === v;
            return false;
          })
        );
      },
      order(c: string, o?: { ascending?: boolean }) {
        orderCol = c;
        asc = o?.ascending !== false;
      },
      limit(n: number) {
        lim = n;
      },
      maybeSingle() {
        terminal = "maybeSingle";
      },
      single() {
        terminal = "single";
      },
    };
    const proxy: unknown = new Proxy(
      {},
      {
        get(_t, k) {
          if (k === "then") return (resolve: (v: unknown) => void) => resolve(exec());
          if (typeof k === "symbol") return undefined;
          const fn = impl[k];
          return (...a: never[]) => {
            if (fn) fn(...a);
            return proxy;
          };
        },
      }
    );
    return proxy;
  }
  return { from } as unknown as SupabaseAdmin;
}

const E = "emp";
const C = "conv";
const F = "Papu_store";
const SORTEO = "sorteo-nov";
const SORTEO_VIEJO = "sorteo-oct";

function baseDb(over: { prevRev?: string; pointer?: string | null; firstRev?: string | null } = {}): Db {
  return {
    chat_conversations: [
      {
        id: C,
        empresa_id: E,
        flow_code: F,
        flow_current_node: "compra_realizada",
        active_flow_session_id: over.pointer ?? null,
        first_revendedor_id: over.firstRev ?? null,
      },
    ],
    chat_flow_sessions: [
      {
        id: "s-viejo",
        empresa_id: E,
        conversation_id: C,
        flow_code: F,
        status: "completed",
        created_at: "2026-11-20T10:00:00Z",
        revendedor_id: over.prevRev ?? "rev-jose",
        codigo_referido_snapshot: "RevJose",
        referral_source: "click_token",
      },
    ],
    chat_flows: [{ empresa_id: E, flow_code: F, activo: true, channel: "whatsapp", sorteo_id: SORTEO, flow_config: {} }],
    chat_flow_nodes: [{ empresa_id: E, flow_code: F, node_code: "Mensaje_de_bienvenida", activo: true, orden: 1 }],
    sorteo_revendedores: [
      { id: "rev-jose", empresa_id: E, sorteo_id: SORTEO, codigo_referido: "RevJose", activo: true },
      { id: "rev-luci", empresa_id: E, sorteo_id: SORTEO, codigo_referido: "RevLuci", activo: true },
      { id: "rev-baja", empresa_id: E, sorteo_id: SORTEO, codigo_referido: "RevBaja", activo: false },
      { id: "rev-oct", empresa_id: E, sorteo_id: SORTEO_VIEJO, codigo_referido: "RevOct", activo: true },
    ],
  };
}

function newSession(db: Db): Row {
  const s = db.chat_flow_sessions.filter((r) => r.id !== "s-viejo" && r.id !== "s-act");
  assert(s.length === 1, `sesiones nuevas=${s.length}`);
  return s[0];
}

(async () => {
  const { restartWhatsappConversationToFlowStart } = await import("../src/lib/chat/resolve-whatsapp-active-flow");
  const { findInheritableRevendedor } = await import("../src/lib/sorteos/referral-inheritance");
  const { applySorteoReferralToActiveSession } = await import("../src/lib/sorteos/referral-attribution");
  type ApplyParams = Parameters<typeof applySorteoReferralToActiveSession>[0];
  const quiet = { warn: console.warn, info: console.info, error: console.error, log: console.log };
  const out = console.log;
  let passed = 0;
  const OK = (m: string) => {
    passed += 1;
    out("OK:", m);
  };
  console.warn = console.info = console.error = console.log = () => undefined;
  try {
    for (const trigger of ["restart_keyword", "invalid_current_node", "purchase_intent"]) {
      const db = baseDb();
      const rr = await restartWhatsappConversationToFlowStart(fakeSupabase(db), E, C, { trigger });
      assert(rr.restarted, `no reinició (${rr.reason})`);
      const s = newSession(db);
      assert(s.revendedor_id === "rev-jose", `${trigger}: rev=${String(s.revendedor_id)}`);
      assert((s.referral_source ?? null) === null, `${trigger}: source=${String(s.referral_source)}`);
      assert(s.codigo_referido_snapshot === "RevJose", "snapshot");
    }
    OK('caso José: reinicio tras compra ("boletas", nodo inválido, intención) → la sesión nueva hereda RevJose');

    {
      const db = baseDb({ pointer: "s-viejo" });
      await restartWhatsappConversationToFlowStart(fakeSupabase(db), E, C, {
        trigger: "purchase_intent",
        preserveReferralFromPreviousSession: true,
      });
      assert(newSession(db).revendedor_id === "rev-jose", "con puntero");
    }
    OK("reinicio con sesión activa previa → hereda igual que antes");

    for (const prevRev of ["rev-baja", "rev-oct"]) {
      const db = baseDb({ prevRev });
      await restartWhatsappConversationToFlowStart(fakeSupabase(db), E, C, { trigger: "restart_keyword" });
      assert((newSession(db).revendedor_id ?? null) === null, `${prevRev} no debía heredarse`);
    }
    OK("revendedor inactivo o de otro sorteo → NO se hereda (no cross-acredita)");

    {
      const db = baseDb({ prevRev: "rev-oct", pointer: "s-viejo" });
      await restartWhatsappConversationToFlowStart(fakeSupabase(db), E, C, {
        trigger: "purchase_intent",
        preserveReferralFromPreviousSession: true,
      });
      const s = newSession(db);
      assert(s.revendedor_id === "rev-oct" && (s.referral_source ?? null) === null, "copia previa");
    }
    OK("caminos que ya copiaban (preserve) siguen copiando como antes; la orden lo remapea por código");

    {
      const db = baseDb();
      const sb = fakeSupabase(db);
      await restartWhatsappConversationToFlowStart(sb, E, C, { trigger: "restart_keyword" });
      const s = newSession(db);
      await applySorteoReferralToActiveSession({
        supabase: sb,
        empresaId: E,
        conversationId: C,
        activeFlowSessionId: String(s.id),
        flowCode: F,
        inboundText: "Hola ref=RevLuci",
        contactPhoneDigits: "595981000000",
      } as unknown as ApplyParams);
      assert(s.revendedor_id === "rev-luci" && s.referral_source === "inbound_text", `rev=${String(s.revendedor_id)}`);
    }
    OK("heredado RevJose + el cliente llega con el código de RevLuci → manda RevLuci");

    {
      const db = baseDb();
      db.chat_flow_sessions.push({
        id: "s-act",
        empresa_id: E,
        conversation_id: C,
        flow_code: F,
        status: "active",
        created_at: "2026-11-24T10:00:00Z",
        revendedor_id: "rev-jose",
        codigo_referido_snapshot: "RevJose",
        referral_source: "click_token",
      });
      await applySorteoReferralToActiveSession({
        supabase: fakeSupabase(db),
        empresaId: E,
        conversationId: C,
        activeFlowSessionId: "s-act",
        flowCode: F,
        inboundText: "ref=RevLuci",
        contactPhoneDigits: "595981000000",
      } as unknown as ApplyParams);
      const s = db.chat_flow_sessions.find((r) => r.id === "s-act");
      assert(s?.revendedor_id === "rev-jose", "pisó una atribución directa");
    }
    OK("atribución directa (link) en la misma sesión → NO se pisa (como siempre)");

    {
      const sb = fakeSupabase(baseDb({ prevRev: "rev-oct", firstRev: "rev-luci" }));
      const base = { chatDb: sb, revDb: sb, empresaId: E, conversationId: C, sorteoId: SORTEO };
      const inh = await findInheritableRevendedor({ ...base, includeFirstRevendedor: true });
      assert(inh?.revendedorId === "rev-luci" && inh.origen === "first_revendedor", JSON.stringify(inh));
      assert((await findInheritableRevendedor(base)) === null, "sin first no debía encontrar");
      const sb2 = fakeSupabase(baseDb({ prevRev: "rev-oct", firstRev: "rev-oct" }));
      const none2 = await findInheritableRevendedor({ ...base, chatDb: sb2, revDb: sb2, includeFirstRevendedor: true });
      assert(none2 === null, "first de otro sorteo");
    }
    OK("orden sin revendedor en la sesión → usa first_revendedor_id solo si es del mismo sorteo y activo");
  } finally {
    Object.assign(console, quiet);
  }
  console.log(`\n${passed} pruebas OK`);
})().catch((e) => {
  console.error("FALLO:", e instanceof Error ? e.stack : e);
  process.exit(1);
});
