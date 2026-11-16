import "server-only";

/**
 * Tareas de cada minuto del lado servidor (mismo esquema que `campaign-pump`: arranca con
 * `instrumentation.register`, sin depender del navegador ni de una tarea programada externa):
 *
 * Cierre de ventas: pasa a `cerrado` los sorteos activos cuya `fecha_sorteo` ya llegó.
 *
 * La ruta `/api/cron/sorteos-cierre` sigue disponible para simular (`?dryRun=1`) o disparar a mano.
 */
const INTERVAL_MS = 60_000;
const LOG = "[automation-pump]";

let started = false;
let running = false;

/** Idempotente: arranca el loop una sola vez por proceso. */
export function startAutomationPump(): void {
  if (started) return;
  started = true;
  console.info(LOG, "iniciado", { intervalMs: INTERVAL_MS });
  const timer = setInterval(() => {
    void tick();
  }, INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();
}

async function tick(): Promise<void> {
  if (running) return; // no se solapan
  running = true;
  try {
    const { getSingleClientSchemaOrNull } = await import("@/lib/instance/single-client");
    const { assertAllowedChatDataSchema } = await import("@/lib/supabase/chat-data-schema");
    const { getChatPostgresPool } = await import("@/lib/supabase/chat-pg-pool");
    const raw = getSingleClientSchemaOrNull();
    if (!raw) return;
    const schema = assertAllowedChatDataSchema(raw);
    const pool = getChatPostgresPool();
    if (!pool) return;
    const emp = await pool.query<{ id: string }>(`SELECT id::text AS id FROM "${schema}".empresas LIMIT 1`);
    const empresaId = emp.rows[0]?.id;
    if (!empresaId) return;

    try {
      const { cerrarSorteosVencidos } = await import("@/lib/sorteos/sorteo-cierre-ventas");
      const cerrados = await cerrarSorteosVencidos(pool, schema, empresaId);
      if (cerrados.length > 0) console.info(LOG, "sorteos cerrados por fecha", cerrados);
    } catch (e) {
      console.error(LOG, "cierre de sorteos", e instanceof Error ? e.message : e);
    }
  } catch (e) {
    console.error(LOG, "tick error", e instanceof Error ? e.message : e);
  } finally {
    running = false;
  }
}
