import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";

/**
 * `/api/empresas/module-access` compartido entre AuthGuard y Sidebar.
 *
 * Antes cada uno lo pedía por su cuenta al abrir la app y además volvía a consultar el usuario
 * (`getCurrentUser`: auth + usuarios) para saber si era super_admin, cuando el servidor ya lo
 * resolvió en esta misma respuesta. Con la base en otra región eran ~2,5 s en fila en cada carga.
 * Un pedido en vuelo o reciente (TTL corto, por usuario) se reutiliza.
 */
export type ModuleAccessShared = {
  /** false si la API respondió error: los llamadores mantienen su camino de respaldo. */
  ok: boolean;
  superAdmin: boolean;
  slugs: string[];
  modulos: { id: string; nombre: string; slug: string }[];
};

const TTL_MS = 30_000;

let cache: { userId: string; at: number; promise: Promise<ModuleAccessShared> } | null = null;

export function fetchModuleAccessShared(userId: string, opts?: { force?: boolean }): Promise<ModuleAccessShared> {
  const now = Date.now();
  if (!opts?.force && cache && cache.userId === userId && now - cache.at < TTL_MS) {
    return cache.promise;
  }
  const promise = (async (): Promise<ModuleAccessShared> => {
    const res = await fetchWithSupabaseSession("/api/empresas/module-access", { cache: "no-store" });
    if (!res.ok) return { ok: false, superAdmin: false, slugs: [], modulos: [] };
    const body = (await res.json()) as {
      superAdmin?: boolean;
      slugs?: string[];
      modulos?: { id?: string; nombre?: string; slug?: string }[];
    };
    return {
      ok: true,
      superAdmin: !!body.superAdmin,
      slugs: Array.isArray(body.slugs) ? body.slugs : [],
      modulos: Array.isArray(body.modulos)
        ? body.modulos.map((m) => ({ id: m.id ?? "", nombre: m.nombre ?? "", slug: m.slug ?? "" }))
        : [],
    };
  })();
  const entry = { userId, at: now, promise };
  cache = entry;
  // Un error no queda guardado: el próximo pedido vuelve a intentar.
  promise.then(
    (r) => {
      if (!r.ok && cache === entry) cache = null;
    },
    () => {
      if (cache === entry) cache = null;
    }
  );
  return promise;
}
