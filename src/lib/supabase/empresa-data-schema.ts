import { createClient } from "@supabase/supabase-js";
import {
  SUPABASE_APP_SCHEMA,
  resolveEmpresaDataSchema,
  type AppSupabaseClient,
} from "@/lib/supabase/schema";
import { createServiceRoleClient } from "@/lib/supabase/service-admin";
import { getSingleClientSchemaOrNull, isSingleClientMode } from "@/lib/instance/single-client";
import { transientRetryFetch } from "@/lib/supabase/transient-retry-fetch";

/**
 * Lee el schema operativo de la empresa.
 *
 * - Modo single_client: schema FIJO de `process.env.NEURA_CLIENT_SCHEMA`, sin tocar zentra_erp.
 * - Modo multi_tenant (legado): `empresas.data_schema` en zentra_erp; fallback a SUPABASE_APP_SCHEMA.
 *
 * En single_client NUNCA caemos a `zentra_erp` para datos operativos: zentra_erp deja de ser
 * un schema válido de runtime y debe usarse únicamente como catálogo de bootstrap (empresas,
 * usuarios, modulos) cargado vía seed/dump al provisionar la instancia dedicada.
 */
export async function fetchDataSchemaForEmpresaId(empresaId: string): Promise<string> {
  const singleClientSchema = getSingleClientSchemaOrNull();
  if (singleClientSchema) {
    return singleClientSchema;
  }

  const catalog = createServiceRoleClient();
  const { data, error } = await catalog
    .from("empresas")
    .select("data_schema")
    .eq("id", empresaId)
    .maybeSingle();

  if (error) {
    console.error("[empresa-data-schema] fetch:", error.message);
    return SUPABASE_APP_SCHEMA;
  }

  return resolveEmpresaDataSchema((data as { data_schema?: string | null } | null)?.data_schema);
}

/** Service role apuntando al esquema de datos operativos de la empresa (chat/omnicanal). */
export function createServiceRoleClientWithDbSchema(schema: string): AppSupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) {
    throw new Error("Faltan NEXT_PUBLIC_SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY");
  }
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    db: { schema },
    global: { fetch: transientRetryFetch },
  }) as AppSupabaseClient;
}

/**
 * Resuelve cliente service role para una empresa.
 *
 * En single_client el client siempre apunta a NEURA_CLIENT_SCHEMA — no aceptamos caer a
 * zentra_erp para datos operativos aunque el empresaId no resuelva, porque eso ocultaría
 * bugs de configuración con un client sobre el catálogo.
 */
export async function createServiceRoleClientForEmpresa(empresaId: string): Promise<AppSupabaseClient> {
  if (isSingleClientMode()) {
    const schema = getSingleClientSchemaOrNull();
    if (!schema) {
      throw new Error("[empresa-data-schema] single_client sin NEURA_CLIENT_SCHEMA");
    }
    return createServiceRoleClientWithDbSchema(schema);
  }

  const schema = await fetchDataSchemaForEmpresaId(empresaId);
  if (schema === SUPABASE_APP_SCHEMA) {
    return createServiceRoleClient();
  }
  return createServiceRoleClientWithDbSchema(schema);
}
