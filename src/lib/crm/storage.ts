import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";
import { getBrowserSupabaseForEmpresaData } from "@/lib/supabase/browser-data-client";
import { createServiceRoleClientForEmpresa } from "@/lib/supabase/empresa-data-schema";
import { normalizeEtapaCodigo } from "@/lib/crm/etapas";
import { getCurrentUser } from "@/lib/auth";
import type { AppSupabaseClient } from "@/lib/supabase/schema";
import type { Prospecto, Nota } from "./types";
import { generarNumeroControlFromSupabase } from "@/lib/crm/numero-control";

async function browserDataClient() {
  return getBrowserSupabaseForEmpresaData();
}

// ─── Tipos de fila Supabase ───────────────────────────────────────────────────

interface ProspectoRow {
  id: string;
  empresa_id: string;
  numero_control: string;
  empresa: string;
  contacto: string;
  email: string | null;
  telefono: string | null;
  servicio: string;
  valor_estimado: number;
  etapa: string;
  proxima_accion: string | null;
  fecha_proxima_accion: string | null;
  creado_por: string | null;
  origen_creacion?: string | null;
  responsable: string | null;
  observaciones?: string | null;
  cliente_creado: boolean;
  fecha_creacion: string;
  fecha_actualizacion: string;
}

interface NotaRow {
  id: string;
  empresa_id: string;
  prospecto_id: string;
  texto: string;
  fecha: string;
}

// ─── Mapeo fila → tipo ────────────────────────────────────────────────────────

function rowToNota(row: NotaRow): Nota {
  return {
    id: row.id,
    texto: row.texto,
    fecha: row.fecha,
  };
}

