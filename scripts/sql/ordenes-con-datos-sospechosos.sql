-- =============================================================================
-- Órdenes del sorteo ACTIVO con datos corridos o mal cargados, por categoría.
--
-- Reemplaza a la versión anterior, que mezclaba el bug con otras cosas y marcaba como error
-- ciudades reales ("Campo 9", "Capiatá ruta 2", "25 de Diciembre").
--
-- Categorías:
--   1 corrido por el bot            el bug: un mensaje del chat ("Listo", "✅", "ya te mandé el
--                                   comprobante") quedó como cédula y la cédula real terminó al
--                                   principio del nombre. El apellido real suele estar en la ciudad.
--   2 nombre con la cédula repetida el cliente escribió la cédula también en el nombre.
--   3 cédula con texto de más       "Ci 4669886", "6811220 cedula": el número está, sobra texto.
--   4 cédula es un teléfono         el cliente mandó su celular como cédula: hay que pedírsela.
--   5 sin cédula válida             ".", "Buenos días", varias cédulas juntas: hay que pedírsela.
--   6 nombre con texto de chat      "Alexandra Ya está registrado mi compra?": revisar a mano.
--
-- Correr UN BLOQUE POR VEZ. Los bloques 1 y 2 NO escriben. Los 3, 4 y 5 SÍ escriben: sólo
-- corrigen lo que es seguro (el número de cédula que el cliente efectivamente escribió) y
-- devuelven cada fila tocada. Guardá el resultado del bloque 2 ANTES de correrlos: después de
-- corregir, esas órdenes dejan de aparecer. El orden entre 3, 4 y 5 no importa.
-- Schema: elpapustore_erp. Sólo sorteos con estado 'activo'.
-- =============================================================================


-- #############################################################################
-- BLOQUE 1 — Resumen: cuántas órdenes hay en cada categoría. No escribe.
-- #############################################################################
WITH ordenes AS (
  SELECT
    e.id AS entrada_id,
    e.numero_orden,
    e.created_at,
    e.nombre_participante,
    e.documento,
    e.whatsapp_numero,
    e.chat_conversation_id,
    regexp_replace(coalesce(e.documento, ''), '[\s.\-]', '', 'g') AS doc_limpio,
    regexp_match(coalesce(e.nombre_participante, ''), '^\s*([0-9]{6,8})\s+(.+)$') AS nom_m,
    ARRAY(
      SELECT m[1]
      FROM regexp_matches(
        regexp_replace(coalesce(e.documento, ''), '\.(?=[0-9])', '', 'g'),
        '(?<![0-9])([0-9]{5,9})(?![0-9])',
        'g'
      ) AS m
    ) AS doc_nums
  FROM elpapustore_erp.sorteo_entradas e
  JOIN elpapustore_erp.sorteos s ON s.id = e.sorteo_id
  WHERE s.estado = 'activo'
    AND e.estado_pago <> 'anulado'
    AND e.chat_conversation_id IS NOT NULL
),
clasificadas AS (
  SELECT
    o.*,
    (o.doc_limpio ~ '^[0-9]{5,9}$') AS doc_valida,
    CASE
      WHEN o.nom_m IS NOT NULL AND o.doc_limpio !~ '^[0-9]{5,9}$' THEN '1 corrido por el bot'
      WHEN o.nom_m IS NOT NULL AND o.nom_m[1] = o.doc_limpio THEN '2 nombre con la cédula repetida'
      WHEN o.doc_limpio !~ '^[0-9]{5,9}$' AND cardinality(o.doc_nums) = 1
           AND o.doc_nums[1] !~ '^(09|595)' THEN '3 cédula con texto de más'
      WHEN o.doc_limpio ~ '^(09[0-9]{8}|595[0-9]{9})$' THEN '4 cédula es un teléfono'
      WHEN o.doc_limpio !~ '^[0-9]{5,9}$' THEN '5 sin cédula válida'
      WHEN lower(coalesce(o.nombre_participante, '')) ~ '[0-9]'
        OR lower(coalesce(o.nombre_participante, '')) ~ '\m(listo|comprobante|hola|ya|envie|envié|pague|pagué|transferencia|apellido|nombre|ci|cedula|cédula|gracias|ok)\M'
           THEN '6 nombre con texto de chat'
    END AS categoria
  FROM ordenes o
)
SELECT categoria, count(*) AS ordenes
FROM clasificadas
WHERE categoria IS NOT NULL
GROUP BY categoria
ORDER BY categoria;


-- #############################################################################
-- BLOQUE 2 — Detalle con la corrección propuesta. No escribe.
--
-- `datos_al_comprar` = los cinco datos tal como quedaron en el chat al momento de la compra,
-- en orden: cédula · nombre · apellido · ciudad · celular. En un corrido se ve el corrimiento.
-- `cedula_propuesta`: segura en las categorías 1 a 3 (es lo que el cliente escribió).
-- `nombre_propuesto`: SÓLO sugerencia en la categoría 1 (nombre real + apellido que quedó en la
-- ciudad). Revisarlo: si el cliente no escribió su nombre, la sugerencia sale mal.
-- #############################################################################
WITH ordenes AS (
  SELECT
    e.id AS entrada_id,
    e.numero_orden,
    e.created_at,
    e.nombre_participante,
    e.documento,
    e.whatsapp_numero,
    e.chat_conversation_id,
    regexp_replace(coalesce(e.documento, ''), '[\s.\-]', '', 'g') AS doc_limpio,
    regexp_match(coalesce(e.nombre_participante, ''), '^\s*([0-9]{6,8})\s+(.+)$') AS nom_m,
    ARRAY(
      SELECT m[1]
      FROM regexp_matches(
        regexp_replace(coalesce(e.documento, ''), '\.(?=[0-9])', '', 'g'),
        '(?<![0-9])([0-9]{5,9})(?![0-9])',
        'g'
      ) AS m
    ) AS doc_nums
  FROM elpapustore_erp.sorteo_entradas e
  JOIN elpapustore_erp.sorteos s ON s.id = e.sorteo_id
  WHERE s.estado = 'activo'
    AND e.estado_pago <> 'anulado'
    AND e.chat_conversation_id IS NOT NULL
),
clasificadas AS (
  SELECT
    o.*,
    (o.doc_limpio ~ '^[0-9]{5,9}$') AS doc_valida,
    CASE
      WHEN o.nom_m IS NOT NULL AND o.doc_limpio !~ '^[0-9]{5,9}$' THEN '1 corrido por el bot'
      WHEN o.nom_m IS NOT NULL AND o.nom_m[1] = o.doc_limpio THEN '2 nombre con la cédula repetida'
      WHEN o.doc_limpio !~ '^[0-9]{5,9}$' AND cardinality(o.doc_nums) = 1
           AND o.doc_nums[1] !~ '^(09|595)' THEN '3 cédula con texto de más'
      WHEN o.doc_limpio ~ '^(09[0-9]{8}|595[0-9]{9})$' THEN '4 cédula es un teléfono'
      WHEN o.doc_limpio !~ '^[0-9]{5,9}$' THEN '5 sin cédula válida'
      WHEN lower(coalesce(o.nombre_participante, '')) ~ '[0-9]'
        OR lower(coalesce(o.nombre_participante, '')) ~ '\m(listo|comprobante|hola|ya|envie|envié|pague|pagué|transferencia|apellido|nombre|ci|cedula|cédula|gracias|ok)\M'
           THEN '6 nombre con texto de chat'
    END AS categoria
  FROM ordenes o
)
SELECT
  c.categoria,
  c.numero_orden,
  c.created_at,
  c.nombre_participante,
  c.documento,
  c.whatsapp_numero,
  CASE
    WHEN c.categoria = '1 corrido por el bot' THEN c.nom_m[1]
    WHEN c.categoria = '3 cédula con texto de más' THEN c.doc_nums[1]
  END AS cedula_propuesta,
  CASE
    WHEN c.categoria = '1 corrido por el bot'
         AND coalesce(f.apellido_real, '') ~ '^[^0-9]{2,40}$'
      THEN c.nom_m[2] || ' ' || f.apellido_real
    WHEN c.categoria = '1 corrido por el bot' THEN c.nom_m[2] || ' (falta apellido)'
    WHEN c.categoria = '2 nombre con la cédula repetida' THEN c.nom_m[2]
  END AS nombre_propuesto,
  concat_ws(' · ', f.cedula, f.nombre, f.apellido, f.apellido_real, f.celular) AS datos_al_comprar,
  c.entrada_id
FROM clasificadas c
LEFT JOIN LATERAL (
  SELECT
    max(x.v) FILTER (WHERE x.k = 'cedula')  AS cedula,
    max(x.v) FILTER (WHERE x.k = 'nombre')  AS nombre,
    max(x.v) FILTER (WHERE x.k = 'apellido') AS apellido,
    max(x.v) FILTER (WHERE x.k = 'ciudad')  AS apellido_real,
    max(x.v) FILTER (WHERE x.k = 'celular') AS celular
  FROM (
    SELECT DISTINCT ON (fd.field_name) fd.field_name AS k, left(fd.field_value, 60) AS v
    FROM elpapustore_erp.chat_flow_data fd
    WHERE fd.conversation_id = c.chat_conversation_id
      AND fd.field_name IN ('cedula', 'nombre', 'apellido', 'ciudad', 'celular')
      AND fd.created_at <= c.created_at + interval '1 minute'
      AND trim(fd.field_value) <> ''
    ORDER BY fd.field_name, fd.created_at DESC
  ) x
) f ON true
WHERE c.categoria IS NOT NULL
ORDER BY c.categoria, c.created_at DESC;


-- #############################################################################
-- BLOQUE 3 — ESCRIBE. Corridos por el bot: cédula y nombre.
-- La cédula real es el número con el que empieza el nombre (el cliente lo escribió cuando se le
-- pidió la cédula), y ese número sale del nombre: "6192512 Rocio" → cédula 6192512, nombre "Rocio".
-- El apellido que quedó en la ciudad NO se agrega solo: a veces es una ciudad de verdad
-- ("7427188 Haedo" con ciudad "Capiibary"). Anotá antes la columna `nombre_propuesto` del
-- bloque 2 y completá a mano los apellidos que correspondan.
-- #############################################################################
WITH ordenes AS (
  SELECT
    e.id AS entrada_id,
    e.numero_orden,
    e.created_at,
    e.nombre_participante,
    e.documento,
    e.whatsapp_numero,
    e.chat_conversation_id,
    regexp_replace(coalesce(e.documento, ''), '[\s.\-]', '', 'g') AS doc_limpio,
    regexp_match(coalesce(e.nombre_participante, ''), '^\s*([0-9]{6,8})\s+(.+)$') AS nom_m,
    ARRAY(
      SELECT m[1]
      FROM regexp_matches(
        regexp_replace(coalesce(e.documento, ''), '\.(?=[0-9])', '', 'g'),
        '(?<![0-9])([0-9]{5,9})(?![0-9])',
        'g'
      ) AS m
    ) AS doc_nums
  FROM elpapustore_erp.sorteo_entradas e
  JOIN elpapustore_erp.sorteos s ON s.id = e.sorteo_id
  WHERE s.estado = 'activo'
    AND e.estado_pago <> 'anulado'
    AND e.chat_conversation_id IS NOT NULL
),
clasificadas AS (
  SELECT
    o.*,
    (o.doc_limpio ~ '^[0-9]{5,9}$') AS doc_valida,
    CASE
      WHEN o.nom_m IS NOT NULL AND o.doc_limpio !~ '^[0-9]{5,9}$' THEN '1 corrido por el bot'
      WHEN o.nom_m IS NOT NULL AND o.nom_m[1] = o.doc_limpio THEN '2 nombre con la cédula repetida'
      WHEN o.doc_limpio !~ '^[0-9]{5,9}$' AND cardinality(o.doc_nums) = 1
           AND o.doc_nums[1] !~ '^(09|595)' THEN '3 cédula con texto de más'
      WHEN o.doc_limpio ~ '^(09[0-9]{8}|595[0-9]{9})$' THEN '4 cédula es un teléfono'
      WHEN o.doc_limpio !~ '^[0-9]{5,9}$' THEN '5 sin cédula válida'
      WHEN lower(coalesce(o.nombre_participante, '')) ~ '[0-9]'
        OR lower(coalesce(o.nombre_participante, '')) ~ '\m(listo|comprobante|hola|ya|envie|envié|pague|pagué|transferencia|apellido|nombre|ci|cedula|cédula|gracias|ok)\M'
           THEN '6 nombre con texto de chat'
    END AS categoria
  FROM ordenes o
)
UPDATE elpapustore_erp.sorteo_entradas e
   SET documento = c.nom_m[1],
       nombre_participante = c.nom_m[2]
  FROM clasificadas c
 WHERE e.id = c.entrada_id
   AND c.categoria = '1 corrido por el bot'
RETURNING e.numero_orden, e.nombre_participante AS nombre_corregido, e.documento AS cedula_corregida;


-- #############################################################################
-- BLOQUE 4 — ESCRIBE. Cédula con texto de más: deja sólo el número ("Ci 4669886" → 4669886).
-- #############################################################################
WITH ordenes AS (
  SELECT
    e.id AS entrada_id,
    e.numero_orden,
    e.created_at,
    e.nombre_participante,
    e.documento,
    e.whatsapp_numero,
    e.chat_conversation_id,
    regexp_replace(coalesce(e.documento, ''), '[\s.\-]', '', 'g') AS doc_limpio,
    regexp_match(coalesce(e.nombre_participante, ''), '^\s*([0-9]{6,8})\s+(.+)$') AS nom_m,
    ARRAY(
      SELECT m[1]
      FROM regexp_matches(
        regexp_replace(coalesce(e.documento, ''), '\.(?=[0-9])', '', 'g'),
        '(?<![0-9])([0-9]{5,9})(?![0-9])',
        'g'
      ) AS m
    ) AS doc_nums
  FROM elpapustore_erp.sorteo_entradas e
  JOIN elpapustore_erp.sorteos s ON s.id = e.sorteo_id
  WHERE s.estado = 'activo'
    AND e.estado_pago <> 'anulado'
    AND e.chat_conversation_id IS NOT NULL
),
clasificadas AS (
  SELECT
    o.*,
    (o.doc_limpio ~ '^[0-9]{5,9}$') AS doc_valida,
    CASE
      WHEN o.nom_m IS NOT NULL AND o.doc_limpio !~ '^[0-9]{5,9}$' THEN '1 corrido por el bot'
      WHEN o.nom_m IS NOT NULL AND o.nom_m[1] = o.doc_limpio THEN '2 nombre con la cédula repetida'
      WHEN o.doc_limpio !~ '^[0-9]{5,9}$' AND cardinality(o.doc_nums) = 1
           AND o.doc_nums[1] !~ '^(09|595)' THEN '3 cédula con texto de más'
      WHEN o.doc_limpio ~ '^(09[0-9]{8}|595[0-9]{9})$' THEN '4 cédula es un teléfono'
      WHEN o.doc_limpio !~ '^[0-9]{5,9}$' THEN '5 sin cédula válida'
      WHEN lower(coalesce(o.nombre_participante, '')) ~ '[0-9]'
        OR lower(coalesce(o.nombre_participante, '')) ~ '\m(listo|comprobante|hola|ya|envie|envié|pague|pagué|transferencia|apellido|nombre|ci|cedula|cédula|gracias|ok)\M'
           THEN '6 nombre con texto de chat'
    END AS categoria
  FROM ordenes o
)
UPDATE elpapustore_erp.sorteo_entradas e
   SET documento = c.doc_nums[1]
  FROM clasificadas c
 WHERE e.id = c.entrada_id
   AND c.categoria = '3 cédula con texto de más'
RETURNING e.numero_orden, e.nombre_participante, e.documento AS cedula_corregida;


-- #############################################################################
-- BLOQUE 5 — ESCRIBE. Nombre con la cédula repetida: saca el número del nombre
-- ("5207705 Luz" con cédula 5207705 → "Luz").
-- #############################################################################
WITH ordenes AS (
  SELECT
    e.id AS entrada_id,
    e.numero_orden,
    e.created_at,
    e.nombre_participante,
    e.documento,
    e.whatsapp_numero,
    e.chat_conversation_id,
    regexp_replace(coalesce(e.documento, ''), '[\s.\-]', '', 'g') AS doc_limpio,
    regexp_match(coalesce(e.nombre_participante, ''), '^\s*([0-9]{6,8})\s+(.+)$') AS nom_m,
    ARRAY(
      SELECT m[1]
      FROM regexp_matches(
        regexp_replace(coalesce(e.documento, ''), '\.(?=[0-9])', '', 'g'),
        '(?<![0-9])([0-9]{5,9})(?![0-9])',
        'g'
      ) AS m
    ) AS doc_nums
  FROM elpapustore_erp.sorteo_entradas e
  JOIN elpapustore_erp.sorteos s ON s.id = e.sorteo_id
  WHERE s.estado = 'activo'
    AND e.estado_pago <> 'anulado'
    AND e.chat_conversation_id IS NOT NULL
),
clasificadas AS (
  SELECT
    o.*,
    (o.doc_limpio ~ '^[0-9]{5,9}$') AS doc_valida,
    CASE
      WHEN o.nom_m IS NOT NULL AND o.doc_limpio !~ '^[0-9]{5,9}$' THEN '1 corrido por el bot'
      WHEN o.nom_m IS NOT NULL AND o.nom_m[1] = o.doc_limpio THEN '2 nombre con la cédula repetida'
      WHEN o.doc_limpio !~ '^[0-9]{5,9}$' AND cardinality(o.doc_nums) = 1
           AND o.doc_nums[1] !~ '^(09|595)' THEN '3 cédula con texto de más'
      WHEN o.doc_limpio ~ '^(09[0-9]{8}|595[0-9]{9})$' THEN '4 cédula es un teléfono'
      WHEN o.doc_limpio !~ '^[0-9]{5,9}$' THEN '5 sin cédula válida'
      WHEN lower(coalesce(o.nombre_participante, '')) ~ '[0-9]'
        OR lower(coalesce(o.nombre_participante, '')) ~ '\m(listo|comprobante|hola|ya|envie|envié|pague|pagué|transferencia|apellido|nombre|ci|cedula|cédula|gracias|ok)\M'
           THEN '6 nombre con texto de chat'
    END AS categoria
  FROM ordenes o
)
UPDATE elpapustore_erp.sorteo_entradas e
   SET nombre_participante = c.nom_m[2]
  FROM clasificadas c
 WHERE e.id = c.entrada_id
   AND c.categoria = '2 nombre con la cédula repetida'
RETURNING e.numero_orden, e.nombre_participante AS nombre_corregido, e.documento;
