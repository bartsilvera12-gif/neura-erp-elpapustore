-- =============================================================================
-- Gente que escribió en las últimas 24 h y NO recibió respuesta entregada.
-- Motivo del corte: la cuenta de Meta estaba bloqueada por falta de pago
-- (error 131042). El bot sí respondió, pero Meta no entregó nada.
--
-- Por qué "gratis": mientras no pasen 24 h desde el ÚLTIMO mensaje entrante de
-- cada persona, la ventana de atención al cliente sigue abierta y un mensaje de
-- texto libre no se cobra. La columna `horas_restantes` dice cuánto queda, y se
-- vence persona por persona, no todas juntas.
--
-- Solo lectura. No modifica nada.
-- =============================================================================

WITH ult AS (
  -- Último mensaje ENTRANTE de cada conversación, dentro de la ventana.
  SELECT conversation_id, MAX(created_at) AS ultimo_entrante
  FROM elpapustore_erp.chat_messages
  WHERE from_me = false
    AND created_at >= now() - interval '24 hours'
  GROUP BY conversation_id
),
con_respuesta_entregada AS (
  -- Conversaciones donde SÍ salió al menos una respuesta que Meta no rechazó.
  -- Un saliente sin `neura_meta_status` se considera entregado (no llegó webhook
  -- de estado); es el criterio conservador: ante la duda, no lo incluimos.
  SELECT DISTINCT u.conversation_id
  FROM ult u
  JOIN elpapustore_erp.chat_messages s
    ON s.conversation_id = u.conversation_id
   AND s.from_me = true
   AND s.created_at > u.ultimo_entrante
  WHERE COALESCE(s.raw_payload->'neura_meta_status'->>'status', '') <> 'failed'
    AND  (s.raw_payload->'neura_meta_status'->>'error_code') IS NULL
),
pendientes AS (
  SELECT DISTINCT ON (ct.phone_number)
    ct.phone_number,
    ct.name,
    u.conversation_id,
    u.ultimo_entrante
  FROM ult u
  JOIN elpapustore_erp.chat_conversations c ON c.id = u.conversation_id
  JOIN elpapustore_erp.chat_contacts     ct ON ct.id = c.contact_id
  LEFT JOIN con_respuesta_entregada ok ON ok.conversation_id = u.conversation_id
  WHERE ok.conversation_id IS NULL
  -- Un mismo número puede tener dos conversaciones (una por canal): nos quedamos
  -- con la del mensaje más reciente para no mandarle dos veces.
  ORDER BY ct.phone_number, u.ultimo_entrante DESC
)
SELECT
  p.phone_number                                              AS telefono,
  -- Mismo normalizado que usa el módulo de campañas (sin 595, sin ceros).
  ltrim(regexp_replace(regexp_replace(p.phone_number, '\D', '', 'g'), '^595', ''), '0')
                                                              AS telefono_normalizado,
  COALESCE(NULLIF(btrim(p.name), ''), '(sin nombre)')         AS nombre,
  to_char(p.ultimo_entrante AT TIME ZONE 'America/Asuncion', 'DD/MM HH24:MI')
                                                              AS escribio_py,
  round(
    EXTRACT(epoch FROM (p.ultimo_entrante + interval '24 hours' - now())) / 3600.0
  , 1)                                                        AS horas_restantes,
  (SELECT count(*)
     FROM elpapustore_erp.chat_messages f
    WHERE f.conversation_id = p.conversation_id
      AND f.from_me = true
      AND f.created_at > p.ultimo_entrante)                   AS respuestas_que_no_salieron,
  (SELECT left(COALESCE(m.content, '[' || m.message_type || ']'), 60)
     FROM elpapustore_erp.chat_messages m
    WHERE m.conversation_id = p.conversation_id
      AND m.from_me = false
    ORDER BY m.created_at DESC
    LIMIT 1)                                                  AS ultimo_texto
FROM pendientes p
ORDER BY horas_restantes ASC;   -- primero los que están por vencer


-- =============================================================================
-- VARIANTE 2: la misma gente, pero en una sola celda separada por comas, lista
-- para pegar en "Agregar teléfonos" al armar la audiencia de la campaña.
-- Solo los que todavía tienen ventana abierta con margen (más de 1 h restante).
-- =============================================================================

WITH ult AS (
  SELECT conversation_id, MAX(created_at) AS ultimo_entrante
  FROM elpapustore_erp.chat_messages
  WHERE from_me = false
    AND created_at >= now() - interval '24 hours'
  GROUP BY conversation_id
),
con_respuesta_entregada AS (
  SELECT DISTINCT u.conversation_id
  FROM ult u
  JOIN elpapustore_erp.chat_messages s
    ON s.conversation_id = u.conversation_id
   AND s.from_me = true
   AND s.created_at > u.ultimo_entrante
  WHERE COALESCE(s.raw_payload->'neura_meta_status'->>'status', '') <> 'failed'
    AND  (s.raw_payload->'neura_meta_status'->>'error_code') IS NULL
),
pendientes AS (
  SELECT DISTINCT
    ltrim(regexp_replace(regexp_replace(ct.phone_number, '\D', '', 'g'), '^595', ''), '0') AS tel
  FROM ult u
  JOIN elpapustore_erp.chat_conversations c ON c.id = u.conversation_id
  JOIN elpapustore_erp.chat_contacts     ct ON ct.id = c.contact_id
  LEFT JOIN con_respuesta_entregada ok ON ok.conversation_id = u.conversation_id
  WHERE ok.conversation_id IS NULL
    AND u.ultimo_entrante > now() - interval '23 hours'
)
SELECT
  count(*)                        AS cantidad,
  string_agg(tel, ', ' ORDER BY tel) AS telefonos
FROM pendientes
WHERE tel <> '';
