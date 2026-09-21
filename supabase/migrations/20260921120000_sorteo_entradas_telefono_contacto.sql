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
-- Recorre TODOS los schemas donde exista cada tabla — `public`, la plantilla `zentra_erp` y los
-- tenants `erp_*` / `er_*` — sin asumir que alguno esté instalado: hay bases donde los sorteos
-- viven sólo en el schema del tenant y `public.sorteo_entradas` no existe (42P01).
-- Idempotente: se puede correr de nuevo sin efecto.
-- =============================================================================

DO $$
DECLARE
  sch text;
BEGIN
  FOR sch IN
    -- pg_catalog en vez de information_schema: este último oculta las tablas sobre las que
    -- el rol actual no tiene privilegios, y ahí un schema quedaría sin la columna en silencio.
    SELECT n.nspname::text
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'sorteo_entradas'
      AND c.relkind IN ('r', 'p')
      AND (
        n.nspname = 'public'
        OR n.nspname = 'zentra_erp'
        OR n.nspname ~ '^erp_[a-zA-Z0-9_]+$'
        OR n.nspname ~ '^er_[0-9a-f]{32}$'
      )
  LOOP
    BEGIN
      EXECUTE format(
        'ALTER TABLE %I.sorteo_entradas ADD COLUMN IF NOT EXISTS telefono_contacto text;',
        sch
      );
      EXECUTE format(
        'COMMENT ON COLUMN %I.sorteo_entradas.telefono_contacto IS %L;',
        sch,
        'Celular declarado por el comprador en el flujo / carga manual. Es el que se imprime en la boleta; whatsapp_numero es la línea remitente.'
      );
      RAISE NOTICE 'sorteo_entradas.telefono_contacto listo en %', sch;
    EXCEPTION WHEN undefined_table OR insufficient_privilege THEN
      RAISE NOTICE 'sorteo_entradas.telefono_contacto omitido en %: %', sch, SQLERRM;
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
    -- pg_catalog en vez de information_schema: este último oculta las tablas sobre las que
    -- el rol actual no tiene privilegios, y ahí un schema quedaría sin la columna en silencio.
    SELECT n.nspname::text
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'clientes'
      AND c.relkind IN ('r', 'p')
      AND (
        n.nspname = 'public'
        OR n.nspname = 'zentra_erp'
        OR n.nspname ~ '^erp_[a-zA-Z0-9_]+$'
        OR n.nspname ~ '^er_[0-9a-f]{32}$'
      )
  LOOP
    BEGIN
      EXECUTE format(
        'ALTER TABLE %I.clientes ADD COLUMN IF NOT EXISTS telefono_secundario text;',
        sch
      );
      RAISE NOTICE 'clientes.telefono_secundario listo en %', sch;
    EXCEPTION WHEN undefined_table OR insufficient_privilege THEN
      RAISE NOTICE 'clientes.telefono_secundario omitido en %: %', sch, SQLERRM;
    END;
  END LOOP;
END;
$$;
