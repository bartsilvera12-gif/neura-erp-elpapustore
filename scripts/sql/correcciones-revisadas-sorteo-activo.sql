-- =============================================================================
-- Correcciones REVISADAS a mano, orden por orden (sorteo activo), después de los bloques
-- automáticos de `ordenes-con-datos-sospechosos.sql`.
--
-- Cada fila de la lista se leyó contra los datos que el cliente escribió en el chat al comprar
-- (columna `datos_al_comprar` del bloque 2). Se identifican por `entrada_id`, no por número de
-- orden, porque el número se repite entre sorteos.
--
--   · 47 órdenes: sólo el nombre (sobre todo corridos cuyo apellido quedó en "ciudad").
--   · 17 órdenes: cédula recuperada del chat + nombre limpio.
--   · 46 órdenes: no hay dato recuperable, hay que pedírselo al cliente (bloque 3).
--
-- Correr UN BLOQUE POR VEZ. El bloque 1 NO escribe: muestra el antes y el después para revisar.
-- El bloque 2 SÍ escribe. Schema: elpapustore_erp.
-- =============================================================================


-- #############################################################################
-- BLOQUE 1 — Revisión: cómo está hoy y cómo quedaría. No escribe.
-- #############################################################################
WITH cambios (entrada_id, numero_orden, nombre_nuevo, cedula_nueva, motivo) AS (
  VALUES
  ('0eb31d45-2b85-40b7-a890-9ab3c8bc4eed'::uuid, 8982, 'Maria Rivarola', NULL, 'corrido: apellido estaba en ciudad'),
  ('a861f457-0e51-4673-af25-bc980aa26fbf'::uuid, 8766, 'Rocio Alvarez', NULL, 'corrido: apellido estaba en ciudad'),
  ('b94573ab-06e4-4ea5-95bc-32dc4511d584'::uuid, 8706, 'Hugo Britez', NULL, 'corrido: apellido estaba en ciudad'),
  ('b49b003b-40e6-4b72-9d61-bc260a26cd57'::uuid, 8478, 'Juliana Da Silva', NULL, 'corrido doble: nombre y apellido en ciudad/celular'),
  ('a548dfb8-a259-466c-a19a-84ffab4e1d73'::uuid, 8217, 'Areli Riveiro', NULL, 'corrido: apellido estaba en ciudad'),
  ('5d0b65d1-d41c-4c3d-8683-05a2063ae970'::uuid, 7408, 'Norma Rojas', NULL, 'corrido: apellido estaba en ciudad'),
  ('b8d2c248-15eb-4ea4-a2c5-9df177af39ab'::uuid, 7184, 'Soledad Nuñez', NULL, 'corrido: apellido estaba en ciudad'),
  ('f456db3f-9c8d-4820-af5e-5055c7cdf604'::uuid, 6996, 'David Rojas Sosa', NULL, 'corrido: el nombre completo quedo como cedula'),
  ('7d3435d3-e4be-40e8-ab41-a8c42b3b4e1c'::uuid, 6646, 'Natalia Ferreira', NULL, 'corrido: apellido estaba en ciudad'),
  ('f200f0b9-c96e-402b-be26-e8339c4fe162'::uuid, 6511, 'Liz Lezcano', NULL, 'corrido: apellido estaba en ciudad'),
  ('0756d2ab-25f3-4f23-a874-c3889404cba3'::uuid, 5920, 'Nahir Agüero', NULL, 'corrido: apellido estaba en ciudad'),
  ('92157a7f-4a5e-43f2-89b0-dcb5539d9ad7'::uuid, 5721, 'Fabio Perez', NULL, 'corrido: apellido estaba en ciudad'),
  ('329df6b3-57b9-4c81-8012-72c899cec014'::uuid, 5706, 'Erik Sosa', NULL, 'corrido: apellido estaba en ciudad'),
  ('3bd33d44-9161-4bec-9ace-d8c887980b07'::uuid, 5353, 'Vanessa Rivarola', NULL, 'corrido: apellido estaba en ciudad'),
  ('f21920ec-3e04-4c34-8461-0553b96d86cf'::uuid, 4891, 'Luz Meza', NULL, 'corrido: apellido estaba en ciudad'),
  ('5359ef3c-8e3e-4242-aa6c-f38d889758ac'::uuid, 4828, 'Noelia Santander', NULL, 'corrido: apellido estaba en ciudad'),
  ('33d1bbc1-acb8-4878-856f-acca8e06c879'::uuid, 4651, 'Pedro González', NULL, 'corrido: nombre invertido'),
  ('fb1c6664-2a81-448d-b102-992bf2f78ae1'::uuid, 4493, 'Mirna Denis', NULL, 'corrido: apellido estaba en ciudad'),
  ('34b69e96-30d2-4663-9af0-328175ba8df5'::uuid, 3590, 'Sebastián Rodriguez', NULL, 'corrido: apellido estaba en ciudad'),
  ('b0aca3d6-7780-451a-9e39-41ba60196fa7'::uuid, 3555, 'Fabiola Giménez', NULL, 'corrido: apellido estaba en ciudad'),
  ('168506ed-6ebd-4cd5-9ff3-a1a7e5b55669'::uuid, 3045, 'Silvano Pereira', NULL, 'corrido: apellido estaba en ciudad'),
  ('6b31048d-c97e-4cd9-bb5a-4a86aa59be8a'::uuid, 2802, 'Juan Duarte', NULL, 'corrido: apellido estaba en ciudad'),
  ('d12dde53-bd8c-47a7-b7c5-cb03b5aa406e'::uuid, 2561, 'Maximiliano Caballero', NULL, 'corrido: apellido estaba en ciudad'),
  ('90273fb8-3956-4c0c-a278-07e508046c21'::uuid, 1566, 'Matías Da Silva', NULL, 'corrido: apellido estaba en ciudad'),
  ('f32f94cd-196e-4572-bdc4-87c77b20937c'::uuid, 1441, 'Claudio Arce', NULL, 'corrido: apellido estaba en ciudad'),
  ('965bf13e-3bb1-4f37-b6d4-b9e60c15ca8a'::uuid, 790, 'Carolina Coronel', NULL, 'corrido: apellido estaba en ciudad'),
  ('d7cf2bd5-2e3a-4929-ba1d-2999caf5d28e'::uuid, 830, 'Zainab Omairi', NULL, 'nombre con rotulos'),
  ('f431d489-324c-417f-b250-0f06003e8be5'::uuid, 2224, 'Julio López', NULL, 'nombre con la cedula'),
  ('9af7a0c5-9a3f-4720-ac82-2a05c1882953'::uuid, 2412, 'José Cáceres', NULL, 'nombre con texto del chat'),
  ('33c96905-dc1e-4aca-bdc8-e6ed24f92591'::uuid, 2469, 'Natalia Barrios', NULL, 'nombre con texto del chat'),
  ('42955da0-0246-4633-a5d5-e6b01255f29e'::uuid, 3512, 'Juan Roa', NULL, 'nombre con el telefono'),
  ('c77446fb-53e0-4599-bb45-d42445d46f5d'::uuid, 3760, 'Hugo Amarilla', NULL, 'nombre con rotulos'),
  ('0a62a8d4-5887-4759-b5ce-a6cddde25c63'::uuid, 3962, 'Jorge Daniel Giménez Ramírez', NULL, 'nombre con texto del chat'),
  ('9dee6e58-d2de-43d8-85ba-bdebb85dfc96'::uuid, 6554, 'César Ramirez', NULL, 'nombre con rotulos'),
  ('be4e9a71-b455-46cb-b89e-c64cd16798c6'::uuid, 6879, 'Brayan Leonardo Gutierrez Caceres', NULL, 'nombre con la cedula'),
  ('666de416-54f0-4996-9838-e93c030466df'::uuid, 8850, 'Araceli Cardozo', NULL, 'nombre con texto del chat'),
  ('259ac7ea-082c-47de-8605-4824f65a0eaf'::uuid, 6486, 'Pedro Ortiz', NULL, 'nombre con texto del chat'),
  ('982f6185-c85d-40a3-83f9-646b985d6a45'::uuid, 6082, 'Analia Gómez', NULL, 'nombre con texto del chat'),
  ('41a1a58f-a631-46fb-88c6-0bd4e4be05eb'::uuid, 4982, 'Victor Vigo', NULL, 'corrido: telefono en nombre, apellido en ciudad'),
  ('9bd55aef-1bb4-4b9b-9bac-ba895eae37aa'::uuid, 4877, 'Alex Cañete', NULL, 'nombre con texto del chat'),
  ('97065992-6807-4adb-a7d8-3265658d7dd6'::uuid, 3937, 'Juan Escobar', NULL, 'corrido: apellido estaba en ciudad'),
  ('10c9bc70-d1b6-47d4-8118-257b9202abdb'::uuid, 3588, 'Deivid Lopez', NULL, 'corrido: apellido estaba en ciudad'),
  ('756ee8a2-4d61-434a-8269-d48a00d071f7'::uuid, 2801, 'Pedro Fabian Garrido Yegros', NULL, 'nombre con texto del chat'),
  ('9146b459-9934-4ed3-8970-57f14070a543'::uuid, 2175, 'Karen Ruiz Diaz', NULL, 'nombre con texto del chat'),
  ('a648de26-ef87-4ad0-b4b2-a2e4e71f77a7'::uuid, 9179, 'Mirta', NULL, 'nombre con texto del chat (apellido desconocido)'),
  ('dcbaa76d-b07b-4d6a-9131-02014bce5805'::uuid, 8532, 'Alexandra', NULL, 'nombre con texto del chat (apellido desconocido)'),
  ('9b420703-d53e-4a50-aa43-bc957fb87419'::uuid, 6451, 'Alexandra', NULL, 'nombre con texto del chat (apellido desconocido)'),
  ('4af52468-55d9-481c-8a12-32dec77c2e46'::uuid, 8941, 'Lorenza Servin', '6614147', 'cedula y nombre escritos juntos'),
  ('6a64dda3-82dd-4680-a257-d8ffa181108f'::uuid, 8182, 'Daniel Ayala Garcia', '5956603', 'cedula y nombre escritos juntos'),
  ('29f7475b-52bf-451b-bc94-fe00c842f73f'::uuid, 7937, 'Grissel Bordón', '5500308', 'cedula en el nombre'),
  ('330b939e-c2fb-4d10-b2a0-27f84a4fa299'::uuid, 7280, 'Alex Zarate', '5370237', 'cedula en el nombre'),
  ('85288d07-a681-4141-925d-defbbf3f9138'::uuid, 5686, 'Jonathan Fariña', '6509085', 'corrido: cedula en nombre, nombre en cedula'),
  ('7e47911a-b004-431f-bddd-b8d262b13356'::uuid, 4913, 'Fabiola Villalba', '6857021', 'cedula en el nombre'),
  ('a18a597d-e692-4326-9706-5bcb3d9ab5c7'::uuid, 4746, 'Santos Colman', '8471102', 'cedula y nombre escritos juntos'),
  ('8d80bc1e-34ab-4c23-9fa7-2edcf52f492b'::uuid, 3593, 'Jose Martinez', '4740064', 'corrido doble'),
  ('9e1ba531-0f00-4895-8ce7-9ab023221dec'::uuid, 2984, 'Lino Ramírez', '7338901', 'corrido: cedula quedo en ciudad'),
  ('21814d3b-3c34-403d-b83e-d4783df244a8'::uuid, 903, 'Lino Ramírez', '7338901', 'corrido: cedula quedo en ciudad'),
  ('e3c38f6b-a475-48ef-940c-d06981236ae2'::uuid, 2856, 'Juan Guanez', '6035391', 'cedula en el nombre'),
  ('56769454-2376-41ae-88e8-5b5538820c5a'::uuid, 2823, 'Ruth Maciel', '7470825', 'corrido: cedula en nombre, nombre en cedula'),
  ('b482d3fe-bd59-4aaf-88b1-9c723e76b57c'::uuid, 2804, 'Osvaldo Ignacio Fernández', '6137564', 'cedula en el nombre'),
  ('c6b705f5-8e27-4cda-af5a-55c3f51f6190'::uuid, 1944, 'Lidia Ester Candia', '5737690', 'cedula en el nombre'),
  ('e4e1f0d9-2a86-4dcd-9c12-1babbb738408'::uuid, 5296, 'Lisset Martinez Florentin', '6817836', 'datos de dos personas: se toma la primera'),
  ('ee9f6d88-d225-44c1-b317-1c1fb9e913a4'::uuid, 2589, 'Mary Martinez', '6671580', 'cedula quedo en celular (''6671580 cedula'')'),
  ('1cc54577-d816-488c-a5ac-3d85ae0458c4'::uuid, 8740, 'Karen Martínez', '4103215', 'la orden tiene el telefono; en el chat escribio la cedula')
)
SELECT
  c.numero_orden,
  e.nombre_participante AS nombre_hoy,
  c.nombre_nuevo,
  e.documento AS cedula_hoy,
  coalesce(c.cedula_nueva, e.documento) AS cedula_final,
  c.motivo
