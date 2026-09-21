-- =============================================================================
-- Sorteos: teléfono de contacto DECLARADO por el comprador.
--
-- `whatsapp_numero` es la línea desde la que escribe (Meta la usa para entregarle el ticket).
-- La boleta, en cambio, debe mostrar el celular que la persona cargó y confirmó en el flujo:
-- puede comprar desde el teléfono de un familiar o dejar otro número de contacto.
--
-- Columna nullable y sin backfill: las órdenes anteriores siguen mostrando el WhatsApp como
-- respaldo (`buildSorteoTicketRenderData`), no quedan sin teléfono impreso.
--
-- Multi-schema: recorre TODO schema que tenga la tabla (public, zentra_erp, tenant er_*/erp_*
-- y los schemas dedicados single_client como `elpapustore_erp`, que no matchean `erp\_%`).
-- No asume que las tablas existan en `public`: en una instancia single_client viven sólo en el
-- schema del cliente, y un ALTER directo sobre public corta la migración entera con 42P01.
-- Idempotente: se puede correr de nuevo sin efecto.
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
        'ALTER TABLE %I.sorteo_entradas ADD COLUMN IF NOT EXISTS telefono_contacto text',
        r.sch
      );
      EXECUTE format(
        'COMMENT ON COLUMN %I.sorteo_entradas.telefono_contacto IS %L',
        r.sch,
        'Celular declarado por el comprador en el flujo / carga manual. Es el que se imprime en la boleta; whatsapp_numero es la línea remitente.'
      );
    EXCEPTION WHEN others THEN
      /** Un schema sin permisos o con la tabla a medio instalar no aborta el resto. */
      RAISE NOTICE 'sorteo_entradas.telefono_contacto [%]: %', r.sch, SQLERRM;
    END;
  END LOOP;
END $$;

-- -----------------------------------------------------------------------------
-- `clientes.telefono_secundario`: el mismo dato del lado CRM. `clientes.telefono` sigue siendo
-- el WhatsApp, porque es la clave con la que la recompra rápida reconoce al comprador.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT n.nspname AS sch
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'clientes'
      AND c.relkind = 'r'
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg_%'
  LOOP
    BEGIN
      EXECUTE format(
        'ALTER TABLE %I.clientes ADD COLUMN IF NOT EXISTS telefono_secundario text',
        r.sch
      );
      EXECUTE format(
        'COMMENT ON COLUMN %I.clientes.telefono_secundario IS %L',
        r.sch,
        'Celular declarado por el cliente. telefono guarda el WhatsApp con el que escribe (clave de la recompra rápida).'
      );
    EXCEPTION WHEN others THEN
      RAISE NOTICE 'clientes.telefono_secundario [%]: %', r.sch, SQLERRM;
    END;
  END LOOP;
END $$;