function rowToProspecto(row: ProspectoRow, notas: Nota[]): Prospecto {
  return {
    id: row.id,
    numero_control: row.numero_control,
    empresa: row.empresa,
    contacto: row.contacto,
    email: row.email ?? undefined,
    telefono: row.telefono ?? undefined,
    servicio: row.servicio,
    valor_estimado: Number(row.valor_estimado),
    etapa: normalizeEtapaCodigo(row.etapa ?? ""),
    proxima_accion: row.proxima_accion ?? undefined,
    fecha_proxima_accion: row.fecha_proxima_accion ?? undefined,
    creado_por: row.creado_por ?? undefined,
    origen_creacion: (row.origen_creacion ?? "manual") as Prospecto["origen_creacion"],
    origen_detalle: (row as { origen_detalle?: string | null }).origen_detalle ?? null,
    responsable: row.responsable ?? undefined,
    observaciones: row.observaciones != null && String(row.observaciones).trim() !== "" ? String(row.observaciones) : null,
    notas,
    fecha_creacion: row.fecha_creacion,
    fecha_actualizacion: row.fecha_actualizacion,
    cliente_creado: row.cliente_creado,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// La numeración ahora se resuelve con `generarNumeroControlFromSupabase` para reutilizarla también desde webhooks.

// ─── Prospectos ────────────────────────────────────────────────────────────────

/** Lista prospectos vía API tenant (service role); evita RLS del browser en `erp_*`. */
export async function getProspectos(): Promise<Prospecto[]> {
  if (typeof window === "undefined") return [];
  try {
    const res = await fetchWithSupabaseSession("/api/crm/prospectos", { cache: "no-store" });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      console.error("[crm] getProspectos API:", res.status, t);
      return [];
    }
    const json = (await res.json()) as { success?: boolean; data?: Prospecto[] };
    if (!json.success || !Array.isArray(json.data)) return [];
    return json.data;
  } catch (e) {
    console.error("[crm] getProspectos:", e);
    return [];
  }
}

/** Prospectos + notas filtrados por empresa (p. ej. API con service role en schema tenant). */
export async function listProspectosForEmpresa(
  supabase: AppSupabaseClient,
  empresaId: string
): Promise<Prospecto[]> {
  const { data: prospectosData, error: errP } = await supabase
    .from("crm_prospectos")
    .select("*")
    .eq("empresa_id", empresaId)
    .order("fecha_creacion", { ascending: false });

  if (errP) {
    console.error("[crm] listProspectosForEmpresa:", errP.message);
    return [];
  }

  const prospectos = prospectosData as ProspectoRow[];
  if (prospectos.length === 0) return [];

  // Notas en lotes de ids, de a 6 en paralelo: con todos los prospectos en un solo `.in(...)` la
  // URL llegaba a 39 KB y el gateway la rechazaba (414), así que el CRM salía sin notas.
  const ids = prospectos.map((p) => p.id);
  const NOTAS_CHUNK = 100;
  const NOTAS_EN_PARALELO = 6;
  const idChunks: string[][] = [];
  for (let i = 0; i < ids.length; i += NOTAS_CHUNK) idChunks.push(ids.slice(i, i + NOTAS_CHUNK));
  const notasRows: NotaRow[] = [];
  for (let i = 0; i < idChunks.length; i += NOTAS_EN_PARALELO) {
    const notasResults = await Promise.all(
      idChunks.slice(i, i + NOTAS_EN_PARALELO).map((slice) =>
        supabase
          .from("crm_notas")
          .select("*")
          .eq("empresa_id", empresaId)
          .in("prospecto_id", slice)
          .order("fecha", { ascending: false })
      )
    );
    for (const { data: notasData, error: errN } of notasResults) {
      if (errN) {
        console.error("[crm] listProspectosForEmpresa (notas):", errN.message);
        continue;
      }
      notasRows.push(...((notasData as NotaRow[]) ?? []));
    }
  }
  const notasPorProspecto = notasRows.reduce<Record<string, Nota[]>>((acc, n) => {
    if (!acc[n.prospecto_id]) acc[n.prospecto_id] = [];
    acc[n.prospecto_id].unshift(rowToNota(n));
    return acc;
  }, {});

  return prospectos.map((p) => rowToProspecto(p, notasPorProspecto[p.id] ?? []));
}

/**
 * Obtiene un prospecto por ID en el tenant (service role / API).
 * Debe usarse en rutas server; filtra por empresa.
 */
export async function getProspectoForEmpresa(
  supabase: AppSupabaseClient,
  empresaId: string,
  prospectoId: string
): Promise<Prospecto | null> {
  const { data: pData, error: errP } = await supabase
    .from("crm_prospectos")
    .select("*")
    .eq("id", prospectoId)
    .eq("empresa_id", empresaId)
    .maybeSingle();

  if (errP) {
    console.error("[crm] getProspectoForEmpresa:", errP.message);
    return null;
  }
  if (!pData) return null;

  const { data: notasData, error: errN } = await supabase
    .from("crm_notas")
    .select("*")
    .eq("empresa_id", empresaId)
    .eq("prospecto_id", prospectoId)
    .order("fecha", { ascending: false });

  if (errN) {
    console.error("[crm] getProspectoForEmpresa (notas):", errN.message);
  }

  const notas = ((notasData as NotaRow[]) ?? []).map(rowToNota);
  return rowToProspecto(pData as ProspectoRow, notas);
}

/** Obtiene un prospecto por ID con sus notas (vía API tenant; mismo origen que el listado del funnel). */
export async function getProspecto(id: string): Promise<Prospecto | null> {
  if (typeof window === "undefined") return null;
  try {
    const res = await fetchWithSupabaseSession(`/api/crm/prospectos/${encodeURIComponent(id)}`, {
      cache: "no-store",
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      console.error("[crm] getProspecto API:", res.status, t);
      return null;
    }
    const json = (await res.json()) as { success?: boolean; data?: Prospecto };
    if (!json.success || !json.data) return null;
    return json.data;
  } catch (e) {
    console.error("[crm] getProspecto:", e);
    return null;
  }
}

export type NuevoProspectoData = Omit<
  Prospecto,
  "id" | "numero_control" | "notas" | "fecha_creacion" | "fecha_actualizacion"
>;

/** Crea prospecto vía API tenant (mismo mecanismo que el listado; evita RLS del browser en `erp_*`). */
export async function saveProspecto(
  datos: NuevoProspectoData
): Promise<Prospecto | null> {
  if (typeof window === "undefined") return null;
  const usuario = await getCurrentUser();
  if (!usuario?.empresa_id) throw new Error("Usuario no autenticado o sin empresa");

  try {
    const res = await fetchWithSupabaseSession("/api/crm/prospectos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        empresa: datos.empresa,
        contacto: datos.contacto,
        email: datos.email ?? null,
        telefono: datos.telefono ?? null,
        servicio: datos.servicio,
        valor_estimado: datos.valor_estimado ?? 0,
        etapa: datos.etapa ?? "LEAD",
        proxima_accion: datos.proxima_accion ?? null,
        fecha_proxima_accion: datos.fecha_proxima_accion ?? null,
        responsable: datos.responsable ?? null,
        observaciones: datos.observaciones?.trim() || null,
      }),
    });
    const json = (await res.json()) as { success?: boolean; data?: Prospecto; error?: string };
    if (!res.ok) {
      console.error("[crm] saveProspecto API:", res.status, json.error);
      return null;
    }
    if (!json.success || !json.data) return null;
    return json.data;
  } catch (e) {
    console.error("[crm] saveProspecto:", e);
    return null;
  }
}

