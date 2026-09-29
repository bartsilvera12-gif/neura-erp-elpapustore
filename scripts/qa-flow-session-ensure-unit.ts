/**
 * QA unitario (sin DB real): `ensureActiveFlowSessionForConversation` no debe tirar a la basura
 * una sesión en uso.
 *
 * Contexto (diagnóstico 29-sep, Papu_store): 15 sesiones en plena carga de datos (16 a 65 datos,
 * último evento hacía segundos) se abandonaron con `ensure_active_session_recovered_stale_pointer`
 * y se crearon otras vacías; en un caso se crearon 4 sesiones en el mismo segundo. El cliente
 * perdía lo ya cargado y el bot le volvía a preguntar o quedaba trabado.
 *
 * Ejecutar: npx tsx scripts/qa-flow-session-ensure-unit.ts
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

/**
 * Supabase en memoria: el subconjunto encadenable que usa flow-session-service
 * (select/insert/update + eq/is/gte/order/limit + maybeSingle/single).
 * `failSelectOn` hace fallar la próxima lectura de esa tabla (API caída un momento).
 */
function fakeSupabase(db: Db, opts: { failSelectOn?: Set<string> } = {}) {
  let seq = 1000;
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
        inserted = [{ id: `sess-${seq++}`, created_at: new Date().toISOString(), ...row }];
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
      gte(c: string, v: string) {
        filters.push((r) => String(r[c]) >= v);
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
      if (opts.failSelectOn?.has(table)) {
        opts.failSelectOn.delete(table);
        return { data: null, error: { message: "<html><title>520: Web server is returning an unknown error</title></html>" } };
      }
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

const E = "emp-1";
const C = "conv-1";
const F = "Papu_store";
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

function baseDb(pointer: string | null, sessions: Row[]): Db {
  return {
    chat_conversations: [{ id: C, empresa_id: E, flow_code: F, active_flow_session_id: pointer }],
    chat_flow_sessions: sessions.map((s) => ({ empresa_id: E, conversation_id: C, flow_code: F, ...s })),
  };
}
const statusOf = (db: Db, id: string) => db.chat_flow_sessions.find((s) => s.id === id)?.status;
const pointerOf = (db: Db) => db.chat_conversations[0].active_flow_session_id;

(async () => {
  const { ensureActiveFlowSessionForConversation } = await import("../src/lib/chat/flow-session-service");
  const quiet = { warn: console.warn, info: console.info, error: console.error };
  console.warn = console.info = console.error = () => undefined;
  try {
    {
      const db = baseDb("s-en-uso", [{ id: "s-en-uso", status: "active", created_at: ago(5 * 60e3) }]);
      const sid = await ensureActiveFlowSessionForConversation(fakeSupabase(db), E, C, F);
      assert(sid === "s-en-uso" && db.chat_flow_sessions.length === 1, "caso normal");
      ok("puntero a sesión activa → se usa esa (sin cambios)");
    }
    {
      const db = baseDb("s-en-uso", [{ id: "s-en-uso", status: "active", created_at: ago(5 * 60e3) }]);
      const sb = fakeSupabase(db, { failSelectOn: new Set(["chat_flow_sessions"]) });
      const sid = await ensureActiveFlowSessionForConversation(sb, E, C, F);
      assert(sid === "s-en-uso", `lectura fallida devolvió ${sid}`);
      assert(statusOf(db, "s-en-uso") === "active", "la sesión en uso quedó abandonada");
      assert(db.chat_flow_sessions.length === 1, "se creó una sesión nueva");
      ok("caso real: lectura de la sesión falla (520) → NO se abandona la sesión con los datos del cliente");
    }
    {
      // Dos webhooks del mismo cliente: el otro ya reemplazó la sesión y creó una nueva hace 1 s.
      const db = baseDb("s-vieja", [
        { id: "s-vieja", status: "abandoned", created_at: ago(60e3) },
        { id: "s-nueva", status: "active", created_at: ago(1000) },
      ]);
      const sid = await ensureActiveFlowSessionForConversation(fakeSupabase(db), E, C, F);
      assert(sid === "s-nueva", `adoptó ${sid}`);
      assert(statusOf(db, "s-nueva") === "active", "abandonó la sesión recién creada por el otro webhook");
      assert(db.chat_flow_sessions.length === 2, "creó una tercera sesión");
      assert(pointerOf(db) === "s-nueva", "el puntero no quedó en la sesión adoptada");
      ok("caso real: dos webhooks en paralelo → se adopta la sesión recién creada (antes: 4 sesiones en 1 s)");
    }
    {
      // Compra terminada: sesión completed, sin activa → comportamiento de siempre: sesión nueva.
      const db = baseDb("s-completa", [{ id: "s-completa", status: "completed", created_at: ago(10 * 60e3) }]);
      const sid = await ensureActiveFlowSessionForConversation(fakeSupabase(db), E, C, F);
      assert(sid != null && sid !== "s-completa" && statusOf(db, sid) === "active", "no creó sesión nueva");
      assert(pointerOf(db) === sid, "puntero no actualizado");
      ok("compra finalizada → se crea sesión nueva como siempre (sin revivir la anterior)");
    }
    {
      // Sesión activa OLVIDADA de días atrás (dato real: activa desde el 23-sep): no se revive.
      const db = baseDb("s-completa", [
        { id: "s-completa", status: "completed", created_at: ago(10 * 60e3) },
        { id: "s-olvidada", status: "active", created_at: ago(6 * 24 * 3600e3) },
      ]);
      const sid = await ensureActiveFlowSessionForConversation(fakeSupabase(db), E, C, F);
      assert(sid !== "s-olvidada", "revivió una sesión vieja con datos de otra compra");
      assert(statusOf(db, "s-olvidada") === "abandoned", "la sesión olvidada no se cerró");
      ok("sesión activa vieja olvidada → se cierra y se crea una nueva (no mezcla compras)");
    }
    {
      // Otro handler ya movió el puntero a la sesión recién creada: el CAS no lo pisa.
      const db = baseDb(null, [{ id: "s-nueva", status: "active", created_at: ago(500) }]);
      const sid = await ensureActiveFlowSessionForConversation(fakeSupabase(db), E, C, F);
      assert(sid === "s-nueva" && pointerOf(db) === "s-nueva", `puntero null → ${sid}`);
      ok("puntero vacío con sesión recién creada por otro handler → se adopta");
    }
  } finally {
    Object.assign(console, quiet);
  }
  console.log(`\n${passed} pruebas OK`);
})().catch((e) => {
  console.error("FALLO:", e instanceof Error ? e.message : e);
  process.exit(1);
});
