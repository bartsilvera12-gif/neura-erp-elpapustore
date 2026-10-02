import type { AppSupabaseClient } from "@/lib/supabase/schema";
import { createServiceRoleClient } from "@/lib/supabase/service-admin";
import { createServiceRoleClientForEmpresa } from "@/lib/supabase/empresa-data-schema";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { isParticipanteBloqueado } from "@/lib/sorteos/participante-bloqueo";
import type {
  CreateRaffleEntryPayload,
  CreateRaffleEntryResponse,
} from "@/lib/sorteos/types";

function payloadToJsonb(p: CreateRaffleEntryPayload): Record<string, unknown> {
  return {
    empresa_id: p.empresa_id,
    sorteo_id: p.sorteo_id,
    whatsapp_numero: p.whatsapp_numero,
    nombre_completo: p.nombre_completo,
    cedula: p.cedula,
    celular: p.celular,
    ciudad: p.ciudad,
    cantidad_boletos: p.cantidad_boletos,
    fecha_pago: p.fecha_pago,
    monto_pago: p.monto_pago,
    banco_origen: p.banco_origen,
    comprobante_url: p.comprobante_url,
    ultimo_mensaje: p.ultimo_mensaje,
  };
}

/**
 * Verifica que la empresa tenga el módulo "sorteos" activo en empresa_modulos.
 * Usa cliente con permisos de servicio (bypass RLS).
 */
export async function empresaTieneModuloSorteos(
  supabaseAdmin: AppSupabaseClient,
  empresaId: string
): Promise<boolean> {
  const { data: modulo, error: e1 } = await supabaseAdmin
    .from("modulos")
    .select("id")
    .eq("slug", "sorteos")
    .maybeSingle();

  if (e1 || !modulo?.id) return false;

  const { data: em, error: e2 } = await supabaseAdmin
    .from("empresa_modulos")
    .select("id")
    .eq("empresa_id", empresaId)
    .eq("modulo_id", modulo.id)
    .eq("activo", true)
    .maybeSingle();

  return !e2 && !!em;
}

/**
 * Registro atómico de compra vía RPC sorteos_registrar_compra_n8n (SECURITY DEFINER).
 */
export async function registrarCompraSorteoN8n(
  payload: CreateRaffleEntryPayload
): Promise<CreateRaffleEntryResponse> {
  const catalog = createServiceRoleClient();
  const tiene = await empresaTieneModuloSorteos(catalog, payload.empresa_id);
  if (!tiene) {
    return {
      ok: false,
      message: "La empresa no tiene el módulo Sorteos habilitado",
    };
  }

  // Candado de bloqueo: un participante bloqueado no puede comprar por ninguna vía.
  const dataSchema = await fetchDataSchemaForEmpresaId(payload.empresa_id);
  if (await isParticipanteBloqueado(payload.empresa_id, dataSchema, payload.whatsapp_numero)) {
    return {
      ok: false,
      message: "Este participante está bloqueado y no puede realizar compras.",
    };
  }

  const tenant = await createServiceRoleClientForEmpresa(payload.empresa_id);
  const { data, error } = await tenant.rpc("sorteos_registrar_compra_n8n", {
    p: payloadToJsonb(payload),
  });

  if (error) {
    return {
      ok: false,
      message: error.message || "Error al registrar la compra",
      detalle: error.code,
    };
  }

  const row = data as Record<string, unknown> | null;
  if (!row || typeof row.ok !== "boolean") {
    return {
      ok: false,
      message: "Respuesta inválida del servidor",
    };
  }

  if (!row.ok) {
    return {
      ok: false,
      message: typeof row.message === "string" ? row.message : "Error en registro",
    };
  }

  return row as unknown as CreateRaffleEntryResponse;
}
