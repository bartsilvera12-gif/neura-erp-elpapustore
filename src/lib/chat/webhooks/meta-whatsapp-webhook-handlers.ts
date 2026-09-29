import { createClient } from "@supabase/supabase-js";
import { supabaseServiceRoleClientOptions, type AppSupabaseClient } from "@/lib/supabase/schema";
import { transientRetryFetch } from "@/lib/supabase/transient-retry-fetch";
import { NextRequest, NextResponse } from "next/server";
import type { WebhookProvisionEnv } from "@/lib/chat/channel-provision";
import { verifyMetaSignature } from "@/lib/chat/meta-signature";
import { processWhatsAppWebhookBody } from "@/lib/chat/whatsapp-webhook-service";
import { shouldAskMetaToRetry } from "@/lib/chat/webhooks/webhook-transient-error";

export function getSupabaseAdminForWebhooks(): AppSupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase no configurado");
  return createClient(url, key, {
    ...supabaseServiceRoleClientOptions,
    global: { fetch: transientRetryFetch },
  }) as AppSupabaseClient;
}

/**
 * GET — verificación del webhook Meta (WhatsApp Cloud API).
 * Debe ser público: sin cookies, sin JWT; solo hub.mode / hub.verify_token / hub.challenge.
 * @see https://developers.facebook.com/docs/graph-api/webhooks/getting-started#verification-requests
 */
export async function handleWhatsAppWebhookGet(request: NextRequest): Promise<NextResponse> {
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode")?.trim().toLowerCase() ?? "";
  const token = url.searchParams.get("hub.verify_token")?.trim() ?? "";
  const challengeRaw = url.searchParams.get("hub.challenge");
  const verifyEnv = process.env.WHATSAPP_VERIFY_TOKEN?.trim() ?? "";

  const logPrefix = "[webhooks/whatsapp][GET verify]";
  console.info(logPrefix, {
    mode: mode || "(vacío)",
    hasChallenge: challengeRaw != null && challengeRaw !== "",
    challengeLength: challengeRaw?.length ?? 0,
    hasVerifyEnv: Boolean(verifyEnv),
    tokenMatch: Boolean(verifyEnv && token && verifyEnv === token),
  });

  if (mode !== "subscribe") {
    console.warn(logPrefix, "rechazado: hub.mode no es subscribe");
    return new NextResponse("Forbidden", { status: 403 });
  }

  if (!verifyEnv) {
    console.error(
      logPrefix,
      "rechazado: falta WHATSAPP_VERIFY_TOKEN en el servidor (Vercel → Environment Variables)"
    );
    return new NextResponse("Forbidden", { status: 403 });
  }

  if (!token || token !== verifyEnv) {
    console.warn(logPrefix, "rechazado: hub.verify_token no coincide con WHATSAPP_VERIFY_TOKEN");
    return new NextResponse("Forbidden", { status: 403 });
  }

  if (challengeRaw === null || challengeRaw === "") {
    console.warn(logPrefix, "rechazado: falta hub.challenge");
    return new NextResponse("Forbidden", { status: 403 });
  }

  const challenge = challengeRaw;
  console.info(logPrefix, "OK: respondiendo hub.challenge (200 text/plain)");
  return new NextResponse(challenge, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store, max-age=0",
    },
  });
}

/**
 * POST — eventos entrantes Meta WhatsApp.
 */
export async function handleWhatsAppWebhookPost(request: NextRequest): Promise<NextResponse> {
  try {
    const rawBody = await request.text();
    const appSecret = process.env.WHATSAPP_APP_SECRET;
    if (appSecret) {
      const sig = request.headers.get("x-hub-signature-256");
      if (!verifyMetaSignature(rawBody, sig, appSecret)) {
        return NextResponse.json({ ok: false, error: "Firma inválida" }, { status: 401 });
      }
    }

    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return NextResponse.json({ ok: false, error: "JSON inválido" }, { status: 400 });
    }

    const supabase = getSupabaseAdminForWebhooks();
    const provisionEnv: WebhookProvisionEnv = {
      defaultEmpresaId: process.env.WHATSAPP_DEFAULT_EMPRESA_ID?.trim(),
      expectedPhoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID?.trim(),
    };
    const result = await processWhatsAppWebhookBody(supabase, body, provisionEnv);

    if (result.errors.length > 0) {
      console.warn("[webhooks/whatsapp][POST] resultado con errores/advertencias", {
        processed: result.processed,
        skipped: result.skipped,
        errors: result.errors,
      });
    } else if (result.processed > 0) {
      console.info("[webhooks/whatsapp][POST] ok", {
        processed: result.processed,
        skipped: result.skipped,
      });
    }

    // Falla pasajera sin nada guardado (Supabase/Cloudflare caído un momento): 503 para que
    // Meta reintente. Con 200 el mensaje del cliente se perdía sin rastro.
    if (shouldAskMetaToRetry(result)) {
      console.warn("[webhooks/whatsapp][POST] falla pasajera: se pide reintento a Meta (503)");
      return NextResponse.json(
        { ok: false, retry: true, processed: result.processed, skipped: result.skipped },
        { status: 503 }
      );
    }

    return NextResponse.json({
      ok: result.ok,
      processed: result.processed,
      skipped: result.skipped,
      errors: result.errors,
    });
  } catch (e) {
    console.error("[webhooks/whatsapp]", e);
    return NextResponse.json({ ok: false, error: "Error interno" }, { status: 500 });
  }
}