FROM cambios c
JOIN elpapustore_erp.sorteo_entradas e ON e.id = c.entrada_id
ORDER BY c.numero_orden DESC;


-- #############################################################################
-- BLOQUE 2 — ESCRIBE. Aplica las correcciones de la lista.
-- La cédula sólo se cambia en las filas que traen una. En el resto queda la actual.
-- #############################################################################
WITH cambios (entrada_id, numero_orden, nombre_nuevo, cedula_nueva, motivo) AS (
  VALUES
  ('0eb31d45-2b85-40b7-a890-9ab3c8bc4eed'::uuid, 8982, 'Maria Rivarola', NULL, 'corrido: apellido estaba en ciudad'),
  ('a861f457-0e51-4673-af25-bc980aa26fbf'::uuid, 8766, 'Rocio Alvarez', NULL, 'corrido: apellido estaba en ciudad'),
  ('b94573ab-06e4-4ea5-95bc-32dc4511d584'::uuid, 8706, 'Hugo Britez', NULL, 'corrido: apellido estaba en ciudad'),
  ('b49b003b-40e6-4b72-9d61-bc260a26cd57'::uuid, 8478, 'Juliana Da Silva', NULL, 'corrido doble: nombre y apellido en ciudad/celular'),
  ('a548dfb8-a259-466c-a19a-84ffab4e1d73'::uuid, 8217, 'Areli Riveiro', NULL, 'corrido: apellido estaba en ciudad'),
  ('5d0b65d1-d41c-4c3d-8683-05a2063ae970'::uuid, 7408, 'Norma Rojas', NULL, 'corrido: apellido estaba en ciudad'),
  ('b8d2c248-15eb-4ea4-a2c5-9df177af39ab'::uuid, 7184, 'Soledad Nuñez', NULL, 'corrido: apellido estaba en ciudad'),
  ('f456db3f-9c8d-4820-af5e-5055c7cdf604'::uuid, 6996, 'David Rojas Sosa', NULL, 'corrido: el nombre completo quedo como cedula'),
  ('7d3435d3-e4be-40e8-ab41-a8c42b3b4e1c'::uuid, 6646, 'Natalia Ferreira', NULL, 'corrido: apellido estaba en ciudad'),
  ('f200f0b9-c96e-402b-be26-e8339c4fe162'::uuid, 6511, 'Liz Lezcano', NULL, 'corrido: apellido estaba en ciudad'),
  ('0756d2ab-25f3-4f23-a874-c3889404cba3'::uuid, 5920, 'Nahir Agüero', NULL, 'corrido: apellido estaba en ciudad'),
  ('92157a7f-4a5e-43f2-89b0-dcb5539d9ad7'::uuid, 5721, 'Fabio Perez', NULL, 'corrido: apellido estaba en ciudad'),
  ('329df6b3-57b9-4c81-8012-72c899cec014'::uuid, 5706, 'Erik Sosa', NULL, 'corrido: apellido estaba en ciudad'),
  ('3bd33d44-9161-4bec-9ace-d8c887980b07'::uuid, 5353, 'Vanessa Rivarola', NULL, 'corrido: apellido estaba en ciudad'),
  ('f21920ec-3e04-4c34-8461-0553b96d86cf'::uuid, 4891, 'Luz Meza', NULL, 'corrido: apellido estaba en ciudad'),
  ('5359ef3c-8e3e-4242-aa6c-f38d889758ac'::uuid, 4828, 'Noelia Santander', NULL, 'corrido: apellido estaba en ciudad'),
  ('33d1bbc1-acb8-4878-856f-acca8e06c879'::uuid, 4651, 'Pedro González', NULL, 'corrido: nombre invertido'),
  ('fb1c6664-2a81-448d-b102-992bf2f78ae1'::uuid, 4493, 'Mirna Denis', NULL, 'corrido: apellido estaba en ciudad'),
  ('34b69e96-30d2-4663-9af0-328175ba8df5'::uuid, 3590, 'Sebastián Rodriguez', NULL, 'corrido: apellido estaba en ciudad'),
  ('b0aca3d6-7780-451a-9e39-41ba60196fa7'::uuid, 3555, 'Fabiola Giménez', NULL, 'corrido: apellido estaba en ciudad'),
  ('168506ed-6ebd-4cd5-9ff3-a1a7e5b55669'::uuid, 3045, 'Silvano Pereira', NULL, 'corrido: apellido estaba en ciudad'),
  ('6b31048d-c97e-4cd9-bb5a-4a86aa59be8a'::uuid, 2802, 'Juan Duarte', NULL, 'corrido: apellido estaba en ciudad'),
  ('d12dde53-bd8c-47a7-b7c5-cb03b5aa406e'::uuid, 2561, 'Maximiliano Caballero', NULL, 'corrido: apellido estaba en ciudad'),
  ('90273fb8-3956-4c0c-a278-07e508046c21'::uuid, 1566, 'Matías Da Silva', NULL, 'corrido: apellido estaba en ciudad'),
  ('f32f94cd-196e-4572-bdc4-87c77b20937c'::uuid, 1441, 'Claudio Arce', NULL, 'corrido: apellido estaba en ciudad'),
  ('965bf13e-3bb1-4f37-b6d4-b9e60c15ca8a'::uuid, 790, 'Carolina Coronel', NULL, 'corrido: apellido estaba en ciudad'),
  ('d7cf2bd5-2e3a-4929-ba1d-2999caf5d28e'::uuid, 830, 'Zainab Omairi', NULL, 'nombre con rotulos'),
  ('f431d489-324c-417f-b250-0f06003e8be5'::uuid, 2224, 'Julio López', NULL, 'nombre con la cedula'),
  ('9af7a0c5-9a3f-4720-ac82-2a05c1882953'::uuid, 2412, 'José Cáceres', NULL, 'nombre con texto del chat'),
  ('33c96905-dc1e-4aca-bdc8-e6ed24f92591'::uuid, 2469, 'Natalia Barrios', NULL, 'nombre con texto del chat'),
  ('42955da0-0246-4633-a5d5-e6b01255f29e'::uuid, 3512, 'Juan Roa', NULL, 'nombre con el telefono'),
  ('c77446fb-53e0-4599-bb45-d42445d46f5d'::uuid, 3760, 'Hugo Amarilla', NULL, 'nombre con rotulos'),
  ('0a62a8d4-5887-4759-b5ce-a6cddde25c63'::uuid, 3962, 'Jorge Daniel Giménez Ramírez', NULL, 'nombre con texto del chat'),
  ('9dee6e58-d2de-43d8-85ba-bdebb85dfc96'::uuid, 6554, 'César Ramirez', NULL, 'nombre con rotulos'),
  ('be4e9a71-b455-46cb-b89e-c64cd16798c6'::uuid, 6879, 'Brayan Leonardo Gutierrez Caceres', NULL, 'nombre con la cedula'),
  ('666de416-54f0-4996-9838-e93c030466df'::uuid, 8850, 'Araceli Cardozo', NULL, 'nombre con texto del chat'),
  ('259ac7ea-082c-47de-8605-4824f65a0eaf'::uuid, 6486, 'Pedro Ortiz', NULL, 'nombre con texto del chat'),
  ('982f6185-c85d-40a3-83f9-646b985d6a45'::uuid, 6082, 'Analia Gómez', NULL, 'nombre con texto del chat'),
  ('41a1a58f-a631-46fb-88c6-0bd4e4be05eb'::uuid, 4982, 'Victor Vigo', NULL, 'corrido: telefono en nombre, apellido en ciudad'),
  ('9bd55aef-1bb4-4b9b-9bac-ba895eae37aa'::uuid, 4877, 'Alex Cañete', NULL, 'nombre con texto del chat'),
  ('97065992-6807-4adb-a7d8-3265658d7dd6'::uuid, 3937, 'Juan Escobar', NULL, 'corrido: apellido estaba en ciudad'),
  ('10c9bc70-d1b6-47d4-8118-257b9202abdb'::uuid, 3588, 'Deivid Lopez', NULL, 'corrido: apellido estaba en ciudad'),
  ('756ee8a2-4d61-434a-8269-d48a00d071f7'::uuid, 2801, 'Pedro Fabian Garrido Yegros', NULL, 'nombre con texto del chat'),
  ('9146b459-9934-4ed3-8970-57f14070a543'::uuid, 2175, 'Karen Ruiz Diaz', NULL, 'nombre con texto del chat'),
  ('a648de26-ef87-4ad0-b4b2-a2e4e71f77a7'::uuid, 9179, 'Mirta', NULL, 'nombre con texto del chat (apellido desconocido)'),
  ('dcbaa76d-b07b-4d6a-9131-02014bce5805'::uuid, 8532, 'Alexandra', NULL, 'nombre con texto del chat (apellido desconocido)'),
  ('9b420703-d53e-4a50-aa43-bc957fb87419'::uuid, 6451, 'Alexandra', NULL, 'nombre con texto del chat (apellido desconocido)'),
  ('4af52468-55d9-481c-8a12-32dec77c2e46'::uuid, 8941, 'Lorenza Servin', '6614147', 'cedula y nombre escritos juntos'),
  ('6a64dda3-82dd-4680-a257-d8ffa181108f'::uuid, 8182, 'Daniel Ayala Garcia', '5956603', 'cedula y nombre escritos juntos'),
  ('29f7475b-52bf-451b-bc94-fe00c842f73f'::uuid, 7937, 'Grissel Bordón', '5500308', 'cedula en el nombre'),
  ('330b939e-c2fb-4d10-b2a0-27f84a4fa299'::uuid, 7280, 'Alex Zarate', '5370237', 'cedula en el nombre'),
  ('85288d07-a681-4141-925d-defbbf3f9138'::uuid, 5686, 'Jonathan Fariña', '6509085', 'corrido: cedula en nombre, nombre en cedula'),
  ('7e47911a-b004-431f-bddd-b8d262b13356'::uuid, 4913, 'Fabiola Villalba', '6857021', 'cedula en el nombre'),
  ('a18a597d-e692-4326-9706-5bcb3d9ab5c7'::uuid, 4746, 'Santos Colman', '8471102', 'cedula y nombre escritos juntos'),
  ('8d80bc1e-34ab-4c23-9fa7-2edcf52f492b'::uuid, 3593, 'Jose Martinez', '4740064', 'corrido doble'),
  ('9e1ba531-0f00-4895-8ce7-9ab023221dec'::uuid, 2984, 'Lino Ramírez', '7338901', 'corrido: cedula quedo en ciudad'),
  ('21814d3b-3c34-403d-b83e-d4783df244a8'::uuid, 903, 'Lino Ramírez', '7338901', 'corrido: cedula quedo en ciudad'),
  ('e3c38f6b-a475-48ef-940c-d06981236ae2'::uuid, 2856, 'Juan Guanez', '6035391', 'cedula en el nombre'),
  ('56769454-2376-41ae-88e8-5b5538820c5a'::uuid, 2823, 'Ruth Maciel', '7470825', 'corrido: cedula en nombre, nombre en cedula'),
  ('b482d3fe-bd59-4aaf-88b1-9c723e76b57c'::uuid, 2804, 'Osvaldo Ignacio Fernández', '6137564', 'cedula en el nombre'),
  ('c6b705f5-8e27-4cda-af5a-55c3f51f6190'::uuid, 1944, 'Lidia Ester Candia', '5737690', 'cedula en el nombre'),
  ('e4e1f0d9-2a86-4dcd-9c12-1babbb738408'::uuid, 5296, 'Lisset Martinez Florentin', '6817836', 'datos de dos personas: se toma la primera'),
  ('ee9f6d88-d225-44c1-b317-1c1fb9e913a4'::uuid, 2589, 'Mary Martinez', '6671580', 'cedula quedo en celular (''6671580 cedula'')'),
  ('1cc54577-d816-488c-a5ac-3d85ae0458c4'::uuid, 8740, 'Karen Martínez', '4103215', 'la orden tiene el telefono; en el chat escribio la cedula')
)
UPDATE elpapustore_erp.sorteo_entradas e
   SET nombre_participante = c.nombre_nuevo,
       documento = coalesce(c.cedula_nueva, e.documento)
  FROM cambios c
 WHERE e.id = c.entrada_id
