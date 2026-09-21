-- =============================================================================
-- Corrección del teléfono (y nombre) impresos en la boleta de UNA orden.
--
-- La boleta imprime `sorteo_entradas.telefono_contacto`: el celular que la persona declaró en
-- el bot. Las órdenes creadas ANTES del fix tienen esa columna en NULL, y por eso el PNG cae
-- al respaldo `whatsapp_numero` (la línea desde la que escribió).
--
-- CÓMO CORRER ESTO: un bloque por vez. Cada bloque es UNA sola sentencia — seleccionála y
-- ejecutala sola. No hay BEGIN/COMMIT a propósito: el editor SQL ya envuelve cada ejecución,
-- y un BEGIN que queda abierto es peor que no tener transacción. La seguridad la da el filtro
-- por `id` (clave primaria): toca una fila o ninguna, nunca varias.
--
-- CUIDADO con `numero_orden`: NO identifica una fila. Es un contador POR SORTEO
-- (`sorteos.ultimo_numero_orden`) y no tiene índice único, así que el mismo número existe en
-- varios sorteos a la vez. Se busca por número, pero se corrige por `id`.
--
-- Schema: elpapustore_erp.
-- =============================================================================


-- #############################################################################
-- BLOQUE 1 — Diagnóstico. No escribe nada.
--
-- Cambiá el 6584 por el número de orden que estés revisando.
-- Puede devolver VARIAS filas: identificá la correcta por nombre / whatsapp / sorteo y copiá
-- SU `entrada_id`, que es lo que va en los bloques siguientes.
--
-- Mirá dos columnas:
--   a) `telefono_declarado_en_el_bot`: el celular que cargó. Si sale vacío, el flujo lo guarda
--      en un campo que la lista de alias no cubre → mirá `todos_los_campos_del_flujo`.
--   b) `campo_donde_lo_guardo`: el nombre exacto del save_as_field del nodo.
-- #############################################################################
SELECT
  e.id                AS entrada_id,
  e.numero_orden,
  s.nombre            AS sorteo,
  e.nombre_participante,
  e.whatsapp_numero   AS linea_de_whatsapp,
  e.telefono_contacto AS telefono_que_se_imprime,
  e.cliente_id,
  e.created_at,
  decl.field_value    AS telefono_declarado_en_el_bot,
  decl.field_name     AS campo_donde_lo_guardo,
  (
    SELECT jsonb_object_agg(x.field_name, x.field_value)
    FROM (
      SELECT DISTINCT ON (fd.field_name) fd.field_name, fd.field_value
      FROM elpapustore_erp.chat_flow_data fd
      WHERE fd.conversation_id = e.chat_conversation_id
      ORDER BY fd.field_name, fd.created_at DESC
    ) x
  ) AS todos_los_campos_del_flujo
FROM elpapustore_erp.sorteo_entradas e
LEFT JOIN elpapustore_erp.sorteos s ON s.id = e.sorteo_id
LEFT JOIN LATERAL (
  SELECT fd.field_name, fd.field_value
  FROM elpapustore_erp.chat_flow_data fd
  WHERE fd.conversation_id = e.chat_conversation_id
    AND lower(trim(fd.field_name)) IN (
      'telefono_contacto','telefono','teléfono','telefono_celular','numero_telefono',
      'nro_telefono','celular','numero_celular','número_celular','nro_celular',
      'num_celular','movil','móvil','numero_contacto','número_contacto',
      'whatsapp','numero_whatsapp','phone','mobile'
    )
    AND length(regexp_replace(coalesce(fd.field_value,''), '\D', '', 'g')) >= 6
    AND fd.field_value !~ '[a-zA-ZáéíóúÁÉÍÓÚñÑ]'
  ORDER BY fd.created_at DESC
  LIMIT 1
) decl ON true
WHERE e.numero_orden = 6584;


-- #############################################################################
-- BLOQUE 2 — Corregir el teléfono de la orden.
--
-- Pegá el `entrada_id` del bloque 1 en lugar de PEGAR-ENTRADA-ID.
-- Saca el número del historial del chat: no hay que transcribir nada.
-- El RETURNING tiene que mostrar el teléfono ya corregido. Si vuelve vacío, el flujo no lo
-- guardó en ningún alias conocido y hay que usar el bloque 2-BIS.
-- #############################################################################
UPDATE elpapustore_erp.sorteo_entradas e
   SET telefono_contacto = (
         SELECT fd.field_value
         FROM elpapustore_erp.chat_flow_data fd
         WHERE fd.conversation_id = e.chat_conversation_id
           AND lower(trim(fd.field_name)) IN (
             'telefono_contacto','telefono','teléfono','telefono_celular','numero_telefono',
             'nro_telefono','celular','numero_celular','número_celular','nro_celular',
             'num_celular','movil','móvil','numero_contacto','número_contacto',
             'whatsapp','numero_whatsapp','phone','mobile'
           )
           AND length(regexp_replace(coalesce(fd.field_value,''), '\D', '', 'g')) >= 6
           AND fd.field_value !~ '[a-zA-ZáéíóúÁÉÍÓÚñÑ]'
         ORDER BY fd.created_at DESC
         LIMIT 1
       )
 WHERE e.id = 'PEGAR-ENTRADA-ID'::uuid
   AND e.telefono_contacto IS NULL
