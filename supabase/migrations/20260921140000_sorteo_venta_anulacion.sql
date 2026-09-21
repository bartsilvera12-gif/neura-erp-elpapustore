-- =============================================================================
-- Sorteos: anulación de una venta.
--
-- Anular una orden significa tres cosas a la vez:
--   1. la venta deja de contar (sale de los KPIs y de las listas operativas),
--   2. sus cupones NO participan del sorteo,
--   3. se libera cupo en el sorteo (`total_boletos_vendidos` baja) para poder vender otro
--      boleto en su lugar.
--
-- Lo que NO se toca a propósito: `sorteos.ultimo_numero_cupon`. Los números de cupón anulados
-- quedan quemados y no se reasignan nunca. El comprador anulado ya tiene su boleta impresa en
-- el WhatsApp con ese número: si el número volviera al pool, dos personas tendrían el mismo.
--
-- Multi-schema: recorre todo schema que tenga las tablas (public, zentra_erp, tenants erp_*/er_*
-- y los schemas dedicados single_client como `elpapustore_erp`). Idempotente.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- sorteo_entradas: nuevo estado `anulado` + auditoría de la anulación.
-- -----------------------------------------------------------------------------
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
        'ALTER TABLE %I.sorteo_entradas
           ADD COLUMN IF NOT EXISTS anulada_at timestamptz,
           ADD COLUMN IF NOT EXISTS anulada_por text,
           ADD COLUMN IF NOT EXISTS anulacion_motivo text',
        r.sch
      );
      EXECUTE format(
        'ALTER TABLE %I.sorteo_entradas DROP CONSTRAINT IF EXISTS sorteo_entradas_estado_pago_check',
        r.sch
      );
      EXECUTE format(
        'ALTER TABLE %I.sorteo_entradas ADD CONSTRAINT sorteo_entradas_estado_pago_check
           CHECK (estado_pago IN (''pendiente'', ''pendiente_revision'', ''confirmado'', ''rechazado'', ''anulado''))',
        r.sch
      );
      EXECUTE format(
        'COMMENT ON COLUMN %I.sorteo_entradas.anulacion_motivo IS %L',
        r.sch,
        'Motivo cargado por el operador al anular la venta. Sólo interno.'
      );
    EXCEPTION WHEN others THEN
      /** Un schema con datos que violan el CHECK no debe abortar el resto de la migración. */
      RAISE NOTICE 'sorteo_entradas anulacion [%]: %', r.sch, SQLERRM;
    END;
  END LOOP;
END $$;

-- -----------------------------------------------------------------------------
-- sorteo_cupones: marca por cupón. El filtro operativo se hace por
-- `sorteo_entradas.estado_pago`, que existe desde siempre; esta columna es el registro
-- explícito de qué números quedaron fuera del sorteo.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT n.nspname AS sch
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'sorteo_cupones'
      AND c.relkind = 'r'
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg_%'
  LOOP
    BEGIN
      EXECUTE format(
        'ALTER TABLE %I.sorteo_cupones ADD COLUMN IF NOT EXISTS anulado_at timestamptz',
        r.sch
      );
      EXECUTE format(
        'COMMENT ON COLUMN %I.sorteo_cupones.anulado_at IS %L',
        r.sch,
        'Cupón anulado: no participa del sorteo. Su número NO se reasigna.'
      );
    EXCEPTION WHEN others THEN
      RAISE NOTICE 'sorteo_cupones anulado_at [%]: %', r.sch, SQLERRM;
    END;
  END LOOP;
END $$;
