-- =============================================================================
-- Sorteos: bloqueo de participantes.
--
-- Permite impedir que una persona (identificada por su número de WhatsApp) vuelva a comprar,
-- SIN borrar su historial ni sus comprobantes. Se puede desbloquear.
--
-- El bloqueo es por empresa + número de WhatsApp (que es como el bot identifica a la gente).
-- Las tres vías de venta (bot, cupón manual, n8n) consultan esta tabla antes de crear la orden.
--
-- Multi-schema: se crea en todo schema que tenga `sorteo_entradas` (public, zentra_erp,
-- tenants erp_*/er_* y los dedicados single_client como `elpapustore_erp`). Idempotente.
-- Enumera por EXISTENCIA de la tabla, nunca por patrón de nombre, para no saltear schemas.
-- =============================================================================

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT n.nspname AS sch
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'sorteo_entradas'
      AND c.relkind = 'r'
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg_%'
  LOOP
    BEGIN
      EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I.sorteo_participantes_bloqueados (
           id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
           empresa_id      uuid NOT NULL,
           whatsapp_numero text NOT NULL,
           motivo          text,
           bloqueado_por   text,
           bloqueado_at    timestamptz NOT NULL DEFAULT now(),
           CONSTRAINT sorteo_participantes_bloqueados_empresa_wa_key
             UNIQUE (empresa_id, whatsapp_numero)
         )',
        r.sch
      );
      -- Búsqueda rápida del guard: WHERE empresa_id = ? AND whatsapp_numero = ?
      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS sorteo_participantes_bloqueados_lookup_idx
           ON %I.sorteo_participantes_bloqueados (empresa_id, whatsapp_numero)',
        r.sch
      );
      EXECUTE format(
        'COMMENT ON TABLE %I.sorteo_participantes_bloqueados IS %L',
        r.sch,
        'Participantes bloqueados para comprar en sorteos (por número de WhatsApp). No borra historial.'
      );
    EXCEPTION WHEN others THEN
      /** Un schema problemático no debe abortar el resto de la migración. */
      RAISE NOTICE 'sorteo_participantes_bloqueados [%]: %', r.sch, SQLERRM;
    END;
  END LOOP;
END $$;
