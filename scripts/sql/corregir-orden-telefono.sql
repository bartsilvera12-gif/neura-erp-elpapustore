-- =============================================================================
-- Corrección del teléfono (y nombre) impresos en la boleta de UNA orden.
--
-- La boleta imprime `sorteo_entradas.telefono_contacto`: el celular que la persona declaró en
-- el bot. Las órdenes creadas ANTES de desplegar el fix tienen esa columna en NULL y por eso
-- el PNG cae al respaldo `whatsapp_numero` (la línea desde la que escribió).
--
-- Schema: elpapustore_erp. Cambiar el número de orden en las líneas marcadas «ORDEN».
-- El paso 1 no escribe nada.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- PASO 1 — Diagnóstico.
--
-- Mirá DOS cosas:
--   a) `telefono_declarado_en_el_bot`: el celular que cargó. Si sale NULL, el campo donde lo
--      guarda el flujo no está en la lista de abajo → copiá `todos_los_campos_del_flujo` y
--      pasámelo, porque entonces el fix tampoco lo va a tomar en las compras nuevas.
--   b) `campo_donde_lo_guardo`: el nombre exacto del save_as_field del nodo.
-- -----------------------------------------------------------------------------
WITH alias_telefono AS (
  SELECT unnest(ARRAY[
    'telefono_contacto','telefono','teléfono','telefono_celular','numero_telefono',
    'nro_telefono','celular','numero_celular','número_celular','nro_celular',
    'num_celular','movil','móvil','numero_contacto','número_contacto',
    'whatsapp','numero_whatsapp','phone','mobile'
  ]) AS k
)
SELECT
  e.id                AS entrada_id,
  e.numero_orden,
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
LEFT JOIN LATERAL (
  SELECT fd.field_name, fd.field_value
  FROM elpapustore_erp.chat_flow_data fd
  WHERE fd.conversation_id = e.chat_conversation_id
    AND lower(trim(fd.field_name)) IN (SELECT k FROM alias_telefono)
    AND length(regexp_replace(coalesce(fd.field_value,''), '\D', '', 'g')) >= 6
    AND fd.field_value !~ '[a-zA-ZáéíóúÁÉÍÓÚñÑ]'
  ORDER BY fd.created_at DESC
  LIMIT 1
) decl ON true
WHERE e.numero_orden = 6584;   -- «ORDEN»


-- -----------------------------------------------------------------------------
-- PASO 2 — Corrección.
--
-- Toma solo el número que la persona declaró en el bot: no hay que transcribir nada.
-- Para forzarlo a mano (si el paso 1 mostró NULL), poné el número entre las comillas de
-- NULLIF('', '') — por ejemplo NULLIF('0973592372', '').
--
-- En transacción: el RETURNING tiene que devolver EXACTAMENTE una fila.
-- -----------------------------------------------------------------------------
BEGIN;

UPDATE elpapustore_erp.sorteo_entradas e
   SET telefono_contacto = COALESCE(
         NULLIF('', ''),                    -- ← override manual opcional
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
         )
       )
       -- Descomentar SOLO si el nombre también salió mal:
       -- , nombre_participante = 'Nombre Apellido'
 WHERE e.numero_orden = 6584                -- «ORDEN»
RETURNING e.id, e.numero_orden, e.nombre_participante, e.whatsapp_numero, e.telefono_contacto;

-- Si telefono_contacto volvió NULL: el flujo no guardó el celular en ninguno de los alias.
-- ROLLBACK y revisar el `todos_los_campos_del_flujo` del paso 1.

-- El CRM queda alineado. `clientes.telefono` NO se toca: guarda el WhatsApp, y es la clave con
-- la que la recompra rápida reconoce al comprador cuando vuelve a escribir.
UPDATE elpapustore_erp.clientes c
   SET telefono_secundario = e.telefono_contacto
       -- , nombre = 'Nombre Apellido', nombre_contacto = 'Nombre Apellido'
  FROM elpapustore_erp.sorteo_entradas e
 WHERE e.numero_orden = 6584                -- «ORDEN»
   AND c.id = e.cliente_id
   AND e.telefono_contacto IS NOT NULL
RETURNING c.id, c.nombre, c.telefono AS whatsapp, c.telefono_secundario AS celular_declarado;

COMMIT;
-- ROLLBACK;   -- si algo no cuadra


-- -----------------------------------------------------------------------------
-- PASO 3 — Regenerar la boleta.
--   Panel → Sorteos → Tickets → buscar la orden → "Regenerar" → "Ver" para descargar.
-- "Regenerar" crea una revisión nueva y NO reenvía nada: la imagen la mandás vos.
--
-- OJO: el paso 3 sólo sirve con el código del fix YA DESPLEGADO. Sin eso el render sigue
-- imprimiendo `whatsapp_numero` aunque la columna esté corregida.
-- -----------------------------------------------------------------------------
SELECT d.id AS ticket_id, d.status, d.template_revision, d.is_current, d.created_at
  FROM elpapustore_erp.sorteo_ticket_deliveries d
  JOIN elpapustore_erp.sorteo_entradas e ON e.id = d.entrada_id
 WHERE e.numero_orden = 6584                -- «ORDEN»
 ORDER BY d.template_revision DESC;


-- =============================================================================
-- Todas las órdenes con el mismo problema (diagnóstico, no escribe).
-- `salio_con_numero_equivocado` = la boleta salió con un número distinto al declarado.
-- =============================================================================
WITH declarado AS (
  SELECT
    e.numero_orden,
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
  numero_orden,
  created_at,
  whatsapp_numero,
  tel_declarado,
  ltrim(regexp_replace(regexp_replace(tel_declarado, '\D', '', 'g'), '^595', ''), '0')
    IS DISTINCT FROM
  ltrim(regexp_replace(regexp_replace(whatsapp_numero, '\D', '', 'g'), '^595', ''), '0')
    AS salio_con_numero_equivocado
FROM declarado
WHERE tel_declarado IS NOT NULL
ORDER BY numero_orden DESC;
