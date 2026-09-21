-- =============================================================================
-- Sorteos: teléfono de contacto DECLARADO por el comprador.
--
-- `whatsapp_numero` es la línea desde la que escribe (Meta la usa para entregarle el ticket).
-- La boleta, en cambio, debe mostrar el celular que la persona cargó y confirmó en el flujo:
-- puede comprar desde el teléfono de un familiar o dejar otro número de contacto.
--
-- Columna nullable y sin backfill: las órdenes anteriores siguen mostrando el WhatsApp como
-- respaldo (`buildSorteoTicketRenderData`), no quedan sin teléfono impreso.
-- Réplica multi-schema, igual que el resto de columnas de sorteo_entradas.
-- =============================================================================

ALTER TABLE public.sorteo_entradas
  ADD COLUMN IF NOT EXISTS telefono_contacto text;

COMMENT ON COLUMN public.sorteo_entradas.telefono_contacto IS
  'Celular declarado por el comprador en el flujo / carga manual. Es el que se imprime en la boleta; whatsapp_numero es la línea remitente.';

-- Plantilla zentra_erp
ALTER TABLE zentra_erp.sorteo_entradas
  ADD COLUMN IF NOT EXISTS telefono_contacto text;

-- Schemas tenant erp_* / er_*
DO $$
DECLARE
  sch text;
BEGIN
  FOR sch IN
    SELECT nspname::text
    FROM pg_namespace
    WHERE (nspname ~ '^erp_[a-zA-Z0-9_]+$' OR nspname ~ '^er_[0-9a-f]{32}$')
      AND EXISTS (
        SELECT 1 FROM information_schema.tables t
        WHERE t.table_schema = nspname AND t.table_name = 'sorteo_entradas'
      )
  LOOP
    BEGIN
      EXECUTE format(
        'ALTER TABLE %I.sorteo_entradas ADD COLUMN IF NOT EXISTS telefono_contacto text;',
        sch
      );
    EXCEPTION WHEN undefined_table THEN
      RAISE NOTICE 'sorteo_entradas telefono_contacto skipped for schema %', sch;
    END;
  END LOOP;
END;
$$;

-- `clientes.telefono_secundario` guarda el mismo dato del lado CRM (telefono sigue siendo el
-- WhatsApp: es la clave con la que la recompra rápida reconoce al comprador).
DO $$
DECLARE
  sch text;
BEGIN
  FOR sch IN
    SELECT nspname::text
    FROM pg_namespace
    WHERE (nspname ~ '^erp_[a-zA-Z0-9_]+$' OR nspname ~ '^er_[0-9a-f]{32}$' OR nspname = 'zentra_erp')
      AND EXISTS (
        SELECT 1 FROM information_schema.tables t
        WHERE t.table_schema = nspname AND t.table_name = 'clientes'
      )
  LOOP
    BEGIN
      EXECUTE format(
        'ALTER TABLE %I.clientes ADD COLUMN IF NOT EXISTS telefono_secundario text;',
        sch
      );
    EXCEPTION WHEN undefined_table THEN
      RAISE NOTICE 'clientes telefono_secundario skipped for schema %', sch;
    END;
  END LOOP;
END;
$$;
