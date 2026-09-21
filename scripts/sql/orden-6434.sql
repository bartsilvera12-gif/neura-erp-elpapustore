-- =============================================================================
-- Orden 6434: corregir el teléfono impreso y regenerar la boleta.
--
-- Correr UN BLOQUE POR VEZ. Cada bloque es una sola sentencia — seleccionála y ejecutala sola.
-- No hay nada que completar a mano: la entrada se identifica por número de orden + la línea de
-- WhatsApp del comprador que reclamó (595984462823).
--
-- `numero_orden` NO identifica una fila por sí solo: es un contador por sorteo
-- (`sorteos.ultimo_numero_orden`) y el mismo número existe en varios sorteos. Sumarle el
-- WhatsApp deja una sola fila. El bloque 1 lo confirma antes de escribir nada.
-- =============================================================================


-- #############################################################################
-- BLOQUE 1 — Ver la entrada. No escribe.
--
-- Tiene que devolver UNA fila. Si devuelve más de una (el mismo comprador con el número 6434
-- en dos sorteos), no corras el bloque 2: avisame y lo acotamos por sorteo.
--
-- `telefono_declarado_en_el_bot` es lo que cargó la persona; `campo_donde_lo_guardo`, el
-- save_as_field exacto del nodo del flujo.
-- #############################################################################
SELECT
  e.id                AS entrada_id,
  e.numero_orden,
  s.nombre            AS sorteo,
  e.nombre_participante,
  e.whatsapp_numero   AS linea_de_whatsapp,
  e.telefono_contacto AS telefono_que_se_imprime,
  e.created_at,
  decl.field_value    AS telefono_declarado_en_el_bot,
  decl.field_name     AS campo_donde_lo_guardo
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
WHERE e.numero_orden = 6434
  AND e.whatsapp_numero = '595984462823';


-- #############################################################################
-- BLOQUE 2 — Corregir el teléfono.
-- El RETURNING tiene que mostrar UNA fila con 0973592372 en telefono_contacto.
-- #############################################################################
UPDATE elpapustore_erp.sorteo_entradas
   SET telefono_contacto = '0973592372'
 WHERE numero_orden = 6434
   AND whatsapp_numero = '595984462823'
RETURNING id, numero_orden, nombre_participante, whatsapp_numero, telefono_contacto;


-- #############################################################################
-- BLOQUE 3 — Alinear el CRM.
-- `clientes.telefono` no se toca: guarda el WhatsApp, que es la clave de la recompra rápida.
-- #############################################################################
UPDATE elpapustore_erp.clientes c
   SET telefono_secundario = e.telefono_contacto
  FROM elpapustore_erp.sorteo_entradas e
 WHERE e.numero_orden = 6434
   AND e.whatsapp_numero = '595984462823'
   AND c.id = e.cliente_id
   AND e.telefono_contacto IS NOT NULL
RETURNING c.id, c.nombre, c.telefono AS whatsapp, c.telefono_secundario AS celular_declarado;


-- #############################################################################
-- BLOQUE 4 — El ticket a regenerar.
--
-- Con el `ticket_id` que devuelve: Panel → Sorteos → Tickets → buscar la orden 6434 →
-- "Regenerar" (nueva revisión del PNG, NO reenvía nada al cliente) → "Ver" abre la imagen en
-- una pestaña nueva → botón derecho → Guardar imagen como... Esa es la que mandás por WhatsApp.
--
-- Antes de regenerar, confirmá que terminó el deploy de Vercel con el fix: si no, el PNG se
-- rehace igual de mal y hay que repetirlo.
-- #############################################################################
SELECT d.id AS ticket_id, d.status, d.template_revision, d.is_current, d.storage_path, d.created_at
  FROM elpapustore_erp.sorteo_ticket_deliveries d
  JOIN elpapustore_erp.sorteo_entradas e ON e.id = d.entrada_id
 WHERE e.numero_orden = 6434
   AND e.whatsapp_numero = '595984462823'
 ORDER BY d.template_revision DESC;


-- #############################################################################
-- BLOQUE 5 — Verificación, después de regenerar.
-- `telefono_impreso` tiene que decir 0973592372 y `template_revision` haber subido.
-- #############################################################################
SELECT
  e.numero_orden,
  e.nombre_participante,
  e.whatsapp_numero    AS linea_de_whatsapp,
  e.telefono_contacto  AS telefono_impreso,
  d.template_revision,
  d.status,
  d.is_current,
  d.created_at         AS png_generado
FROM elpapustore_erp.sorteo_entradas e
JOIN elpapustore_erp.sorteo_ticket_deliveries d ON d.entrada_id = e.id
WHERE e.numero_orden = 6434
  AND e.whatsapp_numero = '595984462823'
ORDER BY d.template_revision DESC;
