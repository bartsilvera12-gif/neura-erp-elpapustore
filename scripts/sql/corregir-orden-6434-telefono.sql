-- =============================================================================
-- Corrección de la orden N.º 6434: teléfono (y nombre) impresos en la boleta.
--
-- Contexto: hasta el fix, la boleta imprimía `sorteo_entradas.whatsapp_numero` (la línea desde
-- la que el comprador escribe). El celular que declaró en el bot quedaba sólo en
-- `chat_flow_data`. La columna `telefono_contacto` guarda el declarado y es la que manda en el
-- PNG; este script la completa para una orden ya creada.
--
-- Schema: elpapustore_erp (cambiar si la instancia usa otro).
-- Correr los pasos EN ORDEN. El paso 1 no escribe: es para confirmar los datos.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- PASO 1 — Qué tiene hoy la orden y qué cargó la persona en el bot.
-- Mirá `telefono_declarado_en_el_bot`: eso es lo que debe quedar impreso.
-- -----------------------------------------------------------------------------
SELECT
  e.id                       AS entrada_id,
  e.numero_orden,
  e.nombre_participante,
  e.documento,
  e.whatsapp_numero          AS linea_de_whatsapp,     -- desde donde escribió
  e.telefono_contacto        AS telefono_declarado,    -- lo que se imprime (hoy NULL)
  e.cliente_id,
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
    ORDER BY fd.created_at DESC
    LIMIT 1
  ) AS telefono_declarado_en_el_bot
FROM elpapustore_erp.sorteo_entradas e
WHERE e.numero_orden = 6434;

-- Si querés ver TODOS los datos que cargó en esa conversación (para el nombre, por ejemplo):
-- SELECT DISTINCT ON (fd.field_name) fd.field_name, fd.field_value, fd.created_at
--   FROM elpapustore_erp.chat_flow_data fd
--   JOIN elpapustore_erp.sorteo_entradas e ON e.chat_conversation_id = fd.conversation_id
--  WHERE e.numero_orden = 6434
--  ORDER BY fd.field_name, fd.created_at DESC;


-- -----------------------------------------------------------------------------
-- PASO 2 — Corrección. Revisar el PASO 1 antes de correr esto.
--
-- Va en transacción: si algo no cuadra, ROLLBACK y no pasó nada.
-- El UPDATE devuelve la fila tocada — tiene que ser EXACTAMENTE 1.
-- -----------------------------------------------------------------------------
BEGIN;

UPDATE elpapustore_erp.sorteo_entradas
   SET telefono_contacto = '0973592372'
       -- Descomentar y completar SOLO si el nombre también salió mal:
       -- , nombre_participante = 'Nombre Apellido'
 WHERE numero_orden = 6434
RETURNING id, numero_orden, nombre_participante, whatsapp_numero, telefono_contacto;

-- El CRM queda alineado. `clientes.telefono` NO se toca: guarda el WhatsApp, y es la clave con
-- la que la recompra rápida reconoce al comprador cuando vuelve a escribir.
UPDATE elpapustore_erp.clientes c
   SET telefono_secundario = '0973592372'
       -- , nombre = 'Nombre Apellido', nombre_contacto = 'Nombre Apellido'
  FROM elpapustore_erp.sorteo_entradas e
 WHERE e.numero_orden = 6434
   AND c.id = e.cliente_id
RETURNING c.id, c.nombre, c.telefono AS whatsapp, c.telefono_secundario AS celular_declarado;

-- Si las dos filas devueltas son las correctas:
COMMIT;
-- Si algo no cuadra:
-- ROLLBACK;


-- -----------------------------------------------------------------------------
-- PASO 3 — Regenerar la boleta.
--
-- El PNG NO se rehace solo: hay que pedirlo desde el panel.
--   Sorteos → Tickets → buscar la orden 6434 → "Regenerar" → "Ver" para descargar.
-- "Regenerar" crea una revisión nueva y NO reenvía nada al cliente: la imagen la mandás vos.
--
-- Para ubicar el ticket de esta orden:
-- -----------------------------------------------------------------------------
SELECT d.id AS ticket_id, d.status, d.template_revision, d.is_current, d.created_at
  FROM elpapustore_erp.sorteo_ticket_deliveries d
  JOIN elpapustore_erp.sorteo_entradas e ON e.id = d.entrada_id
 WHERE e.numero_orden = 6434
 ORDER BY d.template_revision DESC;


-- =============================================================================
-- OPCIONAL — Las otras órdenes con el mismo problema.
--
-- Toda orden anterior al fix tiene telefono_contacto NULL. Las que interesan son aquellas
-- cuyo comprador SÍ declaró un celular distinto al WhatsApp: esas están imprimiendo el número
-- equivocado, igual que la 6434.
--
-- Correr PRIMERO el SELECT para ver cuántas son y revisar la muestra.
-- =============================================================================

-- Diagnóstico (no escribe):
WITH declarado AS (
  SELECT
    e.id AS entrada_id,
    e.numero_orden,
    e.whatsapp_numero,
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
  whatsapp_numero,
  tel_declarado,
  -- true = la boleta salió con un número distinto al que la persona declaró
  ltrim(regexp_replace(regexp_replace(tel_declarado, '\D', '', 'g'), '^595', ''), '0')
    IS DISTINCT FROM
  ltrim(regexp_replace(regexp_replace(whatsapp_numero, '\D', '', 'g'), '^595', ''), '0')
    AS salio_con_numero_equivocado
FROM declarado
WHERE tel_declarado IS NOT NULL
ORDER BY numero_orden DESC;

-- Backfill (descomentar después de revisar el SELECT de arriba).
-- Completa el declarado en todas esas órdenes. No regenera los PNG: los tickets ya enviados
-- siguen como están hasta que alguien los regenere desde el panel.
--
-- UPDATE elpapustore_erp.sorteo_entradas e
--    SET telefono_contacto = (
--      SELECT fd.field_value
--      FROM elpapustore_erp.chat_flow_data fd
--      WHERE fd.conversation_id = e.chat_conversation_id
--        AND lower(trim(fd.field_name)) IN (
--          'telefono_contacto','telefono','teléfono','telefono_celular','numero_telefono',
--          'nro_telefono','celular','numero_celular','número_celular','nro_celular',
--          'num_celular','movil','móvil','numero_contacto','número_contacto',
--          'whatsapp','numero_whatsapp','phone','mobile'
--        )
--        AND length(regexp_replace(coalesce(fd.field_value,''), '\D', '', 'g')) >= 6
--        AND fd.field_value !~ '[a-zA-ZáéíóúÁÉÍÓÚñÑ]'
--      ORDER BY fd.created_at DESC
--      LIMIT 1
--    )
--  WHERE e.telefono_contacto IS NULL
--    AND e.chat_conversation_id IS NOT NULL;
