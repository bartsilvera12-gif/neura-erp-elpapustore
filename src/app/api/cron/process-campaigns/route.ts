import { NextRequest, NextResponse } from "next/server";
import { getChatServiceClientForEmpresa } from "@/app/api/chat/_chat-service-client";
import { driveCampaignToCompletion } from "@/lib/campaigns/campaign-job-service";
import type { SupabaseAdmin } from "@/lib/chat/types";

/**
 * Cron backstop de campañas.
 *
 * El envío de campañas lo empuja el proceso Node del launch (driveCampaignToCompletion), así que
 * ya NO depende de la pestaña abierta. Este cron es la red de seguridad: si el proceso muere a
 * mitad de camino (p.ej. un redeploy del server), reanuda cualquier campaña que haya quedado en
 * `sending`. Es SEGURO correr junto al driver del launch y/o el polling del navegador porque el
 * claim atómico de runCampaignProcessOnce garantiza un solo envío por destinatario.
 *
 * Seguridad: requiere `Authorization: Bearer <CRON_SECRET>`. Sin secret válido → 401.
 * Agendar cada ~1 min (pg_cron + pg_net, tarea programada de Coolify, o cron externo).
 */

// El Papu (single_client). Mismo patrón que /api/cron/chat-tags-daily.
const EMPRESA_ID = "5ad0bdda-f94f-446c-9032-1fedf34e8479";

// Presupuesto de tiempo por ejecución del cron para no exceder timeouts HTTP.
const CRON_BUDGET_MS = 45_000;

function isAuthorized(request: NextRequest): boolean {
  const expected = process.env.CRON_SECRET?.trim();
  if (!expected) return false;
  const auth = request.headers.get("authorization") ?? "";
  return auth === `Bearer ${expected}`;
}

async function handle(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ ok: false, error: "no autorizado" }, { status: 401 });
  }

  const sb = await getChatServiceClientForEmpresa(EMPRESA_ID);

  const { data: sendingRows, error } = await sb
    .from("chat_campaigns")
    .select("id")
    .eq("empresa_id", EMPRESA_ID)
    .eq("status", "sending");

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  const ids = ((sendingRows ?? []) as Array<{ id: string }>).map((c) => c.id);
  const deadline = Date.now() + CRON_BUDGET_MS;
  const results: Array<{ campaign_id: string; processed: number; completed: boolean }> = [];

  for (const id of ids) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    const r = await driveCampaignToCompletion({
      supabase: sb as unknown as SupabaseAdmin,
      empresaId: EMPRESA_ID,
      campaignId: id,
      maxMs: remainingMs,
    });
    results.push({ campaign_id: id, processed: r.processed, completed: r.completed });
  }

  console.info("[cron][process-campaigns]", {
    sending_campaigns: ids.length,
    driven: results,
  });

  return NextResponse.json({
    ok: true,
    sending_campaigns: ids.length,
    driven: results,
  });
}

export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}
