import "server-only";

import { resolveApiAuthContext } from "@/lib/middleware/api-auth-context";
import { createServiceRoleClient } from "@/lib/supabase/service-admin";
import { resolveEffectiveModules } from "@/lib/modulos/resolve-effective-modules";
import { isModuleSlugGranted } from "@/lib/modulos/route-slug-map";

/**
 * Guard de módulo para rutas API.
 *
 * Hasta ahora las rutas del ERP validaban solo **pertenencia a la empresa**: cualquier usuario
 * logueado podía llamarlas, sin importar qué módulos tuviera asignados. El menú lateral se
 * recorta en el cliente, pero eso es cosmético — con la cookie de sesión se llega igual por HTTP.
 *
 * Este guard lleva al servidor la misma regla que ya decide el menú: `empresa_modulos` ∩
 * `usuario_modulos` (vía `resolveEffectiveModules`), respetando los alias de
 * `isModuleSlugGranted`. Así un usuario acotado al cupón manual no puede leer el resto.
 */
export type ModuleGuardOk = {
  ok: true;
  empresaId: string;
  rol: string | null;
  /** Slugs efectivos del usuario (sin expandir alias). */
  slugs: Set<string>;
  superAdmin: boolean;
};

export type ModuleGuardFail = { ok: false; status: number; message: string };

export type ModuleGuardResult = ModuleGuardOk | ModuleGuardFail;

/**
 * Exige que el usuario tenga **al menos uno** de los slugs pedidos.
 *
 * `super_admin` pasa siempre (mismo criterio que `resolveEffectiveModules` y el sidebar).
 * Los alias siguen valiendo: quien tiene `sorteos` pasa un requisito de `cupon_manual`, porque
 * el ítem de cupón manual vive dentro de ese módulo para los administradores.
 */
export async function requireAnyModuleSlug(
  request: Request | null | undefined,
  requiredSlugs: readonly string[]
): Promise<ModuleGuardResult> {
  const auth = await resolveApiAuthContext(request);
  if (!auth.ok) {
    return { ok: false, status: 401, message: "No autenticado" };
  }

  const { empresa_id, usuarioCatalogId, usuarioRol } = auth.ctx;
  const rol = (usuarioRol ?? "").trim();

  if (rol === "super_admin") {
    return {
      ok: true,
      empresaId: empresa_id ?? "",
      rol,
      slugs: new Set(requiredSlugs),
      superAdmin: true,
    };
  }

  if (!empresa_id) {
    return { ok: false, status: 401, message: "Usuario sin empresa asignada" };
  }
  if (!usuarioCatalogId) {
    return { ok: false, status: 401, message: "Usuario sin ficha en el catálogo" };
  }

  let slugs: Set<string>;
  try {
    const catalog = createServiceRoleClient();
    const modulos = await resolveEffectiveModules(catalog, {
      id: usuarioCatalogId,
      empresa_id,
      rol: usuarioRol ?? null,
    });
    slugs = new Set(modulos.map((m) => (m.slug ?? "").trim()).filter(Boolean));
  } catch (e) {
    /** Falla cerrada: sin poder resolver permisos no se otorga acceso. */
    console.error("[module-guard] resolveEffectiveModules:", e instanceof Error ? e.message : e);
    return { ok: false, status: 500, message: "No se pudieron resolver los permisos" };
  }

  const allowed = requiredSlugs.some((s) => isModuleSlugGranted(s, slugs));
  if (!allowed) {
    return {
      ok: false,
      status: 403,
      message: "No tenés acceso a esta sección.",
    };
  }

  return { ok: true, empresaId: empresa_id, rol: usuarioRol ?? null, slugs, superAdmin: false };
}
