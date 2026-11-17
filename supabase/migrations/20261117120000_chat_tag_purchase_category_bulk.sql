-- Fase 4F - Etiquetas Automáticas · clasificador set-based (bulk)
--
-- Gemela set-based de chat_tag_purchase_category(p_conversation_id) creada en
-- 20260526001500_chat_tag_purchase_category_v2_whatsapp.sql. Clasifica TODAS las
-- conversaciones de la empresa en UNA sola pasada (CTEs agregadas sobre
-- sorteo_entradas / sorteo_cupones / chat_comprobante_validaciones /
-- chat_flow_sessions / chat_flow_data) en vez de una llamada por conversación.
--
-- Motivación: la versión fila-por-fila, invocada por el dry-run en vivo y por el
-- cron chat-tags-daily (una vez por bucket) sobre decenas de miles de
-- conversaciones, tardaba ~165 s y saturaba la base compartida (incidente
-- 28-oct-2026). El bulk hace el mismo trabajo en ~2 s. Los consumidores
-- (dry-run-shared.ts, cron chat-tags-daily) detectan la función con
-- schemaHasBulkCategoryFn y, si existe, la usan vía JOIN/CTE; si no, caen a la
-- fila-por-fila. Por eso versionarla es seguro: su ausencia no rompe nada.
--
-- LÓGICA IDÉNTICA a la fila-por-fila — paridad verificada sobre datos reales:
-- cobertura 100 % (68668/68668 conversaciones) y 0 diferencias en muestras
-- aleatorias. El árbol de decisión CASE replica exactamente el de la función v2.
--
-- IDEMPOTENTE: CREATE OR REPLACE. Sólo crea/reemplaza la función; no toca tablas
-- ni datos operativos.

CREATE OR REPLACE FUNCTION erp_el_papu_store_5ad0bdda.chat_tag_purchase_category_bulk(p_empresa_id uuid)
RETURNS TABLE(conversation_id uuid, category text)
LANGUAGE sql
STABLE
SET search_path TO 'erp_el_papu_store_5ad0bdda', 'pg_catalog'
AS $function$
  WITH ent AS (
    SELECT se.chat_conversation_id AS cid,
           COALESCE(SUM(GREATEST(COALESCE(se.cantidad_boletos,1),1)),0) AS total_boletos,
           COUNT(DISTINCT se.sorteo_id) AS distinct_sorteos,
           COUNT(*) FILTER (WHERE se.numero_orden IS NOT NULL) AS entries_with_order
    FROM erp_el_papu_store_5ad0bdda.sorteo_entradas se
    WHERE se.chat_conversation_id IS NOT NULL
    GROUP BY se.chat_conversation_id
  ),
  cup AS (
    SELECT se.chat_conversation_id AS cid, COUNT(sc.id) AS cupones_total
    FROM erp_el_papu_store_5ad0bdda.sorteo_entradas se
    JOIN erp_el_papu_store_5ad0bdda.sorteo_cupones sc ON sc.entrada_id = se.id
    WHERE se.chat_conversation_id IS NOT NULL
    GROUP BY se.chat_conversation_id
  ),
  val AS (
    SELECT cv.conversation_id AS cid, COUNT(*) AS pending
    FROM erp_el_papu_store_5ad0bdda.chat_comprobante_validaciones cv
    WHERE COALESCE(cv.estado_validacion,'') NOT IN ('','rechazado','descartado')
    GROUP BY cv.conversation_id
  ),
  aba AS (
    SELECT DISTINCT fs.conversation_id AS cid
    FROM erp_el_papu_store_5ad0bdda.chat_flow_sessions fs
    WHERE fs.status = 'abandoned' OR COALESCE(fs.end_reason,'') = 'abandoned'
  ),
  dat AS (
    SELECT fd.conversation_id AS cid,
           bool_or(lower(coalesce(fd.field_name,'')) IN ('cedula','documento','ci','dni')
                   AND coalesce(fd.field_value,'') <> '') AS has_cedula,
           bool_or(lower(coalesce(fd.field_name,'')) IN ('nombre','first_name')
                   AND coalesce(fd.field_value,'') <> '') AS has_nombre,
           bool_or(lower(coalesce(fd.field_name,'')) IN ('apellido','last_name','surname')
                   AND coalesce(fd.field_value,'') <> '') AS has_apellido
    FROM erp_el_papu_store_5ad0bdda.chat_flow_data fd
    GROUP BY fd.conversation_id
  )
  SELECT c.id,
    CASE
      WHEN ( c.flow_current_node = 'compra_realizada'
             OR COALESCE(cup.cupones_total,0) > 0
             OR COALESCE(ent.entries_with_order,0) > 0 ) THEN
        CASE
          WHEN COALESCE(ent.total_boletos,0) > 0 THEN
            CASE WHEN COALESCE(ent.distinct_sorteos,0) > 1 THEN 'repurchased'
                 WHEN ent.total_boletos > 1 THEN 'purchased_multiple_tickets'
                 ELSE 'purchased_once' END
          WHEN COALESCE(cup.cupones_total,0) > 0 THEN
            CASE WHEN cup.cupones_total > 1 THEN 'purchased_multiple_tickets'
                 ELSE 'purchased_once' END
          ELSE 'purchased_once'
        END
      WHEN COALESCE(val.pending,0) > 0 THEN 'payment_received_incomplete'
      WHEN aba.cid IS NOT NULL THEN 'abandoned'
      WHEN ( NOT COALESCE(dat.has_cedula,false)
             OR NOT COALESCE(dat.has_nombre,false)
             OR NOT COALESCE(dat.has_apellido,false) ) THEN 'data_incomplete'
      ELSE 'no_purchase'
    END AS category
  FROM erp_el_papu_store_5ad0bdda.chat_conversations c
  LEFT JOIN ent ON ent.cid = c.id
  LEFT JOIN cup ON cup.cid = c.id
  LEFT JOIN val ON val.cid = c.id
  LEFT JOIN aba ON aba.cid = c.id
  LEFT JOIN dat ON dat.cid = c.id
  WHERE c.empresa_id = p_empresa_id;
$function$;

-- GRANTs de ejecución (API + cron). Reproduce el estado vivo de la función.
GRANT EXECUTE ON FUNCTION erp_el_papu_store_5ad0bdda.chat_tag_purchase_category_bulk(uuid) TO anon;
GRANT EXECUTE ON FUNCTION erp_el_papu_store_5ad0bdda.chat_tag_purchase_category_bulk(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION erp_el_papu_store_5ad0bdda.chat_tag_purchase_category_bulk(uuid) TO service_role;
