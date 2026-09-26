-- =============================================================================
-- Órdenes con datos que parecen corridos de campo (cédula, nombre, teléfono, ciudad).
--
-- Hasta el fix del 26-sep, un mensaje escrito mientras el bot enviaba la siguiente pregunta
-- ("Listo", "ya te mandé") se guardaba en el campo nuevo y el resto de la carga quedaba corrida
-- un lugar: la cédula en el nombre, el nombre en el apellido, la ciudad en el teléfono. La
-- mayoría lo corrigió con "corregir datos" en el resumen, pero alguno puede haber confirmado
-- con los datos mal. Esta consulta los busca por señales que no pueden ser datos válidos.
--
-- Es una consulta: NO escribe nada. Cada fila dice por qué quedó marcada (`motivos`).
-- Schema: elpapustore_erp. Cambiar los 30 días si hace falta mirar más atrás.
-- =============================================================================
WITH ordenes AS (
  SELECT
    e.id AS entrada_id,
    e.numero_orden,
    s.nombre AS sorteo,
    e.created_at,
    e.nombre_participante,
    e.documento,
    e.whatsapp_numero,
    e.telefono_contacto,
    c.ciudad,
    regexp_replace(coalesce(e.documento, ''), '[\s.\-]', '', 'g') AS doc_limpio,
    lower(coalesce(e.nombre_participante, '')) AS nombre_lower
  FROM elpapustore_erp.sorteo_entradas e
  LEFT JOIN elpapustore_erp.sorteos s ON s.id = e.sorteo_id
  LEFT JOIN elpapustore_erp.clientes c ON c.id = e.cliente_id
  WHERE e.created_at >= now() - interval '30 days'
    AND e.estado_pago <> 'anulado'
    AND e.chat_conversation_id IS NOT NULL
),
marcadas AS (
  SELECT
    o.*,
    array_remove(ARRAY[
      CASE WHEN o.doc_limpio = '' THEN 'cédula vacía' END,
      CASE WHEN o.doc_limpio ~ '[^0-9]' THEN 'cédula con letras' END,
      CASE WHEN o.doc_limpio ~ '^[0-9]+$' AND (length(o.doc_limpio) < 5 OR length(o.doc_limpio) > 9)
           THEN 'cédula de largo raro' END,
      CASE WHEN o.doc_limpio ~ '^(09[0-9]{8}|595[0-9]{9})$' THEN 'cédula parece un teléfono' END,
      CASE WHEN o.nombre_lower ~ '[0-9]' THEN 'nombre con números' END,
      CASE WHEN o.nombre_lower ~ '\m(listo|lista|comprobante|hola|ya|envie|envié|pague|pagué|transferencia|apellido|nombre|ci|cedula|cédula|gracias|ok|si|no)\M'
           THEN 'nombre con palabras de chat' END,
      CASE WHEN o.nombre_lower <> '' AND o.nombre_lower !~ '\s' THEN 'nombre de una sola palabra' END,
      CASE WHEN coalesce(o.telefono_contacto, '') ~ '[A-Za-zÁÉÍÓÚáéíóúÑñ]' THEN 'teléfono con letras' END,
      CASE WHEN coalesce(o.ciudad, '') ~ '[0-9]' THEN 'ciudad con números' END
    ], NULL) AS motivos
  FROM ordenes o
)
SELECT
  numero_orden,
  sorteo,
  created_at,
  nombre_participante,
  documento,
  whatsapp_numero,
  telefono_contacto,
  ciudad,
  array_to_string(motivos, ' · ') AS motivos,
  entrada_id
FROM marcadas
WHERE cardinality(motivos) > 0
ORDER BY
  /* primero las más probables: más de una señal, o un número donde va un nombre */
  (cardinality(motivos) > 1 OR 'nombre con números' = ANY (motivos)) DESC,
  created_at DESC
LIMIT 300;
