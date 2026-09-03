import { NextRequest, NextResponse } from "next/server";
import { getChatServiceClientForEmpresa } from "@/app/api/chat/_chat-service-client";
import { getAuthWithRol } from "@/lib/middleware/auth";

const VALID_NODE_TYPES = ["buttons", "list", "text", "media", "image_input", "human", "end", "identity_recall"] as const;

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ flowCode: string }> }
) {
  try {
    const auth = await getAuthWithRol(request);
    if (!auth?.empresa_id) {
      return NextResponse.json({ ok: false, error: "No autenticado" }, { status: 401 });
    }
    const params = await context.params;
    const flowCode = params.flowCode;
    const supabase = await getChatServiceClientForEmpresa(auth.empresa_id);

    const { data: nodes, error: nErr } = await supabase
      .from("chat_flow_nodes")
      .select(
        "id, node_code, node_type, message_text, save_as_field, next_node_code, sort_order, is_active, crm_action_type, crm_action_config, created_at"
      )
      .eq("empresa_id", auth.empresa_id)
      .eq("flow_code", flowCode)
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true });
    if (nErr) return NextResponse.json({ ok: false, error: nErr.message }, { status: 400 });

    const ids = (nodes ?? []).map((n) => n.id as string);
    let options: Array<Record<string, unknown>> = [];
    let blocks: Array<Record<string, unknown>> = [];
    if (ids.length) {
      const { data: opts, error: optsErr } = await supabase
        .from("chat_flow_options")
        .select(
          "id, node_id, label, option_value, meta_button_id, next_node_code, sort_order, option_payload, group_title, group_order"
        )
        .in("node_id", ids)
        .order("sort_order", { ascending: true });
      if (optsErr) {
        console.error("[api/chat/flows/:flowCode/nodes][GET] chat_flow_options:", optsErr.message);
        return NextResponse.json({ ok: false, error: `Opciones del flujo: ${optsErr.message}` }, { status: 400 });
      }
      options = (opts ?? []) as Array<Record<string, unknown>>;
      const { data: blks, error: blksErr } = await supabase
        .from("chat_flow_node_blocks")
        .select("id, node_id, block_type, content_text, media_url, sort_order, created_at")
        .eq("empresa_id", auth.empresa_id)
        .in("node_id", ids)
        .order("sort_order", { ascending: true })
        .order("created_at", { ascending: true });
      if (blksErr) {
        console.error("[api/chat/flows/:flowCode/nodes][GET] chat_flow_node_blocks:", blksErr.message);
        return NextResponse.json(
          {
            ok: false,
            error: `Bloques del flujo (revisá que exista la tabla en el schema de la empresa): ${blksErr.message}`,
          },
          { status: 400 }
        );
      }
      blocks = (blks ?? []) as Array<Record<string, unknown>>;
    }

    const byNode = new Map<string, Array<Record<string, unknown>>>();
    for (const o of options) {
      const nodeId = o.node_id as string;
      const list = byNode.get(nodeId) ?? [];
      list.push(o);
      byNode.set(nodeId, list);
    }
    const blocksByNode = new Map<string, Array<Record<string, unknown>>>();
    for (const b of blocks) {
      const nodeId = b.node_id as string;
      const list = blocksByNode.get(nodeId) ?? [];
      list.push(b);
      blocksByNode.set(nodeId, list);
    }

    return NextResponse.json({
      ok: true,
      items: (nodes ?? []).map((n) => ({
        ...n,
        options: byNode.get(n.id as string) ?? [],
        blocks: blocksByNode.get(n.id as string) ?? [],
      })),
    });
  } catch (e) {
    console.error("[api/chat/flows/:flowCode/nodes][GET]", e);
    return NextResponse.json({ ok: false, error: "Error interno" }, { status: 500 });
  }
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ flowCode: string }> }
) {
  try {
    const auth = await getAuthWithRol(request);
    if (!auth?.empresa_id) {
      return NextResponse.json({ ok: false, error: "No autenticado" }, { status: 401 });
    }
    const params = await context.params;
    const flowCode = params.flowCode;
    const body = (await request.json().catch(() => ({}))) as {
      node_code?: string;
      node_type?: string;
      message_text?: string;
      save_as_field?: string | null;
      next_node_code?: string | null;
      is_active?: boolean;
      crm_action_type?: string | null;
      crm_action_config?: Record<string, unknown> | null;
    };
    const nodeCode = (body.node_code ?? "").trim();
    const nodeType = (body.node_type ?? "").trim();
    if (!nodeCode || !nodeType) {
      return NextResponse.json({ ok: false, error: "node_code y node_type requeridos" }, { status: 400 });
    }
    if (!VALID_NODE_TYPES.includes(nodeType as (typeof VALID_NODE_TYPES)[number])) {
      return NextResponse.json({ ok: false, error: "node_type inválido" }, { status: 400 });
    }
    const supabase = await getChatServiceClientForEmpresa(auth.empresa_id);
    const { data: lastNode } = await supabase
      .from("chat_flow_nodes")
      .select("sort_order")
      .eq("empresa_id", auth.empresa_id)
      .eq("flow_code", flowCode)
      .order("sort_order", { ascending: false })
      .limit(1)
      .maybeSingle();
    const nextSortOrder =
      typeof (lastNode as { sort_order?: number } | null)?.sort_order === "number"
        ? ((lastNode as { sort_order: number }).sort_order ?? 0) + 1
        : 1;
    const { data, error } = await supabase
      .from("chat_flow_nodes")
      .insert({
        empresa_id: auth.empresa_id,
        flow_code: flowCode,
        node_code: nodeCode,
        node_type: nodeType,
        message_text: body.message_text ?? null,
        save_as_field: body.save_as_field?.trim() || null,
        next_node_code: body.next_node_code?.trim() || null,
        sort_order: nextSortOrder,
        is_active: body.is_active !== false,
        crm_action_type: body.crm_action_type?.trim() || null,
        crm_action_config:
          typeof body.crm_action_config === "object" && body.crm_action_config
            ? body.crm_action_config
            : {},
      })
      .select("id, node_code, node_type, message_text, save_as_field, next_node_code, sort_order, is_active, crm_action_type, crm_action_config, created_at")
      .single();
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
    return NextResponse.json({ ok: true, item: data });
  } catch (e) {
    console.error("[api/chat/flows/:flowCode/nodes][POST]", e);
    return NextResponse.json({ ok: false, error: "Error interno" }, { status: 500 });
  }
}