RETURNING e.numero_orden, e.nombre_participante, e.documento;


-- #############################################################################
-- BLOQUE 3 — A quién hay que escribirle, y qué pedirle. No escribe.
-- #############################################################################
WITH pedir (entrada_id, numero_orden, que_falta) AS (
  VALUES
  ('c046079b-790f-4f3c-b8f3-9ecd71726712'::uuid, 7931, 'cédula (mandó su teléfono)'),
  ('c27a89fb-9ee5-4f72-8563-6d4510be536e'::uuid, 6283, 'cédula (mandó su teléfono)'),
  ('fc7cad5d-f743-459a-bedf-27b86da71120'::uuid, 5244, 'cédula (mandó su teléfono)'),
  ('ed54a2c1-feec-41b4-8a66-92f5f5c48079'::uuid, 4708, 'cédula (mandó su teléfono)'),
  ('640e6ac1-5641-42ff-9b50-1d4bc3846734'::uuid, 3563, 'cédula (mandó su teléfono)'),
  ('ead5da1d-89ef-42fe-924c-17c07954b1cd'::uuid, 519, 'cédula y nombre'),
  ('3c25bab5-b669-44d5-8a63-c28be3d0f979'::uuid, 8727, 'cédula'),
  ('90081417-d1db-4e89-bc4a-37f0463eb7e4'::uuid, 8723, 'cédula'),
  ('fe73c3a6-e964-4e3a-a91f-57245ad8feee'::uuid, 8481, 'cédula'),
  ('02e0e465-4b63-4a54-8167-dd46bbccdfb9'::uuid, 8439, 'cédula (quedó "319")'),
  ('6bf83715-4630-471e-bf6c-e004b4cb017d'::uuid, 8290, 'cédula'),
  ('cc3c600f-8045-4f1c-b4b1-e9b33ecbbb04'::uuid, 7918, 'cédula'),
  ('e960ea61-ae2e-4d86-bb5f-895dbbc47a84'::uuid, 7811, 'una orden con dos personas: a nombre de quién va'),
  ('c61f8760-0a48-473a-8f7d-1c5cf3b24a91'::uuid, 7616, 'cédula'),
  ('37707be6-583e-4e16-bcab-76b580a15fe1'::uuid, 7435, 'confirmar cédula 6208392 y nombre Rossana Gavilan Colman'),
  ('8ecf4ba8-b88f-4b65-aaf4-ccb31fb83410'::uuid, 6540, 'cédula'),
  ('4e881966-9fcd-4eae-b68c-acda69dde2fc'::uuid, 6492, 'cédula'),
  ('a52d9fa4-0da3-4222-8c0b-562789f4fe1e'::uuid, 5673, 'cédula'),
  ('d387e712-0da0-454d-8e3f-e430d4f48b8a'::uuid, 5439, 'cédula'),
  ('237695f9-a47e-405f-9d94-22d68f875b07'::uuid, 5375, 'cédula'),
  ('6ace7cdf-3aae-483b-8710-16d0d22043b1'::uuid, 4839, 'cédula (quiere otro nombre)'),
  ('89c4bb94-6dba-438d-a195-9fd86ff1c89b'::uuid, 3943, 'cédula (quiere otro nombre)'),
  ('f9d9b788-f773-46f0-939e-97c3bcd2bae3'::uuid, 4781, 'cédula'),
  ('84225f82-6173-41c6-b790-258266b172b8'::uuid, 4024, 'cédula'),
  ('75b51e79-bcc7-42f6-9337-56b95abe2f7a'::uuid, 3856, 'cédula'),
  ('6a7b4c63-744b-4944-b07e-de60358d6875'::uuid, 3790, 'cédula'),
  ('407e18c9-a13c-402a-9779-9ad9989dc075'::uuid, 3787, 'cédula (nombre: Ramón Nuñez)'),
  ('e78725f1-0358-44c3-8767-da3adfd1ca6a'::uuid, 3991, 'confirmar cédula 6519709'),
  ('84b2758a-f1bd-450b-90fa-e54cbcbefcb0'::uuid, 3940, 'confirmar cédula 6062975'),
  ('cab13ad4-f9e6-4efb-ab7d-13b055aecf55'::uuid, 3772, 'cédula'),
  ('9635f338-50d0-4d05-82aa-e6aa4034ff94'::uuid, 3312, 'cédula'),
  ('f8d98f5a-a5f0-49dc-b336-0a66d5fe1bce'::uuid, 2793, 'cédula'),
  ('0d9dcc61-e2fc-47f2-87a4-ebc940cefa0e'::uuid, 2633, 'cédula'),
  ('43a6295b-8b49-4b0e-8631-fff8bd83d6b4'::uuid, 2605, 'cédula'),
  ('b3b9dc55-474d-44c2-8f65-b39bb2e09113'::uuid, 2411, 'cédula'),
  ('cfb954e9-5f8b-4543-b314-9d7a124695a9'::uuid, 2025, 'una orden con dos personas: a nombre de quién va'),
  ('9a6449b0-360f-4858-b200-9c346e7b5bb7'::uuid, 1846, 'cédula (quedó "691")'),
  ('0acc2781-144e-496d-a1d2-244848e4d96c'::uuid, 1671, 'cédula'),
  ('e490fbb4-1631-4179-a95a-e171435fbbbf'::uuid, 266, 'cédula'),
  ('a2b58bdc-fbf4-4b95-abe5-79cf7c7d4b97'::uuid, 197, 'cédula'),
  ('68bf35fe-db03-46cc-bb2c-0288aeaf5932'::uuid, 157, 'cédula'),
  ('d5ebb2ea-fadc-45c1-aaa5-384e0a8fbb9d'::uuid, 5753, 'nombre (sólo quedó "Haedo")'),
  ('ded38b83-3eab-4808-8162-cf9980d85bb5'::uuid, 656, 'nombre (sólo quedó "Ramirez")'),
  ('3fd13570-229d-4587-92f2-740aa0dade0b'::uuid, 5703, 'nombre'),
  ('7c104eb0-c508-4fdb-b5c7-6db4b8320a82'::uuid, 5069, 'cédula y nombre (hay dos números)'),
  ('9e3d5205-b1a0-4615-a87e-b0dfbf70478d'::uuid, 3643, 'nombre (sólo "López")')
)
SELECT
  p.numero_orden,
  e.nombre_participante,
  e.whatsapp_numero,
  e.documento AS cedula_hoy,
  p.que_falta
FROM pedir p
JOIN elpapustore_erp.sorteo_entradas e ON e.id = p.entrada_id
ORDER BY p.numero_orden DESC;
