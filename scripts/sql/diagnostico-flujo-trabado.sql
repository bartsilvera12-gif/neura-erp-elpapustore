-- =============================================================================
-- Diagnóstico: clientes trabados y datos cargados en el campo equivocado.
--
-- Mide en producción cada mecanismo encontrado en el código, día por día, para ver cuál
-- explica el aumento de la semana y confirmar que el fix lo baja.
--
-- Schema: elpapustore_erp · Flujo: Papu_store. Correr UN BLOQUE POR VEZ. Ninguno escribe.
-- =============================================================================


-- #############################################################################
-- BLOQUE 1 — El grafo real del flujo.
-- Hace falta para revisar el orden de las preguntas y si algún campo choca con los alias de
-- teléfono (telefono / celular / movil / whatsapp / phone / mobile, en cualquier parte del nombre).
-- #############################################################################
SELECT
  n.sort_order,
  n.node_code,
  n.node_type,
  n.save_as_field,
  n.next_node_code,
  n.is_active,
  left(regexp_replace(coalesce(n.message_text, ''), '\s+', ' ', 'g'), 80) AS pregunta,
  (lower(coalesce(n.save_as_field, '')) ~ '(telefono|teléfono|celular|movil|móvil|whatsapp|phone|mobile)')
    AS matchea_alias_telefono,
  (
    SELECT string_agg(o.next_node_code, ', ')
    FROM elpapustore_erp.chat_flow_options o
    WHERE o.node_id = n.id
  ) AS salidas_por_boton
FROM elpapustore_erp.chat_flow_nodes n
WHERE n.flow_code = 'Papu_store'
ORDER BY n.is_active DESC, n.sort_order, n.created_at;


-- #############################################################################
-- BLOQUE 2 — Resumen por día (últimos 21 días). El más importante.
--
--   capturas            textos guardados como respuesta
--   dup_mismo_mensaje   capturas de un wa_message_id ya capturado antes (mismo mensaje procesado
--                       dos veces: la segunda copia cae en el campo siguiente)
--   fuera_de_pantalla   capturas guardadas en un nodo que NO era la última pregunta enviada
--                       (el cliente contestaba otra cosa: "ciudad guardada como teléfono")
--   rebobinados         veces que el gate de completitud movió el puntero hacia atrás
--   reenvio_manual      operadores apretando "Reenviar paso actual" (termómetro de trabados)
--   retoma_manual       aprobaciones manuales de comprobante que retoman la carga de datos
-- #############################################################################
WITH cap AS (
  SELECT
    e.id,
    e.created_at,
    e.conversation_id,
    e.flow_session_id,
    e.node_code,
    e.payload -> 'raw' ->> 'id' AS wa_id
  FROM elpapustore_erp.chat_flow_events e
  WHERE e.event_type = 'text_captured'
    AND e.flow_code = 'Papu_store'
    AND e.created_at >= now() - interval '21 days'
),
cap_marcada AS (
  SELECT
    c.*,
    /* ventana en vez de auto-join: la version anterior daba timeout en produccion */
    (
      c.wa_id IS NOT NULL
      AND row_number() OVER (PARTITION BY c.wa_id ORDER BY c.created_at, c.id) > 1
    ) AS es_duplicado,
    (
      SELECT ns.node_code
      FROM elpapustore_erp.chat_flow_events ns
      WHERE ns.conversation_id = c.conversation_id
        AND ns.flow_session_id = c.flow_session_id
        AND ns.event_type = 'node_sent'
        AND ns.created_at <= c.created_at
      ORDER BY ns.created_at DESC
      LIMIT 1
    ) AS pregunta_en_pantalla
  FROM cap c
),
por_dia_cap AS (
  SELECT
    date_trunc('day', created_at)::date AS dia,
    count(*) AS capturas,
    count(*) FILTER (WHERE es_duplicado) AS dup_mismo_mensaje,
    count(*) FILTER (
      WHERE pregunta_en_pantalla IS NOT NULL AND pregunta_en_pantalla <> node_code
    ) AS fuera_de_pantalla
  FROM cap_marcada
  GROUP BY 1
),
por_dia_otros AS (
  SELECT
    date_trunc('day', e.created_at)::date AS dia,
    count(*) FILTER (WHERE e.event_type = 'flow_completeness_pointer_adjusted') AS rebobinados,
    count(*) FILTER (WHERE e.event_type = 'manual_current_node_resent') AS reenvio_manual,
    count(*) FILTER (WHERE e.event_type = 'sorteo_manual_approval_pending_data') AS retoma_manual
  FROM elpapustore_erp.chat_flow_events e
  WHERE e.flow_code = 'Papu_store'
    AND e.created_at >= now() - interval '21 days'
    AND e.event_type IN (
      'flow_completeness_pointer_adjusted',
      'manual_current_node_resent',
      'sorteo_manual_approval_pending_data'
    )
  GROUP BY 1
)
SELECT
  coalesce(c.dia, o.dia) AS dia,
  coalesce(c.capturas, 0)            AS capturas,
  coalesce(c.dup_mismo_mensaje, 0)   AS dup_mismo_mensaje,
  coalesce(c.fuera_de_pantalla, 0)   AS fuera_de_pantalla,
  coalesce(o.rebobinados, 0)         AS rebobinados,
  coalesce(o.reenvio_manual, 0)      AS reenvio_manual,
  coalesce(o.retoma_manual, 0)       AS retoma_manual
