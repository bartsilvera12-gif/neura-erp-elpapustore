import { createClient } from "@supabase/supabase-js";
import { SUPABASE_APP_SCHEMA, type AppSupabaseClient } from "@/lib/supabase/schema";
import { isSingleClientMode, getSingleClientSchemaOrNull } from "@/lib/instance/single-client";
import { transientRetryFetch } from "@/lib/supabase/transient-retry-fetch";

/**
 * Cliente service role (servidor): webhooks, /r redirect, jobs.
 *
 * IMPORTANTE: el schema se resuelve EN CADA CALL (runtime), NO al import-time del módulo.
 * Si usáramos la constante `supabaseServiceRoleClientOptions` de schema.ts, esa fue evaluada
 * cuando el bundle se compiló, y si NEURA_INSTANCE_MODE no estaba marcada como buildtime en
 * Coolify, queda hardcoded `zentra_erp` — rompiendo single_client en self-hosted.
 */
export function createServiceRoleClient(): AppSupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) {
    throw new Error("Faltan NEXT_PUBLIC_SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY");
  }
  const schema = isSingleClientMode()
    ? (getSingleClientSchemaOrNull() ?? SUPABASE_APP_SCHEMA)
    : SUPABASE_APP_SCHEMA;
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    db: { schema },
    global: { fetch: transientRetryFetch },
  }) as AppSupabaseClient;
}
