/**
 * Asocia pathname del App Router a slug de `modulos.slug`.
 * `null` = no aplica gate de módulo (acceso con sesión).
 */

/** Orden del menú lateral (misma idea que Sidebar): primera entrada accesible = “home” sin dashboard. */
const SIDEBAR_SLUG_HREF_ORDER: { slug: string; href: string }[] = [
  { slug: "dashboard", href: "/" },
  { slug: "conversaciones", href: "/dashboard/conversaciones" },
  { slug: "historial-omnicanal", href: "/dashboard/historial-omnicanal" },
  { slug: "conversaciones-finalizadas", href: "/dashboard/conversaciones-finalizadas" },
  { slug: "monitoreo", href: "/dashboard/monitoreo" },
  { slug: "ventas", href: "/ventas" },
  { slug: "inventario", href: "/inventario" },
  { slug: "clientes", href: "/clientes" },
  { slug: "compras", href: "/compras" },
  { slug: "gastos", href: "/gastos" },
  { slug: "pagos", href: "/pagos" },
  { slug: "comisiones", href: "/comisiones" },
  { slug: "notas_credito", href: "/notas-credito" },
  { slug: "usuarios", href: "/usuarios" },
  { slug: "configuracion", href: "/configuracion" },
  { slug: "planes", href: "/planes" },
  { slug: "gestion-clientes", href: "/gestion-clientes" },
  { slug: "crm", href: "/crm" },
  { slug: "marketing", href: "/marketing" },
  { slug: "marketing_ops", href: "/dashboard/marketing-ops" },
  { slug: "sorteos", href: "/sorteos" },
  { slug: "campanas", href: "/dashboard/campanas" },
  { slug: "proyectos", href: "/dashboard/proyectos" },
  { slug: "etiquetas", href: "/dashboard/etiquetas" },
];

const OMNICANAL_DASHBOARD_SLUGS = [
  "conversaciones",
  "historial-omnicanal",
  "conversaciones-finalizadas",
  "monitoreo",
] as const;

function isOmnicanalDashboardSlug(slug: string): boolean {
  return (OMNICANAL_DASHBOARD_SLUGS as readonly string[]).includes(slug);
}

/** Slugs otorgados explícitamente o por alias (p. ej. `clientes` incluye gestión de cartera). */
export function isModuleSlugGranted(routeSlug: string, grantedSlugs: Set<string>): boolean {
  if (grantedSlugs.has(routeSlug)) return true;
  // Paquete legacy: un solo permiso para todo el stack dashboard omnicanal.
  if (grantedSlugs.has("omnicanal") && isOmnicanalDashboardSlug(routeSlug)) return true;
  // Compatibilidad: quien solo tiene "conversaciones" sigue entrando a historial / finalizadas / monitoreo.
  if (
    grantedSlugs.has("conversaciones") &&
    routeSlug !== "conversaciones" &&
    isOmnicanalDashboardSlug(routeSlug)
  ) {
    return true;
  }
  if (routeSlug === "gestion-clientes" && grantedSlugs.has("clientes")) return true;
  if (routeSlug === "notas_credito" && grantedSlugs.has("ventas")) return true;
  /** Ítem de sidebar "Cupón manual": mismo permiso que Sorteos (la ruta vive en /sorteos/cupon-manual). */
  if (routeSlug === "cupon_manual" && grantedSlugs.has("sorteos")) return true;
  return false;
}

/**
 * Acceso a un ítem del menú (super admin ve todo; resto según empresa_modulos ∩ usuario_modulos).
 */
export function canAccessSidebarSlug(
  slug: string,
  grantedSlugs: Set<string>,
  esSuperAdmin: boolean
): boolean {
  if (esSuperAdmin) return true;
  if (slug === "dashboard") return grantedSlugs.has("dashboard");
  return isModuleSlugGranted(slug, grantedSlugs);
}

/** Primera ruta de app a la que puede entrar el usuario (p. ej. tras login en `/` sin módulo dashboard). */
export function firstAccessibleHref(
  grantedSlugs: Set<string>,
  opts?: { superAdmin?: boolean }
): string {
  if (opts?.superAdmin) return "/";
  for (const { slug, href } of SIDEBAR_SLUG_HREF_ORDER) {
    if (canAccessSidebarSlug(slug, grantedSlugs, false)) return href;
  }
  return "/login";
}

export function pathRequiresModuleSlug(pathname: string): string | null {
  const p = pathname.split("?")[0] ?? pathname;
  if (!p) return null;
  if (p === "/") return "dashboard";
  if (p.startsWith("/login")) return null;
  if (p.startsWith("/admin")) return null;
  if (p.startsWith("/api")) return null;
  if (p.startsWith("/usuarios")) return "usuarios";

  if (p.startsWith("/dashboard")) {
    if (p.startsWith("/dashboard/marketing-ops")) return "marketing_ops";
    if (p.startsWith("/dashboard/proyectos")) return "proyectos";
    if (p.startsWith("/dashboard/conversaciones-finalizadas")) return "conversaciones-finalizadas";
    if (p.startsWith("/dashboard/historial-omnicanal")) return "historial-omnicanal";
    if (p.startsWith("/dashboard/monitoreo")) return "monitoreo";
    if (p.startsWith("/dashboard/sorteos")) return "sorteos";
    if (p.startsWith("/dashboard/campanas")) return "campanas";
    if (p.startsWith("/dashboard/etiquetas") || p.startsWith("/dashboard/etiquetas-preview")) return "etiquetas";
    if (p.startsWith("/dashboard/conversaciones")) return "conversaciones";
    return "conversaciones";
  }
  if (p.startsWith("/notas-credito")) return "notas_credito";
  if (p.startsWith("/ventas")) return "ventas";
  if (p.startsWith("/inventario")) return "inventario";
  if (p.startsWith("/clientes")) return "clientes";
  if (p.startsWith("/proveedores")) return "compras";
  if (p.startsWith("/compras")) return "compras";
  if (p.startsWith("/gastos")) return "gastos";
  if (p.startsWith("/pagos")) return "pagos";
  if (p.startsWith("/comisiones")) return "comisiones";
  if (p.startsWith("/configuracion")) return "configuracion";
  if (p.startsWith("/planes")) return "planes";
  if (p.startsWith("/gestion-clientes")) return "gestion-clientes";
  if (p.startsWith("/crm")) return "crm";
  if (p.startsWith("/marketing")) return "marketing";
  if (p.startsWith("/sorteos")) return "sorteos";
  return null;
}