RETURNING e.id, e.numero_orden, e.nombre_participante, e.whatsapp_numero, e.telefono_contacto;


-- #############################################################################
-- BLOQUE 2-BIS — Sólo si el bloque 2 devolvió el teléfono vacío.
-- Poné el número a mano, tal como lo declaró la persona.
-- #############################################################################
UPDATE elpapustore_erp.sorteo_entradas
   SET telefono_contacto = '0985396631'
 WHERE id = 'PEGAR-ENTRADA-ID'::uuid
RETURNING id, numero_orden, nombre_participante, whatsapp_numero, telefono_contacto;


-- #############################################################################
-- BLOQUE 3 — Corregir el nombre. Sólo si también salió mal.
-- #############################################################################
UPDATE elpapustore_erp.sorteo_entradas
   SET nombre_participante = 'Nombre Apellido'
 WHERE id = 'PEGAR-ENTRADA-ID'::uuid
RETURNING id, numero_orden, nombre_participante;


-- #############################################################################
-- BLOQUE 4 — Alinear el CRM.
--
-- `clientes.telefono` NO se toca: guarda el WhatsApp y es la clave con la que la recompra
-- rápida reconoce al comprador cuando vuelve a escribir.
-- #############################################################################
UPDATE elpapustore_erp.clientes c
   SET telefono_secundario = e.telefono_contacto
  FROM elpapustore_erp.sorteo_entradas e
 WHERE e.id = 'PEGAR-ENTRADA-ID'::uuid
   AND c.id = e.cliente_id
   AND e.telefono_contacto IS NOT NULL
RETURNING c.id, c.nombre, c.telefono AS whatsapp, c.telefono_secundario AS celular_declarado;


-- #############################################################################
-- BLOQUE 5 — Ubicar el ticket para regenerarlo.
--
-- El PNG no se rehace solo. Panel → Sorteos → Tickets → buscar la orden → "Regenerar" →
-- "Ver" para descargar. Regenerar NO reenvía nada al cliente: la imagen la mandás vos.
-- Requiere el código del fix ya desplegado, si no el render sigue usando el WhatsApp.
-- #############################################################################
SELECT d.id AS ticket_id, d.status, d.template_revision, d.is_current, d.created_at
  FROM elpapustore_erp.sorteo_ticket_deliveries d
 WHERE d.entrada_id = 'PEGAR-ENTRADA-ID'::uuid
 ORDER BY d.template_revision DESC;


-- #############################################################################
-- BLOQUE 6 — Todas las órdenes con el mismo problema. No escribe.
-- `salio_con_numero_equivocado` = la boleta salió con un número distinto al declarado.
-- #############################################################################
WITH declarado AS (
  SELECT
    e.id AS entrada_id,
    e.numero_orden,
    e.nombre_participante,
    e.whatsapp_numero,
    e.created_at,
    (
      SELECT fd.field_value
      FROM elpapustore_erp.chat_flow_data fd
      WHERE fd.conversation_id = e.chat_conversation_id
        AND lower(trim(fd.field_name)) IN (
          'telefono_contacto','telefono','teléfono','telefono_celular','numero_telefono',
          'nro_telefono','celular','numero_celular','número_celular','nro_celular',
          'num_celular','movil','móvil','numero_contacto','número_contacto',
          'whatsapp','numero_whatsapp','phone','mobile'
        )
        AND length(regexp_replace(coalesce(fd.field_value,''), '\D', '', 'g')) >= 6
        AND fd.field_value !~ '[a-zA-ZáéíóúÁÉÍÓÚñÑ]'
      ORDER BY fd.created_at DESC
      LIMIT 1
    ) AS tel_declarado
  FROM elpapustore_erp.sorteo_entradas e
  WHERE e.telefono_contacto IS NULL
    AND e.chat_conversation_id IS NOT NULL
)
SELECT
  entrada_id,
  numero_orden,
  nombre_participante,
  created_at,
  whatsapp_numero,
  tel_declarado,
  ltrim(regexp_replace(regexp_replace(tel_declarado, '\D', '', 'g'), '^595', ''), '0')
    IS DISTINCT FROM
  ltrim(regexp_replace(regexp_replace(whatsapp_numero, '\D', '', 'g'), '^595', ''), '0')
    AS salio_con_numero_equivocado
FROM declarado
WHERE tel_declarado IS NOT NULL
ORDER BY created_at DESC;


-- #############################################################################
-- BLOQUE 7 — ¿El número de orden se repite DENTRO de un mismo sorteo?
--
-- Entre sorteos distintos es normal: el contador es por sorteo. Dentro del mismo sorteo sería
-- un problema aparte: dos compradores con el mismo "Nº de orden" impreso en su boleta.
-- #############################################################################
SELECT
  e.sorteo_id,
  s.nombre AS sorteo,
  e.numero_orden,
  count(*) AS entradas_con_ese_numero,
  string_agg(e.nombre_participante, ' | ' ORDER BY e.created_at) AS participantes
FROM elpapustore_erp.sorteo_entradas e
LEFT JOIN elpapustore_erp.sorteos s ON s.id = e.sorteo_id
WHERE e.numero_orden IS NOT NULL
GROUP BY e.sorteo_id, s.nombre, e.numero_orden
HAVING count(*) > 1
ORDER BY count(*) DESC, e.numero_orden DESC
LIMIT 50;