FROM por_dia_cap c
FULL JOIN por_dia_otros o ON o.dia = c.dia
ORDER BY 1 DESC;


-- #############################################################################
-- BLOQUE 3 — Ejemplos concretos de "dato en el campo equivocado" (los últimos 30).
-- Cada fila: qué pregunta tenía el cliente en pantalla, en qué campo quedó su respuesta y qué
-- escribió. Sirve para mostrarle al cliente casos reales y confirmar el mecanismo.
-- #############################################################################
WITH cap AS (
  SELECT
    e.id,
    e.created_at,
    e.conversation_id,
    e.flow_session_id,
    e.node_code,
    e.payload ->> 'save_as_field' AS campo_guardado,
    left(e.payload ->> 'text_value', 40) AS texto
  FROM elpapustore_erp.chat_flow_events e
  WHERE e.event_type = 'text_captured'
    AND e.flow_code = 'Papu_store'
    AND e.created_at >= now() - interval '21 days'
)
SELECT
  c.created_at,
  ct.phone_number AS cliente,
  x.pregunta_en_pantalla,
  c.node_code AS nodo_donde_se_guardo,
  c.campo_guardado,
  c.texto
FROM cap c
CROSS JOIN LATERAL (
  SELECT ns.node_code AS pregunta_en_pantalla
  FROM elpapustore_erp.chat_flow_events ns
  WHERE ns.conversation_id = c.conversation_id
    AND ns.flow_session_id = c.flow_session_id
    AND ns.event_type = 'node_sent'
    AND ns.created_at <= c.created_at
  ORDER BY ns.created_at DESC
  LIMIT 1
) x
JOIN elpapustore_erp.chat_conversations cv ON cv.id = c.conversation_id
LEFT JOIN elpapustore_erp.chat_contacts ct ON ct.id = cv.contact_id
WHERE x.pregunta_en_pantalla <> c.node_code
ORDER BY c.created_at DESC
LIMIT 30;


-- #############################################################################
-- BLOQUE 4 — Trabados AHORA.
-- Conversaciones en modo bot, con sesión activa, cuyo puntero está en un nodo que NO es la
-- última pregunta que recibió el cliente, sin movimiento hace más de 10 minutos. Ninguno de los
-- dos va a hablar: el bot espera una respuesta que el cliente no sabe que le piden.
-- `modo_humano` = también las que quedaron en humano después de un "Reenviar paso actual".
-- #############################################################################
SELECT
  cv.id AS conversation_id,
  ct.phone_number AS cliente,
  cv.flow_current_node AS puntero,
  ult.node_code AS ultima_pregunta_enviada,
  ult.created_at AS enviada_a,
  (cv.human_taken_over IS TRUE OR lower(coalesce(cv.flow_status, '')) = 'human') AS modo_humano,
  cv.updated_at
FROM elpapustore_erp.chat_conversations cv
LEFT JOIN elpapustore_erp.chat_contacts ct ON ct.id = cv.contact_id
LEFT JOIN LATERAL (
  SELECT ns.node_code, ns.created_at
  FROM elpapustore_erp.chat_flow_events ns
  WHERE ns.conversation_id = cv.id
    AND ns.flow_session_id = cv.active_flow_session_id
    AND ns.event_type = 'node_sent'
  ORDER BY ns.created_at DESC
  LIMIT 1
) ult ON true
WHERE cv.flow_code = 'Papu_store'
  AND cv.active_flow_session_id IS NOT NULL
  AND cv.flow_current_node IS NOT NULL
  AND cv.updated_at < now() - interval '10 minutes'
  AND cv.updated_at > now() - interval '7 days'
  AND (ult.node_code IS DISTINCT FROM cv.flow_current_node)
ORDER BY cv.updated_at DESC
LIMIT 100;


-- #############################################################################
-- BLOQUE 5 — Después del deploy del fix: los eventos nuevos.
--   text_reply_lost_race        mensaje duplicado o ráfaga que antes corría los campos
--   capture_pointer_mismatch    respuesta que antes se guardaba en el campo equivocado
--   sorteo_manual_approval_resume_send_failed  retoma manual cuya pregunta no salió
-- Si el fix funciona, estos aparecen en lugar de `fuera_de_pantalla` del bloque 2.
-- #############################################################################
SELECT
  date_trunc('day', e.created_at)::date AS dia,
  e.event_type,
  count(*) AS veces
FROM elpapustore_erp.chat_flow_events e
WHERE e.event_type IN (
    'text_reply_lost_race',
    'capture_pointer_mismatch',
    'sorteo_manual_approval_resume_send_failed'
  )
  AND e.created_at >= now() - interval '14 days'
GROUP BY 1, 2
ORDER BY 1 DESC, 2;
