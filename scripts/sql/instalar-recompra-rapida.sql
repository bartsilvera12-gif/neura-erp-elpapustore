-- =============================================================================
-- Recompra rápida: instala el paso "¿Querés comprar con tus datos registrados?"
-- al INICIO del flujo, con sus dos botones.
--
-- Requiere que ANTES se haya corrido la migración que habilita el tipo de nodo
-- `identity_recall` (supabase/migrations/20260903120000_chat_flow_node_type_identity_recall.sql).
--
-- Cómo funciona una vez instalado:
--   · Teléfono NO registrado  → el paso se saltea solo, sin enviar nada. Invisible.
--   · Teléfono registrado     → muestra C.I. / Nombre / Ciudad / Teléfono y los dos botones.
--       "Sí, confirmar"       → guarda esos datos en la compra actual y saltea la captura.
--       "No, ingresar nuevo"  → borra los datos viejos y los pide de cero.
--
-- Idempotente. Para desinstalarlo, al final está el UPDATE que lo desactiva.
-- =============================================================================

DO $$
DECLARE
  v_schema        text := 'elpapustore_erp';
  v_flow_code     text := 'Papu_store';
  v_node_code     text := 'datos_registrados';

  v_empresa_id    uuid;
  v_first_code    text;
  v_first_sort    int;
  v_min_sort      int;
  v_recall_sort   int;
  v_node_id       uuid;
  v_existing_id   uuid;
  v_mensaje       text;
BEGIN
  v_mensaje :=
    '¿Querés adquirir las boletas con tus datos registrados?' || chr(10) || chr(10) ||
    'C.I.: {{datos_cedula}}'      || chr(10) ||
    'Nombre: {{datos_nombre}}'    || chr(10) ||
    'Ciudad: {{datos_ciudad}}'    || chr(10) ||
    'Teléfono: {{datos_telefono}}';

  -- Empresa dueña del flujo
  EXECUTE format(
    'SELECT empresa_id FROM %I.chat_flow_nodes WHERE flow_code = $1 AND is_active = true LIMIT 1',
    v_schema
  ) INTO v_empresa_id USING v_flow_code;
  IF v_empresa_id IS NULL THEN
    RAISE EXCEPTION 'El flujo % no tiene nodos activos en %', v_flow_code, v_schema;
  END IF;

  -- Primer paso REAL del flujo (ignorando el de recompra si ya está instalado).
  -- Mismo criterio que usa el motor para elegir por dónde arranca: sort_order, luego created_at.
  EXECUTE format(
    'SELECT node_code, sort_order FROM %I.chat_flow_nodes
      WHERE flow_code = $1 AND is_active = true AND node_code <> $2
      ORDER BY sort_order ASC, created_at ASC LIMIT 1',
    v_schema
  ) INTO v_first_code, v_first_sort USING v_flow_code, v_node_code;
  IF v_first_code IS NULL THEN
    RAISE EXCEPTION 'No se encontró el primer paso del flujo %', v_flow_code;
  END IF;

  EXECUTE format(
    'SELECT min(sort_order) FROM %I.chat_flow_nodes WHERE flow_code = $1 AND is_active = true',
    v_schema
  ) INTO v_min_sort USING v_flow_code;

  EXECUTE format(
    'SELECT id, sort_order FROM %I.chat_flow_nodes WHERE flow_code = $1 AND node_code = $2',
    v_schema
  ) INTO v_existing_id, v_recall_sort USING v_flow_code, v_node_code;

  IF v_existing_id IS NULL THEN
    v_recall_sort := v_min_sort - 1;
  END IF;

  RAISE NOTICE 'Flujo % | primer paso actual: % (sort %) | el paso nuevo va con sort %',
    v_flow_code, v_first_code, v_first_sort, v_recall_sort;

  -- Nodo -----------------------------------------------------------------
  IF v_existing_id IS NULL THEN
    EXECUTE format(
      'INSERT INTO %I.chat_flow_nodes
         (empresa_id, flow_code, node_code, node_type, message_text,
          save_as_field, next_node_code, sort_order, is_active)
       VALUES ($1, $2, $3, ''identity_recall'', $4, NULL, $5, $6, true)
       RETURNING id', v_schema
    ) INTO v_node_id USING v_empresa_id, v_flow_code, v_node_code, v_mensaje, v_first_code, v_recall_sort;
    RAISE NOTICE 'Paso de recompra creado: %', v_node_id;
  ELSE
    EXECUTE format(
      'UPDATE %I.chat_flow_nodes
          SET node_type = ''identity_recall'', next_node_code = $2, is_active = true,
              message_text = COALESCE(NULLIF(message_text, ''''), $3)
        WHERE id = $1', v_schema
    ) USING v_existing_id, v_first_code, v_mensaje;
    v_node_id := v_existing_id;
    RAISE NOTICE 'Paso de recompra ya existía, actualizado: %', v_node_id;
  END IF;

  -- Botones ---------------------------------------------------------------
  -- Ambos continúan al mismo paso siguiente: lo que cambia es qué se guarda o se borra.
  EXECUTE format('DELETE FROM %I.chat_flow_options WHERE node_id = $1', v_schema) USING v_node_id;

  EXECUTE format(
    'INSERT INTO %I.chat_flow_options
       (node_id, label, option_value, meta_button_id, next_node_code, sort_order, option_payload)
     VALUES
       ($1, ''✅ Sí, confirmar'',      ''usar_registrados'', ''datos_reg_si'', $2, 1,
        ''{"usar_datos_registrados": true}''::jsonb),
       ($1, ''❌ No, ingresar nuevo'', ''cargar_nuevos'',    ''datos_reg_no'', $2, 2,
        ''{"cargar_datos_nuevos": true}''::jsonb)', v_schema
  ) USING v_node_id, v_first_code;

  RAISE NOTICE 'Listo. Ambos botones continúan a: %', v_first_code;
END $$;

-- Verificación: el paso nuevo debe quedar PRIMERO en el flujo.
SELECT node_code, node_type, sort_order, next_node_code, is_active
FROM elpapustore_erp.chat_flow_nodes
WHERE flow_code = 'Papu_store' AND is_active = true
ORDER BY sort_order ASC, created_at ASC
LIMIT 5;

-- Y sus dos botones:
SELECT o.label, o.meta_button_id, o.next_node_code, o.option_payload
FROM elpapustore_erp.chat_flow_options o
JOIN elpapustore_erp.chat_flow_nodes n ON n.id = o.node_id
WHERE n.flow_code = 'Papu_store' AND n.node_code = 'datos_registrados'
ORDER BY o.sort_order;

-- ---------------------------------------------------------------------------
-- DESINSTALAR (deja el flujo como estaba, sin borrar nada):
--   UPDATE elpapustore_erp.chat_flow_nodes SET is_active = false
--   WHERE flow_code = 'Papu_store' AND node_code = 'datos_registrados';
-- ---------------------------------------------------------------------------