/** Crea prospecto desde webhook (WhatsApp, n8n, etc.). Usa service role para bypass RLS. */
export async function saveProspectoFromWebhook(datos: {
  empresa_id: string;
  telefono: string;
  mensaje?: string;
  contacto?: string;
  empresa_nombre?: string;
  etapa?: string;
  origen_creacion?: Prospecto["origen_creacion"];
  origen_detalle?: string | null;
  servicio?: string;
  /** Etiqueta del canal (ej. nombre del canal en Conversaciones); por defecto "WhatsApp". */
  creado_por?: string | null;
  /** Asesor ya asignado a la conversación, si existe. */
  responsable?: string | null;
}): Promise<Prospecto | null> {
  const sb = await createServiceRoleClientForEmpresa(datos.empresa_id);

  const numeroControl = await generarNumeroControlFromSupabase(sb, datos.empresa_id);

  const contacto = datos.contacto?.trim() || "Contacto WhatsApp";
  const empresaNombre = datos.empresa_nombre?.trim() || "Sin nombre";

  const insert = {
    empresa_id: datos.empresa_id,
    numero_control: numeroControl,
    empresa: empresaNombre,
    contacto,
    email: null,
    telefono: datos.telefono.trim() || null,
    servicio: (datos.servicio?.trim() || "Consulta por WhatsApp"),
    valor_estimado: 0,
    etapa: datos.etapa?.trim() || "LEAD",
    proxima_accion: null,
    fecha_proxima_accion: null,
    creado_por: (datos.creado_por?.trim() || "WhatsApp") as string,
    origen_creacion: (datos.origen_creacion ?? "whatsapp") as string,
    origen_detalle: datos.origen_detalle ?? null,
    responsable: datos.responsable?.trim() ? datos.responsable.trim() : null,
    observaciones: null,
  };

  const { data: prospectoData, error: errP } = await sb
    .from("crm_prospectos")
    .insert([insert])
    .select()
    .single();

  if (errP) {
    console.error("[crm] saveProspectoFromWebhook:", errP.message);
    return null;
  }

  const prospecto = prospectoData as ProspectoRow;

  if (datos.mensaje?.trim()) {
    await sb.from("crm_notas").insert({
      empresa_id: datos.empresa_id,
      prospecto_id: prospecto.id,
      texto: datos.mensaje.trim(),
    });
  }

  return rowToProspecto(prospecto, []);
}

/** Actualiza prospecto vía API tenant (Postgres directo en schemas `erp_*` no expuestos). */
export async function updateProspecto(
  id: string,
  datos: Partial<Omit<Prospecto, "id" | "numero_control" | "notas" | "fecha_creacion">>
): Promise<Prospecto | null> {
  if (typeof window === "undefined") return null;

  const patch: Record<string, unknown> = {};
  if (datos.empresa !== undefined) patch.empresa = datos.empresa;
  if (datos.contacto !== undefined) patch.contacto = datos.contacto;
  if (datos.email !== undefined) patch.email = datos.email ?? null;
  if (datos.telefono !== undefined) patch.telefono = datos.telefono ?? null;
  if (datos.servicio !== undefined) patch.servicio = datos.servicio;
  if (datos.valor_estimado !== undefined) patch.valor_estimado = datos.valor_estimado;
  if (datos.etapa !== undefined) patch.etapa = datos.etapa;
  if (datos.proxima_accion !== undefined) patch.proxima_accion = datos.proxima_accion ?? null;
  if (datos.fecha_proxima_accion !== undefined) patch.fecha_proxima_accion = datos.fecha_proxima_accion ?? null;
  // creado_por no se actualiza: queda fijo con quien creó el lead
  if (datos.responsable !== undefined) patch.responsable = datos.responsable ?? null;
  if (datos.cliente_creado !== undefined) patch.cliente_creado = datos.cliente_creado;
  patch.fecha_actualizacion = new Date().toISOString();

  try {
    const res = await fetchWithSupabaseSession(`/api/crm/prospectos/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    const json = (await res.json()) as { success?: boolean; data?: Prospecto; error?: string };
    if (!res.ok) {
      console.error("[crm] updateProspecto API:", res.status, json.error);
      return null;
    }
    if (!json.success || !json.data) return null;
    return json.data;
  } catch (e) {
    console.error("[crm] updateProspecto:", e);
    return null;
  }
}

/** Cambia la etapa del prospecto. */
export async function moveProspecto(
  id: string,
  etapa: string
): Promise<void> {
  await updateProspecto(id, { etapa });
}

// ─── Notas ─────────────────────────────────────────────────────────────────────

/** Agrega una nota al prospecto (API tenant). */
export async function addNota(
  prospectoId: string,
  texto: string
): Promise<Nota | null> {
  if (typeof window === "undefined") return null;
  const usuario = await getCurrentUser();
  if (!usuario?.empresa_id) throw new Error("Usuario no autenticado o sin empresa");

  try {
    const res = await fetchWithSupabaseSession(
      `/api/crm/prospectos/${encodeURIComponent(prospectoId)}/notas`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ texto: texto.trim() }),
      }
    );
    const json = (await res.json()) as { success?: boolean; data?: Nota; error?: string };
    if (!res.ok) {
      console.error("[crm] addNota API:", res.status, json.error);
      return null;
    }
    if (!json.success || !json.data) return null;
    return json.data;
  } catch (e) {
    console.error("[crm] addNota:", e);
    return null;
  }
}

/** Elimina un prospecto (y sus notas por CASCADE), vía API tenant. */
export async function deleteProspecto(id: string): Promise<void> {
  if (typeof window === "undefined") return;
  try {
    const res = await fetchWithSupabaseSession(`/api/crm/prospectos/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      console.error("[crm] deleteProspecto API:", res.status, t);
    }
  } catch (e) {
    console.error("[crm] deleteProspecto:", e);
  }
}
