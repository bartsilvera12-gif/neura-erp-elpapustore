-- PASO 0 — YA VERIFICADO (2026-09-03): `modulos` = id, created_at (con default) + nombre,
-- descripcion, slug (nullable). El INSERT de abajo cubre todo lo necesario.
--   SELECT column_name, is_nullable, column_default
--   FROM information_schema.columns
--   WHERE table_schema = 'elpapustore_erp' AND table_name = 'modulos'
--   ORDER BY ordinal_position;

-- =============================================================================
-- Operador de cupón manual: usuario acotado a UNA sola vista.
--
-- Qué hace:
--   1. Crea el módulo `cupon_manual` en el catálogo (si no existe) y lo habilita para la empresa.
--   2. Crea/vincula la ficha del usuario en `usuarios` a partir de su UUID de Supabase Auth.
--   3. Le otorga ÚNICAMENTE el módulo `cupon_manual`.
--
-- Antes de correrlo: crear el usuario en Supabase → Authentication → Add user,
-- y copiar de ahí el UUID y el email.
--
-- Idempotente: se puede correr varias veces. Al final imprime lo que quedó, para verificar.
-- =============================================================================

DO $$
DECLARE
  -------------------------------------------------- Valores del usuario ya creado en Supabase Auth
  v_schema      text := 'elpapustore_erp';
  v_auth_uuid   uuid := '58a148dc-e0cf-47cc-b31e-4bf5b4dde1ee';
  v_email       text := 'elpapustore@usuario.com';
  v_nombre      text := 'Operador Cupón Manual';
  ----------------------------------------------------------------------------------------------

  v_empresa_id  uuid;
  v_modulo_id   uuid;
  v_usuario_id  uuid;
BEGIN
  -- Empresa del tenant. En una instancia dedicada hay una sola.
  EXECUTE format('SELECT id FROM %I.empresas ORDER BY created_at LIMIT 1', v_schema)
    INTO v_empresa_id;
  IF v_empresa_id IS NULL THEN
    RAISE EXCEPTION 'No se encontró ninguna empresa en el schema %', v_schema;
  END IF;

  -- 1) Módulo en el catálogo -------------------------------------------------
  EXECUTE format('SELECT id FROM %I.modulos WHERE slug = $1', v_schema)
    INTO v_modulo_id USING 'cupon_manual';

  IF v_modulo_id IS NULL THEN
    EXECUTE format(
      'INSERT INTO %I.modulos (nombre, slug, descripcion) VALUES ($1, $2, $3) RETURNING id', v_schema
    ) INTO v_modulo_id
      USING 'Cupón manual', 'cupon_manual', 'Carga de ventas presenciales (efectivo) sin acceso al resto de Sorteos';
    RAISE NOTICE 'Módulo cupon_manual creado: %', v_modulo_id;
  ELSE
    RAISE NOTICE 'Módulo cupon_manual ya existía: %', v_modulo_id;
  END IF;

  -- 2) Habilitarlo para la empresa -------------------------------------------
  -- Sin ON CONFLICT: `empresa_modulos` y `modulos` no están en las migraciones del repo
  -- (se crearon a mano en Supabase), así que no se puede asumir qué constraints únicos tienen.
  EXECUTE format(
    'UPDATE %I.empresa_modulos SET activo = true WHERE empresa_id = $1 AND modulo_id = $2', v_schema
  ) USING v_empresa_id, v_modulo_id;
  EXECUTE format(
    'INSERT INTO %I.empresa_modulos (empresa_id, modulo_id, activo)
     SELECT $1, $2, true
     WHERE NOT EXISTS (
       SELECT 1 FROM %I.empresa_modulos WHERE empresa_id = $1 AND modulo_id = $2
     )', v_schema, v_schema
  ) USING v_empresa_id, v_modulo_id;

  -- 3) Ficha del usuario ------------------------------------------------------
  EXECUTE format('SELECT id FROM %I.usuarios WHERE lower(email) = lower($1)', v_schema)
    INTO v_usuario_id USING v_email;

  IF v_usuario_id IS NULL THEN
    EXECUTE format(
      'INSERT INTO %I.usuarios (empresa_id, email, nombre, rol, auth_user_id, estado)
       VALUES ($1, lower($2), $3, $4, $5, $6) RETURNING id', v_schema
    ) INTO v_usuario_id
      USING v_empresa_id, v_email, v_nombre, 'usuario', v_auth_uuid, 'activo';
    RAISE NOTICE 'Usuario creado: %', v_usuario_id;
  ELSE
    EXECUTE format(
      'UPDATE %I.usuarios
          SET empresa_id = $1, nombre = $2, rol = $3, auth_user_id = $4, estado = $5
        WHERE id = $6', v_schema
    ) USING v_empresa_id, v_nombre, 'usuario', v_auth_uuid, 'activo', v_usuario_id;
    RAISE NOTICE 'Usuario ya existía, actualizado: %', v_usuario_id;
  END IF;

  -- 4) Permisos: SOLO cupón manual --------------------------------------------
  -- El borrado previo es intencional: si el usuario tenía otros módulos, se los quitamos.
  EXECUTE format('DELETE FROM %I.usuario_modulos WHERE usuario_id = $1', v_schema)
    USING v_usuario_id;
  EXECUTE format(
    'INSERT INTO %I.usuario_modulos (usuario_id, modulo_id)
     SELECT $1, $2
     WHERE NOT EXISTS (
       SELECT 1 FROM %I.usuario_modulos WHERE usuario_id = $1 AND modulo_id = $2
     )', v_schema, v_schema
  ) USING v_usuario_id, v_modulo_id;

  RAISE NOTICE 'Listo. usuario=% empresa=% modulo=%', v_usuario_id, v_empresa_id, v_modulo_id;
END $$;

-- Verificación: debe devolver exactamente UNA fila, con slug = cupon_manual.
SELECT u.email, u.rol, u.estado, m.slug AS modulo
FROM elpapustore_erp.usuarios u
JOIN elpapustore_erp.usuario_modulos um ON um.usuario_id = u.id
JOIN elpapustore_erp.modulos m ON m.id = um.modulo_id
WHERE lower(u.email) = lower('elpapustore@usuario.com');
