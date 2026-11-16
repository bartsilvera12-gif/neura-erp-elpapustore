import { NextRequest, NextResponse } from "next/server";
import { getChatServiceClientForEmpresa } from "@/app/api/chat/_chat-service-client";
import { successResponse, errorResponse } from "@/lib/api/response";
import { requireCampanasApiAccess } from "@/lib/campaigns/campaign-auth";
import type { SupabaseAdmin } from "@/lib/chat/types";
import {
  buildMetaComponents,
  createMetaTemplate,
  getMetaChannelCreds,
  listMetaTemplatesAllStatuses,
  validateCreateTemplateInput,
  type CreateTemplateInput,
  type TemplateButtonInput,
} from "@/lib/campaigns/meta-template-management";
import {
  listTemplateHeaderDefaults,
  promoteTemplateHeaderFile,
  templateHeaderDefaultKey,
} from "@/lib/campaigns/template-header-default";

export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const auth = await requireCampanasApiAccess(request);
  if (!auth.ok) return NextResponse.json(errorResponse(auth.message), { status: auth.status });

  const channelId = new URL(request.url).searchParams.get("channel_id")?.trim() ?? "";
  if (!channelId) return NextResponse.json(errorResponse("channel_id es obligatorio"), { status: 400 });

  try {
    const sb = await getChatServiceClientForEmpresa(auth.empresaId);
    const c = await getMetaChannelCreds({ supabase: sb as unknown as SupabaseAdmin, empresaId: auth.empresaId, channelId });
    if (!c.ok) return NextResponse.json(errorResponse(c.error), { status: 400 });
    const [items, defaults] = await Promise.all([
      listMetaTemplatesAllStatuses(c.creds),
      listTemplateHeaderDefaults({ empresaId: auth.empresaId, channelId }).catch(() => ({}) as Record<string, string>),
    ]);
    const withDefaults = items.map((t) => ({
      ...t,
      default_header_url: defaults[templateHeaderDefaultKey(t.name, t.language)] ?? null,
    }));
    return NextResponse.json(successResponse({ items: withDefaults, media_header_enabled: Boolean(c.creds.appId) }));
  } catch (e) {
    return NextResponse.json(errorResponse(e instanceof Error ? e.message : "Error"), { status: 502 });
  }
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function parseButtons(raw: unknown): TemplateButtonInput[] {
  if (!Array.isArray(raw)) return [];
  const out: TemplateButtonInput[] = [];
  for (const b of raw) {
    const o = (b ?? {}) as Record<string, unknown>;
    const type = str(o.type).toUpperCase();
    if (type === "QUICK_REPLY") out.push({ type, text: str(o.text) });
    else if (type === "URL") out.push({ type, text: str(o.text), url: str(o.url).trim(), example: str(o.example) });
    else if (type === "PHONE_NUMBER") out.push({ type, text: str(o.text), phone_number: str(o.phone_number) });
  }
  return out;
}

export async function POST(request: NextRequest) {
  const auth = await requireCampanasApiAccess(request);
  if (!auth.ok) return NextResponse.json(errorResponse(auth.message), { status: auth.status });

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const channelId = str(body.channel_id).trim();
  if (!channelId) return NextResponse.json(errorResponse("channel_id es obligatorio"), { status: 400 });

  const h = (body.header ?? {}) as Record<string, unknown>;
  const headerKind = str(h.kind);
  const header: CreateTemplateInput["header"] =
    headerKind === "text"
      ? { kind: "text", text: str(h.text), example: str(h.example) }
      : headerKind === "image" || headerKind === "video" || headerKind === "document"
        ? { kind: headerKind, handle: str(h.handle).trim() }
        : { kind: "none" };

  const b = (body.body ?? {}) as Record<string, unknown>;
  const input: CreateTemplateInput = {
    name: str(body.name).trim(),
    language: str(body.language).trim() || "es",
    category: str(body.category).toUpperCase() === "MARKETING" ? "MARKETING" : "UTILITY",
    header,
    body: { text: str(b.text), examples: Array.isArray(b.examples) ? b.examples.map(str) : [] },
    footer: str(body.footer),
    buttons: parseButtons(body.buttons),
  };

  const invalid = validateCreateTemplateInput(input);
  if (invalid) return NextResponse.json(errorResponse(invalid), { status: 400 });

  try {
    const sb = await getChatServiceClientForEmpresa(auth.empresaId);
    const c = await getMetaChannelCreds({ supabase: sb as unknown as SupabaseAdmin, empresaId: auth.empresaId, channelId });
    if (!c.ok) return NextResponse.json(errorResponse(c.error), { status: 400 });

    const components = buildMetaComponents(input);
    const created = await createMetaTemplate(c.creds, input, components);

    let defaultHeaderUrl: string | null = null;
    const storagePath = str(h.storage_path).trim();
    if (input.header.kind !== "none" && input.header.kind !== "text" && storagePath) {
      defaultHeaderUrl = await promoteTemplateHeaderFile({
        empresaId: auth.empresaId,
        channelId,
        name: input.name,
        language: input.language,
        tmpPath: storagePath,
      }).catch(() => null);
    }
    return NextResponse.json(successResponse({ ...created, default_header_url: defaultHeaderUrl }));
  } catch (e) {
    return NextResponse.json(errorResponse(e instanceof Error ? e.message : "Error"), { status: 502 });
  }
}
