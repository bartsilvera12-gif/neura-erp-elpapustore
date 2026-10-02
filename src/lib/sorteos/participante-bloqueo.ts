import "server-only";

import {
  getChatPostgresPool,
  quoteSchemaTable,
} from "@/lib/supabase/chat-pg-pool";
import { assertAllowedChatDataSchema } from "@/lib/supabase/chat-data-schema";
import { getChatServiceClientForEmpresa } from "@/lib/supabase/chat-service-role-empresa";
import { getEmpresaIdForCurrentUserServer } from "@/lib/supabase/empresa-data-server";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import {
  normalizeWaPhone,
  paraguayNationalSignificantDigits,
  paraguayPhoneMatchVariants,
} from "@/lib/chat/wa-phone";

const BLOQUEADOS_TABLE = "sorteo_participantes_bloqueados";

/**
 * ¿Está bloqueado este número para comprar? Compara por las variantes del número
 * (local / nacional / internacional), así un bloqueo vale sin importar el formato guardado.
 *
 * Falla ABIERTO: si la tabla todavía no existe (migración sin aplicar) o hay un error,
 * devuelve `false` y loguea — nunca frena una venta legítima por un problema de infraestructura.
 */
export async function isParticipanteBloqueado(
  empresaId: string,
  dataSchema: string,
  whatsappNumero: string
): Promise<boolean> {
  const variants = paraguayPhoneMatchVariants(whatsappNumero);
  if (variants.length === 0) return false;

  try {
    const pool = getChatPostgresPool();
    if (pool) {
      const sch = assertAllowedChatDataSchema(dataSchema);
      const t = quoteSchemaTable(sch, BLOQUEADOS_TABLE);
      const res = await pool.query(
        `SELECT 1 FROM ${t} WHERE empresa_id = $1::uuid AND whatsapp_numero = ANY($2::text[]) LIMIT 1`,
        [empresaId, variants]
      );
      return (res.rowCount ?? 0) > 0;
    }
    const sb = await getChatServiceClientForEmpresa(empresaId);
    const { data } = await sb
      .from(BLOQUEADOS_TABLE)
      .select("id")
      .eq("empresa_id", empresaId)
      .in("whatsapp_numero", variants)
      .limit(1);
    return Array.isArray(data) && data.length > 0;
  } catch (e) {
    console.warn("[sorteos][bloqueo] check_fail_open", {
      empresa_id: empresaId,
      schema: dataSchema,
      error: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
}

export type BloqueoMutationResult = { ok: boolean; error?: string };

/**
 * Bloquea un número (upsert idempotente). No borra nada del historial.
 * `bloqueadoPor` es para auditoría (email del operador).
 */
export async function bloquearParticipante(input: {
  empresaId: string;
  dataSchema: string;
  whatsappNumero: string;
  motivo?: string | null;
  bloqueadoPor?: string | null;
}): Promise<BloqueoMutationResult> {
  const phone = normalizeWaPhone(input.whatsappNumero);
  if (!phone) return { ok: false, error: "Número de WhatsApp inválido." };
  const motivo = (input.motivo ?? "").trim().slice(0, 500) || null;
  const por = (input.bloqueadoPor ?? "").trim() || null;

  try {
    const pool = getChatPostgresPool();
    if (pool) {
      const sch = assertAllowedChatDataSchema(input.dataSchema);
      const t = quoteSchemaTable(sch, BLOQUEADOS_TABLE);
      await pool.query(
        `INSERT INTO ${t} (empresa_id, whatsapp_numero, motivo, bloqueado_por)
         VALUES ($1::uuid, $2::text, $3::text, $4::text)
         ON CONFLICT (empresa_id, whatsapp_numero)
         DO UPDATE SET motivo = EXCLUDED.motivo,
                       bloqueado_por = EXCLUDED.bloqueado_por,
                       bloqueado_at = now()`,
        [input.empresaId, phone, motivo, por]
      );
      return { ok: true };
    }
    const sb = await getChatServiceClientForEmpresa(input.empresaId);
    const { error } = await sb
      .from(BLOQUEADOS_TABLE)
      .upsert(
        {
          empresa_id: input.empresaId,
          whatsapp_numero: phone,
          motivo,
          bloqueado_por: por,
          bloqueado_at: new Date().toISOString(),
        },
        { onConflict: "empresa_id,whatsapp_numero" }
      );
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const faltaMigracion = /sorteo_participantes_bloqueados|relation|does not exist/i.test(msg);
    return {
      ok: false,
      error: faltaMigracion
        ? "Falta aplicar la migración 20261002120000_sorteo_participantes_bloqueados en este schema."
        : msg,
    };
  }
}

/** Desbloquea un número: borra todas las variantes (local/nacional/internacional) por las dudas. */
export async function desbloquearParticipante(input: {
  empresaId: string;
  dataSchema: string;
  whatsappNumero: string;
}): Promise<BloqueoMutationResult> {
  const variants = paraguayPhoneMatchVariants(input.whatsappNumero);
  if (variants.length === 0) return { ok: false, error: "Número de WhatsApp inválido." };

  try {
    const pool = getChatPostgresPool();
    if (pool) {
      const sch = assertAllowedChatDataSchema(input.dataSchema);
      const t = quoteSchemaTable(sch, BLOQUEADOS_TABLE);
      await pool.query(
        `DELETE FROM ${t} WHERE empresa_id = $1::uuid AND whatsapp_numero = ANY($2::text[])`,
        [input.empresaId, variants]
      );
      return { ok: true };
    }
    const sb = await getChatServiceClientForEmpresa(input.empresaId);
    const { error } = await sb
      .from(BLOQUEADOS_TABLE)
      .delete()
      .eq("empresa_id", input.empresaId)
      .in("whatsapp_numero", variants);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Dígitos nacionales significativos de todos los bloqueados de la empresa.
 * Sirve para marcar filas en el Ranking sin una consulta por fila.
 */
export async function fetchBloqueadosNationalDigits(
  empresaId: string,
  dataSchema: string
): Promise<string[]> {
  try {
    let numeros: string[] = [];
    const pool = getChatPostgresPool();
    if (pool) {
      const sch = assertAllowedChatDataSchema(dataSchema);
      const t = quoteSchemaTable(sch, BLOQUEADOS_TABLE);
      const res = await pool.query(
        `SELECT whatsapp_numero FROM ${t} WHERE empresa_id = $1::uuid`,
        [empresaId]
      );
      numeros = (res.rows ?? []).map((r) => String((r as { whatsapp_numero?: unknown }).whatsapp_numero ?? ""));
    } else {
      const sb = await getChatServiceClientForEmpresa(empresaId);
      const { data } = await sb
        .from(BLOQUEADOS_TABLE)
        .select("whatsapp_numero")
        .eq("empresa_id", empresaId);
      numeros = ((data ?? []) as { whatsapp_numero?: string }[]).map((r) => String(r.whatsapp_numero ?? ""));
    }
    return [...new Set(numeros.map((n) => paraguayNationalSignificantDigits(n)).filter(Boolean))];
  } catch (e) {
    console.warn("[sorteos][bloqueo] list_fail", {
      empresa_id: empresaId,
      schema: dataSchema,
      error: e instanceof Error ? e.message : String(e),
    });
    return [];
  }
}

// --- Wrappers que resuelven empresa/schema desde la sesión (para API y páginas) ---

async function resolveEmpresaSchema(): Promise<{ empresaId: string; dataSchema: string } | null> {
  const empresaId = await getEmpresaIdForCurrentUserServer();
  if (!empresaId) return null;
  const dataSchema = await fetchDataSchemaForEmpresaId(empresaId);
  return { empresaId, dataSchema };
}

export async function bloquearParticipanteCurrentEmpresa(input: {
  whatsappNumero: string;
  motivo?: string | null;
  bloqueadoPor?: string | null;
}): Promise<BloqueoMutationResult> {
  const ctx = await resolveEmpresaSchema();
  if (!ctx) return { ok: false, error: "Sin sesión o empresa." };
  return bloquearParticipante({ ...input, empresaId: ctx.empresaId, dataSchema: ctx.dataSchema });
}

export async function desbloquearParticipanteCurrentEmpresa(input: {
  whatsappNumero: string;
}): Promise<BloqueoMutationResult> {
  const ctx = await resolveEmpresaSchema();
  if (!ctx) return { ok: false, error: "Sin sesión o empresa." };
  return desbloquearParticipante({ whatsappNumero: input.whatsappNumero, empresaId: ctx.empresaId, dataSchema: ctx.dataSchema });
}

export async function fetchBloqueadosNationalDigitsCurrentEmpresa(): Promise<string[]> {
  const ctx = await resolveEmpresaSchema();
  if (!ctx) return [];
  return fetchBloqueadosNationalDigits(ctx.empresaId, ctx.dataSchema);
}
