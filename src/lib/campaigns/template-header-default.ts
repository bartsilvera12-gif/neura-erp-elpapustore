import "server-only";
import { randomUUID } from "node:crypto";
import { createServiceRoleClient } from "@/lib/supabase/service-admin";

/**
 * Archivo de encabezado (foto/video/PDF) "por defecto" de una plantilla de Meta.
 *
 * Meta solo guarda una muestra para revisar la plantilla; al enviar hay que mandar una URL pública.
 * Guardamos el archivo en el storage del ERP con un nombre fijo por plantilla para que las campañas
 * lo usen solas si el Excel no trae header_image_url. Sin tabla nueva: el path es la clave.
 */
const BUCKET = "chat-media";

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "video/mp4": "mp4",
  "application/pdf": "pdf",
};

function tmpPrefix(empresaId: string): string {
  return `${empresaId}/template-headers/tmp/`;
}

function defaultFolder(empresaId: string, channelId: string): string {
  return `${empresaId}/template-headers/${channelId}`;
}

function defaultBaseName(name: string, language: string): string {
  return `${name}__${language}`.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export async function saveTmpTemplateHeaderFile(params: {
  empresaId: string;
  bytes: Uint8Array;
  mime: string;
}): Promise<string | null> {
  const ext = EXT_BY_MIME[params.mime];
  if (!ext) return null;
  const path = `${tmpPrefix(params.empresaId)}${Date.now()}-${randomUUID()}.${ext}`;
  const sb = createServiceRoleClient();
  const { error } = await sb.storage.from(BUCKET).upload(path, params.bytes, { contentType: params.mime, upsert: true });
  if (error) {
    console.warn("[template-header-default] tmp upload failed", error.message);
    return null;
  }
  return path;
}

export function isOwnTmpTemplateHeaderPath(empresaId: string, path: string): boolean {
  return path.startsWith(tmpPrefix(empresaId)) && !path.includes("..");
}

/** Deja el archivo como predeterminado de la plantilla (reemplaza el anterior) y devuelve su URL pública. */
export async function promoteTemplateHeaderFile(params: {
  empresaId: string;
  channelId: string;
  name: string;
  language: string;
  tmpPath: string;
}): Promise<string | null> {
  if (!isOwnTmpTemplateHeaderPath(params.empresaId, params.tmpPath)) return null;
  const ext = params.tmpPath.split(".").pop() ?? "";
  const folder = defaultFolder(params.empresaId, params.channelId);
  const base = defaultBaseName(params.name, params.language);
  const target = `${folder}/${base}.${ext}`;
  const sb = createServiceRoleClient();
  const store = sb.storage.from(BUCKET);

  const { data: existing } = await store.list(folder, { search: base });
  const stale = (existing ?? []).filter((f) => f.name.startsWith(`${base}.`)).map((f) => `${folder}/${f.name}`);
  if (stale.length) await store.remove(stale);

  const { error } = await store.move(params.tmpPath, target);
  if (error) {
    console.warn("[template-header-default] promote failed", error.message);
    return null;
  }
  return store.getPublicUrl(target).data.publicUrl;
}

/** Mapa "nombre__idioma" → URL pública, para mostrar en el listado qué plantillas ya tienen archivo. */
export async function listTemplateHeaderDefaults(params: {
  empresaId: string;
  channelId: string;
}): Promise<Record<string, string>> {
  const folder = defaultFolder(params.empresaId, params.channelId);
  const store = createServiceRoleClient().storage.from(BUCKET);
  const { data, error } = await store.list(folder, { limit: 1000 });
  if (error) return {};
  const out: Record<string, string> = {};
  for (const f of data ?? []) {
    const dot = f.name.lastIndexOf(".");
    if (dot <= 0) continue;
    out[f.name.slice(0, dot)] = store.getPublicUrl(`${folder}/${f.name}`).data.publicUrl;
  }
  return out;
}

export function templateHeaderDefaultKey(name: string, language: string): string {
  return defaultBaseName(name, language);
}

export async function findTemplateHeaderDefaultUrl(params: {
  empresaId: string;
  channelId: string;
  name: string;
  language: string;
}): Promise<string | null> {
  if (!params.channelId || !params.name) return null;
  const folder = defaultFolder(params.empresaId, params.channelId);
  const base = defaultBaseName(params.name, params.language || "es");
  const store = createServiceRoleClient().storage.from(BUCKET);
  const { data, error } = await store.list(folder, { search: base });
  if (error) return null;
  const file = (data ?? []).find((f) => f.name.startsWith(`${base}.`));
  return file ? store.getPublicUrl(`${folder}/${file.name}`).data.publicUrl : null;
}
