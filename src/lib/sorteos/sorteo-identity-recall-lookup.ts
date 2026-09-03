import "server-only";

import type { AppSupabaseClient } from "@/lib/supabase/schema";
import { paraguayPhoneMatchVariants } from "@/lib/chat/wa-phone";
import type { IdentityRecallCliente } from "@/lib/sorteos/sorteo-identity-recall";

const LOG = "[sorteo-identity-recall]" as const;

type ClienteRow = {
  id?: string | null;
  nombre?: string | null;
  nombre_contacto?: string | null;
  documento?: string | null;
  ciudad?: string | null;
  telefono?: string | null;
};

function norm(s: string | null | undefined): string {
  return (s ?? "").trim();
}

/**
 * Cliente ya registrado para ese teléfono, o `null` si es un comprador nuevo.
 *
 * Regla de negocio confirmada con el cliente: un teléfono = una persona. La base igual admite
 * dos filas con el mismo número (se crean por documento **o** por teléfono), así que ante empate
 * gana el registro más reciente en vez de uno arbitrario — el `LIMIT 1` sin orden de la RPC
 * elegía cualquiera.
 *
 * Solo devuelve el cliente si tiene nombre y cédula: sin eso el atajo no ahorra pasos y
 * mostraría campos vacíos al comprador.
 */
export async function fetchIdentityRecallCliente(
  supabase: AppSupabaseClient,
  empresaId: string,
  phone: string
): Promise<IdentityRecallCliente | null> {
  const variants = paraguayPhoneMatchVariants(phone);
  if (variants.length === 0) return null;

  const { data, error } = await supabase
    .from("clientes")
    .select("id, nombre, nombre_contacto, documento, ciudad, telefono")
    .eq("empresa_id", empresaId)
    .is("deleted_at", null)
    .in("telefono", variants)
    .order("created_at", { ascending: false })
    .limit(5);

  if (error) {
    /** No bloquea la compra: sin recall, el flujo sigue pidiendo los datos como siempre. */
    console.warn(LOG, "clientes_lookup_failed", { empresa_id: empresaId, message: error.message });
    return null;
  }

  for (const raw of (data ?? []) as ClienteRow[]) {
    const id = norm(raw.id);
    const nombreCompleto = norm(raw.nombre) || norm(raw.nombre_contacto);
    const cedula = norm(raw.documento);
    if (!id || !nombreCompleto || !cedula) continue;
    return {
      clienteId: id,
      nombreCompleto,
      cedula,
      ciudad: norm(raw.ciudad),
      telefono: norm(raw.telefono) || norm(phone),
    };
  }

  return null;
}
