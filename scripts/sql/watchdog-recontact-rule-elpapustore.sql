-- Watchdog de recontacto — regla por defecto para El Papu Store (flujo Papu_store).
--
-- Crea UNA regla que el nuevo cron /api/cron/chat-recontact ejecuta: si una conversación en modo
-- bot lleva >= idle_after_seconds sin avanzar (última respuesta del cliente sin réplica) y está en
-- uno de los nodos de captura, le reenvía el paso actual (sendCurrentFlowNode) para que retome.
--
-- Seguridad: idempotente (no duplica si ya existe una regla con este nombre). No dispara nada por
-- sí sola: hace falta (a) desplegar el route y (b) agendar el Coolify Scheduled Task con apply=true.
-- El cron respeta cooldown, max_attempts, horario y guardas (humano/cerrada/orden confirmada).
--
-- Aplicar:  node scripts/apply-migration-file-pg.cjs scripts/sql/watchdog-recontact-rule-elpapustore.sql
-- (o revisá el SELECT del final para ver la regla resultante).

INSERT INTO elpapustore_erp.chat_flow_recontact_rules (
  empresa_id, flow_code, nombre, descripcion, activo, prioridad,
  included_node_codes, excluded_node_codes,
  idle_after_seconds, max_attempts, cooldown_seconds,
  schedule_config, guard_config, message_config
)
SELECT
  '5ad0bdda-f94f-446c-9032-1fedf34e8479'::uuid,
  'Papu_store',
  'Watchdog reanudar flujo',
  'Reenvía el paso actual del bot a conversaciones que quedaron sin respuesta en un nodo de captura. Red de seguridad ante envíos fallidos / mensajes no procesados.',
  true,
  100,
  '["Mensaje_de_bienvenida","combos_populares","datos_registrados","cedula","primer_nombre","primer_apellido","ciudad","solicitud_de_nro_de_celular","pedido_de_comprobante"]'::jsonb,
  '["confirmacion_de_compra","comprobacion_datos","aprobacion_de_compra","resumen_de_compra","compra_realizada"]'::jsonb,
  900,      -- idle_after_seconds: 15 min de silencio antes de reanudar
  1,        -- max_attempts: un solo reintento por conversación (no insistir)
  3600,     -- cooldown_seconds: 1 h entre intentos
  '{"window_start":"08:00","window_end":"21:00","timezone":"America/Asuncion","active_weekdays":[0,1,2,3,4,5,6]}'::jsonb,
  '{"skip_if_human_taken_over":true,"skip_if_conversation_closed":true,"purchase_condition":"no_confirmed_sorteo_order"}'::jsonb,
  '{"message_type":"session_text","session_text":"¿Seguimos con tu compra? Te reenvío el último paso 👇","buttons_json":[]}'::jsonb
WHERE NOT EXISTS (
  SELECT 1 FROM elpapustore_erp.chat_flow_recontact_rules
  WHERE empresa_id = '5ad0bdda-f94f-446c-9032-1fedf34e8479'::uuid
    AND flow_code = 'Papu_store'
    AND nombre = 'Watchdog reanudar flujo'
);

-- Verificación:
SELECT id, nombre, activo, prioridad, idle_after_seconds, max_attempts, cooldown_seconds,
       included_node_codes, schedule_config
FROM elpapustore_erp.chat_flow_recontact_rules
WHERE empresa_id = '5ad0bdda-f94f-446c-9032-1fedf34e8479'::uuid
  AND flow_code = 'Papu_store';
