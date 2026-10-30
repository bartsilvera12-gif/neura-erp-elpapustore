import type { Pool } from "pg";

/**
 * Etiquetas Automáticas - optimización del clasificador.
 *
 * Guard multi-tenant: detecta si el schema expone la función set-based
 * `chat_tag_purchase_category_bulk(empresa_id)`, que clasifica TODAS las
 * conversaciones en una sola pasada (vs la versión fila-por-fila
 * `chat_tag_purchase_category(id)`, que con decenas de miles de candidatas
 * tardaba ~165 s y saturaba la base compartida).
 *
 * Cuando existe, los consumidores (dry-run, cron) la usan y hacen un JOIN;
 * cuando no, caen a la función fila-por-fila original. Así el rollout es
 * gradual por schema sin tocar los tenants que todavía no la tienen.
 *
 * READ-ONLY (consulta `pg_proc`) y cacheado por schema en memoria del proceso,
 * igual que `schemaHasHiddenByTagColumn`.
 */

const cache = new Map<string, boolean>();

export function clearHasBulkCategoryFnCache(schema?: string): void {
  if (schema) cache.delete(schema);
  else cache.clear();
}

export async function schemaHasBulkCategoryFn(pool: Pool, schema: string): Promise<boolean> {
  if (!schema) return false;
  if (cache.has(schema)) return cache.get(schema) === true;
  try {
    const r = await pool.query(
      `SELECT 1
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = $1
          AND p.proname = 'chat_tag_purchase_category_bulk'
        LIMIT 1`,
      [schema]
    );
    const has = (r.rowCount ?? 0) > 0;
    cache.set(schema, has);
    return has;
  } catch {
    // Ante cualquier error, ser conservador y usar la función fila-por-fila.
    cache.set(schema, false);
    return false;
  }
}
