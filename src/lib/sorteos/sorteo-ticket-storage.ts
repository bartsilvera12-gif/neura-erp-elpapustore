import "server-only";

import type { AppSupabaseClient } from "@/lib/supabase/schema";

export const SORTEO_TICKET_ASSETS_BUCKET = "sorteo-ticket-assets";
export const SORTEO_TICKET_GENERATED_BUCKET = "sorteo-tickets-generated";

export function sorteoTicketAssetLogoPath(empresaId: string, sorteoId: string): string {
  return `${empresaId}/${sorteoId}/logo.png`;
}

export function sorteoTicketAssetBackgroundPath(empresaId: string, sorteoId: string): string {
  return `${empresaId}/${sorteoId}/background.png`;
}

/** Plantilla base completa (PNG/JPG/WebP subidos como template.*). */
export function sorteoTicketAssetTemplatePath(empresaId: string, sorteoId: string): string {
  return `${empresaId}/${sorteoId}/template.png`;
}

/** Posibles paths en Storage para logo (upload puede usar .png / .webp / .jpg). */
export function sorteoTicketAssetLogoCandidates(empresaId: string, sorteoId: string): string[] {
  const base = `${empresaId}/${sorteoId}`;
  return [`${base}/logo.png`, `${base}/logo.webp`, `${base}/logo.jpg`];
}

/** Posibles paths en Storage para fondo del ticket. */
export function sorteoTicketAssetBackgroundCandidates(empresaId: string, sorteoId: string): string[] {
  const base = `${empresaId}/${sorteoId}`;
  return [`${base}/background.png`, `${base}/background.webp`, `${base}/background.jpg`];
}

export function sorteoTicketAssetTemplateCandidates(empresaId: string, sorteoId: string): string[] {
  const base = `${empresaId}/${sorteoId}`;
  return [`${base}/template.png`, `${base}/template.webp`, `${base}/template.jpg`];
}

export function sorteoTicketGeneratedPath(
  empresaId: string,
  sorteoId: string,
  entradaId: string,
  templateRevision: number
): string {
  return `${empresaId}/${sorteoId}/${entradaId}/${templateRevision}.png`;
}

export async function ensureTicketBucketsExist(supabase: AppSupabaseClient): Promise<void> {
  const { data: buckets } = await supabase.storage.listBuckets();
  const names = new Set((buckets ?? []).map((b) => b.name));
  if (!names.has(SORTEO_TICKET_ASSETS_BUCKET)) {
    const { error } = await supabase.storage.createBucket(SORTEO_TICKET_ASSETS_BUCKET, {
      public: true,
      fileSizeLimit: 5242880,
      allowedMimeTypes: ["image/png", "image/jpeg", "image/webp"],
    });
    if (error && !error.message.toLowerCase().includes("already exists")) {
      console.warn("[sorteo-ticket-storage] bucket_assets", { message: error.message });
    }
  }
  if (!names.has(SORTEO_TICKET_GENERATED_BUCKET)) {
    const { error } = await supabase.storage.createBucket(SORTEO_TICKET_GENERATED_BUCKET, {
      public: false,
      fileSizeLimit: 10485760,
      allowedMimeTypes: ["image/png"],
    });
    if (error && !error.message.toLowerCase().includes("already exists")) {
      console.warn("[sorteo-ticket-storage] bucket_generated", { message: error.message });
    }
  }
}

export async function downloadAssetIfExists(
  supabase: AppSupabaseClient,
  bucket: string,
  path: string
): Promise<{ bytes: Buffer; mime: string } | null> {
  const { data, error } = await supabase.storage.from(bucket).download(path);
  if (error || !data) return null;
  const ab = await data.arrayBuffer();
  const bytes = Buffer.from(ab);
  const mime =
    path.endsWith(".png") ? "image/png" : path.endsWith(".webp") ? "image/webp" : "image/jpeg";
  return { bytes, mime };
}

/**
 * Esperas entre intentos de storage. El ticket fallaba con errores pasajeros de la API
 * (30-sep: órdenes creadas con el ticket en "error" y el cliente sin su boleta); la subida
 * es `upsert` a una ruta fija y la firma de URL no cambia nada, así que repetir es seguro.
 */
const TICKET_STORAGE_RETRY_DELAYS_MS: readonly number[] = [800, 2000];

export async function uploadGeneratedTicketPng(
  supabase: AppSupabaseClient,
  path: string,
  png: Buffer
): Promise<{ error?: string }> {
  let lastError = "";
  for (let attempt = 0; attempt <= TICKET_STORAGE_RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      console.warn("[sorteo-ticket] storage_upload_retry", { attempt, path, error: lastError.slice(0, 120) });
      await new Promise((r) => setTimeout(r, TICKET_STORAGE_RETRY_DELAYS_MS[attempt - 1]));
    }
    try {
      const { error } = await supabase.storage
        .from(SORTEO_TICKET_GENERATED_BUCKET)
        .upload(path, png, { contentType: "image/png", upsert: true });
      if (!error) return {};
      lastError = error.message || "upload_failed";
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  return { error: lastError || "upload_failed" };
}

export async function createSignedUrlForTicket(
  supabase: AppSupabaseClient,
  path: string,
  expiresSec: number
): Promise<{ url: string | null; error?: string }> {
  let lastError = "";
  for (let attempt = 0; attempt <= TICKET_STORAGE_RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, TICKET_STORAGE_RETRY_DELAYS_MS[attempt - 1]));
    }
    try {
      const { data, error } = await supabase.storage
        .from(SORTEO_TICKET_GENERATED_BUCKET)
        .createSignedUrl(path, expiresSec);
      if (!error && data?.signedUrl) return { url: data.signedUrl };
      lastError = error?.message ?? "signed_url_failed";
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  return { url: null, error: lastError || "signed_url_failed" };
}
