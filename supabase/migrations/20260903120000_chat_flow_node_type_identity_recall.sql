-- =============================================================================
-- Recompra rápida: nuevo node_type 'identity_recall' en chat_flow_nodes.
--
-- El nodo muestra los datos registrados del comprador y ofrece confirmar o cargar otros.
-- Cuando el teléfono no está registrado el motor lo saltea sin enviar nada, así que para un
-- comprador nuevo el paso es invisible.
--
-- Multi-schema: recorre TODO schema que tenga la tabla (public, zentra_erp, tenant er_*/erp_*
-- y los schemas dedicados single_client como `elpapustore_erp`, que no matchean `erp\_%`).
-- Idempotente: recrea el CHECK con la lista completa de tipos.
-- =============================================================================

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT n.nspname AS sch
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'chat_flow_nodes'
      AND c.relkind = 'r'
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg_%'
  LOOP
    BEGIN
      EXECUTE format(
        'ALTER TABLE %I.chat_flow_nodes DROP CONSTRAINT IF EXISTS chat_flow_nodes_node_type_check',
        r.sch
      );
      EXECUTE format(
        $sql$
          ALTER TABLE %I.chat_flow_nodes
          ADD CONSTRAINT chat_flow_nodes_node_type_check
          CHECK (node_type IN (
            'buttons', 'list', 'text', 'media', 'image_input', 'human', 'end', 'identity_recall'
          ))
        $sql$,
        r.sch
      );
    EXCEPTION WHEN others THEN
      /** Un schema con datos que violan el CHECK no debe abortar el resto de la migración. */
      RAISE NOTICE 'chat_flow_nodes node_type check [%]: %', r.sch, SQLERRM;
    END;
  END LOOP;
END $$;
