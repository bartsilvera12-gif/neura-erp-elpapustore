-- =============================================================================
-- Diagnóstico 2: por qué no le llega la pregunta de la cédula después del comprobante.
--
-- El diagnóstico 1 mostró respuestas como "Listo" o "Acá te paso mi comprobante" guardadas como
-- CÉDULA, con el cliente todavía viendo el pedido del comprobante. O sea: el puntero pasó a
-- `cedula` pero esa pregunta nunca salió. El motor registra cada envío fallido con su error:
-- estas consultas lo leen.
--
-- Schema: elpapustore_erp · Flujo: Papu_store. Correr UN BLOQUE POR VEZ. Ninguno escribe.
-- =============================================================================


-- #############################################################################
-- BLOQUE A — Envíos fallidos por nodo y por error (últimos 14 días). El más importante.
-- Si la pregunta de la cédula falla siempre por el mismo motivo, aparece acá.
-- #############################################################################
SELECT
  e.node_code,
  e.event_type,
  left(coalesce(e.payload ->> 'error', e.payload ->> 'error_message', ''), 160) AS error,
  count(*) AS veces,
  min(e.created_at) AS primera,
  max(e.created_at) AS ultima
FROM elpapustore_erp.chat_flow_events e
WHERE e.flow_code = 'Papu_store'
  AND e.created_at >= now() - interval '14 days'
  AND e.event_type IN (
    'present_failed',
    'manual_current_node_resend_failed',
    'sorteo_manual_approval_resume_send_failed'
  )
GROUP BY 1, 2, 3
ORDER BY veces DESC
LIMIT 60;


-- #############################################################################
-- BLOQUE B — Línea de tiempo completa de tres conversaciones del diagnóstico 1
-- ("Acá te paso mi comprobante", "Listo" y "Ortega", las tres guardadas como cédula).
-- Muestra en orden qué envió el bot, qué llegó y dónde estaba parado.
-- #############################################################################
SELECT
  ct.phone_number AS cliente,
  e.created_at,
  e.event_type,
  e.node_code,
  left(
    coalesce(
      e.payload ->> 'text_value',
      e.payload ->> 'error',
      e.payload ->> 'next_node_code',
      e.payload ->> 'reason',
      ''
    ),
    60
  ) AS detalle
FROM elpapustore_erp.chat_flow_events e
JOIN elpapustore_erp.chat_conversations cv ON cv.id = e.conversation_id
JOIN elpapustore_erp.chat_contacts ct ON ct.id = cv.contact_id
WHERE ct.phone_number IN ('595981645021', '595993582312', '595974901809')
  AND e.created_at >= now() - interval '10 days'
ORDER BY ct.phone_number, e.created_at
LIMIT 400;


-- #############################################################################
-- BLOQUE C — Las paradas en `datos_registrados` sin nada enviado: ¿trabadas o en reposo?
-- Muchas tienen el mismo `updated_at` exacto: huele a un proceso que las reinició de noche.
-- `escribio_despues` = el cliente mandó un mensaje DESPUÉS de que empezara la sesión actual y el
-- bot no le contestó nada: ésas son las trabadas de verdad. Las otras sólo esperan que escriba.
-- #############################################################################
SELECT
  (m.ultimo_entrante IS NOT NULL AND m.ultimo_entrante > s.created_at) AS escribio_despues,
  count(*) AS conversaciones,
  min(cv.updated_at) AS desde,
  max(cv.updated_at) AS hasta
FROM elpapustore_erp.chat_conversations cv
JOIN elpapustore_erp.chat_flow_sessions s ON s.id = cv.active_flow_session_id
LEFT JOIN LATERAL (
  SELECT max(msg.created_at) AS ultimo_entrante
  FROM elpapustore_erp.chat_messages msg
  WHERE msg.conversation_id = cv.id
    AND msg.from_me = false
) m ON true
WHERE cv.flow_code = 'Papu_store'
  AND cv.flow_current_node = 'datos_registrados'
  AND cv.updated_at > now() - interval '3 days'
  AND NOT EXISTS (
    SELECT 1 FROM elpapustore_erp.chat_flow_events ns
    WHERE ns.conversation_id = cv.id
      AND ns.flow_session_id = cv.active_flow_session_id
      AND ns.event_type = 'node_sent'
  )
GROUP BY 1;


-- #############################################################################
-- BLOQUE D — Las que SÍ escribieron y no recibieron nada: qué eventos tiene su sesión.
-- #############################################################################
SELECT
  ct.phone_number AS cliente,
  s.created_at AS sesion_creada,
  m.ultimo_entrante,
  (
    SELECT string_agg(ev.event_type || coalesce(':' || left(ev.payload ->> 'error', 60), ''), ' > ' ORDER BY ev.created_at)
    FROM elpapustore_erp.chat_flow_events ev
    WHERE ev.conversation_id = cv.id
      AND ev.flow_session_id = cv.active_flow_session_id
  ) AS eventos_de_la_sesion
FROM elpapustore_erp.chat_conversations cv
JOIN elpapustore_erp.chat_flow_sessions s ON s.id = cv.active_flow_session_id
JOIN elpapustore_erp.chat_contacts ct ON ct.id = cv.contact_id
JOIN LATERAL (
  SELECT max(msg.created_at) AS ultimo_entrante
  FROM elpapustore_erp.chat_messages msg
  WHERE msg.conversation_id = cv.id
    AND msg.from_me = false
) m ON true
WHERE cv.flow_code = 'Papu_store'
  AND cv.flow_current_node = 'datos_registrados'
  AND cv.updated_at > now() - interval '3 days'
  AND m.ultimo_entrante > s.created_at
  AND NOT EXISTS (
    SELECT 1 FROM elpapustore_erp.chat_flow_events ns
    WHERE ns.conversation_id = cv.id
      AND ns.flow_session_id = cv.active_flow_session_id
      AND ns.event_type = 'node_sent'
  )
ORDER BY m.ultimo_entrante DESC
LIMIT 25;
