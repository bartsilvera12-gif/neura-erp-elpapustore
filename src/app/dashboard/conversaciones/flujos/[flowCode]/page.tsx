"use client";

import Link from "next/link";
import { GripVertical, Trash2 } from "lucide-react";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";
import { getSorteos } from "@/lib/sorteos/actions";
import { parseMoneyPy } from "@/lib/sorteos/parse-money-py";
import { optionPayloadFinalizesSorteoOrder } from "@/lib/sorteos/sorteo-option-payload";
import { computeFlowGraphWarnings } from "@/lib/chat/flow-graph-warnings";
import { FlowRecontactAutomationsPanel } from "./flow-recontact-automations-panel";
import {
  buttonQuickReplyGroupsEnabled,
  partitionQuickReplyButtonGroups,
  validateQuickReplyGroupsMaxThree,
} from "@/lib/chat/flow-button-groups";

type FlowNodeOption = {
  id: string;
  node_id: string;
  label: string;
  option_value: string;
  meta_button_id: string;
  next_node_code: string | null;
  sort_order: number;
  /** Título de burbuja WhatsApp (solo modo agrupado). */
  group_title?: string | null;
  group_order?: number;
  option_payload?: Record<string, unknown>;
};

type OptionSimpleDraft = {
  cantidad: string;
  producto: string;
  monto: string;
  promo_nombre: string;
  precio_regular: string;
  opcion_label: string;
};

type FlowNodeBlock = {
  id: string;
  node_id: string;
  block_type: "text" | "image" | "buttons";
  content_text: string | null;
  media_url: string | null;
  sort_order: number;
};

type FlowNode = {
  id: string;
  node_code: string;
  node_type: string;
  message_text: string | null;
  save_as_field: string | null;
  next_node_code: string | null;
  sort_order: number;
  created_at: string;
  is_active: boolean;
  crm_action_type: string | null;
  crm_action_config: Record<string, unknown>;
  options: FlowNodeOption[];
  blocks: FlowNodeBlock[];
};

const NODE_TYPE_OPTIONS = [
  {
    value: "text",
    label: "Texto (automático o captura)",
    help: "Si tiene 'Guardar respuesta como' espera texto del cliente; si no, envía mensaje automático.",
  },
  {
    value: "media",
    label: "Mensaje con imagen",
    help: "Envía una sola burbuja con imagen y texto opcional (caption).",
  },
  { value: "buttons", label: "Botones", help: "Muestra botones rápidos al cliente." },
  { value: "list", label: "Lista", help: "Interacción tipo lista (catálogo de opciones)." },
  {
    value: "image_input",
    label: "Solicitar imagen (comprobante)",
    help: "Pide el comprobante por mensaje, espera una imagen, guarda la URL en «Guardar respuesta como» (ej. comprobante_pago) y avanza al siguiente paso.",
  },
  { value: "human", label: "Derivar a humano", help: "Pasa la conversación a atención humana." },
  { value: "end", label: "Finalizar", help: "Cierra la automatización del flujo." },
] as const;

/** Insertar en medio del grafo: sin tipo media (requiere bloques; crear desde el formulario general). */
const INSERT_NODE_TYPE_OPTIONS = NODE_TYPE_OPTIONS.filter((o) => o.value !== "media");

const MAX_WHATSAPP_IMAGE_CAPTION = 1024;
const CONTEXT_VAR_KEYS = [
  "opcion_label",
  "cantidad",
  "producto",
  "monto",
  "promo_nombre",
  "precio_fuente",
  "precio_regular",
] as const;

function isValidHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

/** Evita que una respuesta parcial del PATCH borre campos con `undefined` al hacer spread sobre la opción local. */
function mergeSavedFlowOption(prev: FlowNodeOption, incoming: Partial<FlowNodeOption>): FlowNodeOption {
  return {
    ...prev,
    label: typeof incoming.label === "string" ? incoming.label : prev.label,
    option_value: typeof incoming.option_value === "string" ? incoming.option_value : prev.option_value,
    meta_button_id: typeof incoming.meta_button_id === "string" ? incoming.meta_button_id : prev.meta_button_id,
    next_node_code:
      incoming.next_node_code !== undefined ? incoming.next_node_code : prev.next_node_code,
    sort_order: typeof incoming.sort_order === "number" ? incoming.sort_order : prev.sort_order,
    group_title: incoming.group_title !== undefined ? incoming.group_title : prev.group_title,
    group_order:
      typeof incoming.group_order === "number" ? incoming.group_order : prev.group_order ?? 0,
    option_payload:
      incoming.option_payload !== undefined && incoming.option_payload !== null
        ? incoming.option_payload
        : prev.option_payload,
    node_id: typeof incoming.node_id === "string" ? incoming.node_id : prev.node_id,
    id: typeof incoming.id === "string" ? incoming.id : prev.id,
  };
}

/**
 * Orden estable para el editor: solo sort_order y uuid. No ordenar por group_title ni group_order aquí:
 * si no, al editar el título del grupo las filas se reordenan y el foco salta / los valores parecen “mezclarse”.
 */
function sortOptionsStableForEditor(node: FlowNode): FlowNodeOption[] {
  return [...node.options].sort((a, b) => {
    const d = (a.sort_order ?? 0) - (b.sort_order ?? 0);
    if (d !== 0) return d;
    return a.id.localeCompare(b.id);
  });
}

type FlowOptionCreateContext =
  | { kind: "default" }
  /** Nueva fila copiando grupo y destino típico del ancla (mismo group_title / group_order). */
  | { kind: "in_group"; anchorOptionId: string }
  /** Nuevo bloque de grupo vacío para completar en el editor. */
  | { kind: "new_group" }
  /** Opción sin group_title (bucket legacy) dentro de un nodo que también tiene grupos. */
  | { kind: "ungrouped" };

function validateButtonsQuickReplyGroups(node: FlowNode): string | null {
  if (node.node_type !== "buttons") return null;
  const opts = node.options.map((o) => ({
    id: o.id,
    label: o.label,
    option_value: o.option_value,
    meta_button_id: o.meta_button_id,
    next_node_code: o.next_node_code,
    sort_order: o.sort_order,
    group_title: o.group_title ?? null,
    group_order: o.group_order ?? 0,
  }));
  if (!buttonQuickReplyGroupsEnabled(opts)) return null;
  const defaultTitle = node.message_text?.trim() || "Opciones";
  const groups = partitionQuickReplyButtonGroups(opts, defaultTitle);
  return validateQuickReplyGroupsMaxThree(groups);
}

function compareFlowNodes(a: FlowNode, b: FlowNode): number {
  const bySort = (a.sort_order ?? 0) - (b.sort_order ?? 0);
  if (bySort !== 0) return bySort;
  const byCreatedAt = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
  if (!Number.isNaN(byCreatedAt) && byCreatedAt !== 0) return byCreatedAt;
  return a.node_code.localeCompare(b.node_code);
}

function prettifyCode(code: string): string {
  return code
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

function friendlyNodeTitle(node: FlowNode): string {
  if (node.node_type === "media") {
    const mediaCaption = node.blocks.find((b) => b.block_type === "image")?.content_text?.trim();
    if (mediaCaption) return `Mensaje con imagen: ${mediaCaption.slice(0, 24)}${mediaCaption.length > 24 ? "..." : ""}`;
    return "Mensaje con imagen";
  }
  const txt = node.message_text?.trim();
  if (txt) return txt.slice(0, 42) + (txt.length > 42 ? "..." : "");
  return prettifyCode(node.node_code);
}

function nodeTypeLabel(nodeType: string): string {
  return NODE_TYPE_OPTIONS.find((n) => n.value === nodeType)?.label ?? nodeType;
}

function nodeTypeHelp(nodeType: string): string {
  return (
    NODE_TYPE_OPTIONS.find((n) => n.value === nodeType)?.help ??
    "Configurá este paso según la experiencia del cliente."
  );
}

function nodeAccent(nodeType: string): string {
  if (nodeType === "media") return "border-l-fuchsia-400";
  if (nodeType === "buttons" || nodeType === "list") return "border-l-sky-400";
  if (nodeType === "human") return "border-l-amber-400";
  if (nodeType === "end") return "border-l-emerald-400";
  if (nodeType === "image_input") return "border-l-violet-400";
  return "border-l-slate-300";
}

function toMetaButtonId(label: string): string {
  return (
    label
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 50) || `btn_${Date.now()}`
  );
}

/** Evita colisión UNIQUE (node_id, meta_button_id) al derivar el id desde el label. */
function resolveUniqueMetaButtonId(node: FlowNode, currentOptionId: string, label: string): string {
  let base = toMetaButtonId(label);
  if (!base) base = `opt_${currentOptionId.replace(/-/g, "").slice(0, 12)}`;
  const others = node.options.filter((o) => o.id !== currentOptionId);
  const used = new Set(others.map((o) => o.meta_button_id));
  let candidate = base;
  let n = 2;
  while (used.has(candidate)) {
    const suffix = `_${n}`;
    candidate = `${base}${suffix}`.slice(0, 50);
    n += 1;
  }
  return candidate;
}

function stringifyOptionPayload(value: Record<string, unknown> | undefined): string {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return "{}";
  }
}

function toSimpleDraftFromPayload(option: FlowNodeOption): OptionSimpleDraft {
  const p = option.option_payload ?? {};
  const regRaw =
    p.precio_regular ?? p.precio_regular_referencia ?? p.precio_lista ?? "";
  return {
    cantidad: p.cantidad === undefined || p.cantidad === null ? "" : String(p.cantidad),
    producto: p.producto === undefined || p.producto === null ? "" : String(p.producto),
    monto: p.monto === undefined || p.monto === null ? "" : String(p.monto),
    promo_nombre:
      p.promo_nombre === undefined || p.promo_nombre === null ? "" : String(p.promo_nombre),
    precio_regular: regRaw === undefined || regRaw === null ? "" : String(regRaw),
    /** Solo datos persistidos en payload; no copiar `option.label` (evita fusionar con «Texto del botón»). */
    opcion_label:
      p.opcion_label === undefined || p.opcion_label === null ? "" : String(p.opcion_label),
  };
}

function stripSorteoFinalizeKeys(p: Record<string, unknown>): Record<string, unknown> {
  const o = { ...p };
  delete o.confirmar_orden_sorteo;
  delete o.finalize_sorteo_order;
  delete o.cerrar_compra_sorteo;
  return o;
}

function buildPayloadFromSimple(
  existingPayload: Record<string, unknown> | undefined,
  draft: OptionSimpleDraft
): Record<string, unknown> {
  const base: Record<string, unknown> = { ...(existingPayload ?? {}) };
  const cantidad = draft.cantidad.trim();
  const producto = draft.producto.trim();
  const monto = draft.monto.trim();
  const promoNombre = draft.promo_nombre.trim();
  const precioRegular = draft.precio_regular.trim();
  /** «Etiqueta seleccionada» únicamente; el texto visible va en `chat_flow_options.label`, no aquí. */
  const etiquetaInterna = draft.opcion_label.trim();

  if (cantidad) base.cantidad = Number.isFinite(Number(cantidad)) ? Number(cantidad) : cantidad;
  else delete base.cantidad;
  if (producto) base.producto = producto;
  else delete base.producto;
  const montoParsed = monto ? parseMoneyPy(monto) : null;
  if (montoParsed != null && montoParsed > 0) {
    const r = Math.round(montoParsed);
    base.monto = r;
    base.monto_compra = r;
    base.monto_promocional = r;
    base.sorteo_monto_opcion = r;
    base.precio_fuente = "promo";
  } else {
    delete base.monto;
    delete base.monto_compra;
    delete base.monto_promocional;
    delete base.sorteo_monto_opcion;
    delete base.precio_fuente;
  }
  if (promoNombre) base.promo_nombre = promoNombre;
  else delete base.promo_nombre;
  const regParsed = precioRegular ? parseMoneyPy(precioRegular) : null;
  if (regParsed != null && regParsed > 0) {
    base.precio_regular = Math.round(regParsed);
  } else {
    delete base.precio_regular;
    delete base.precio_regular_referencia;
    delete base.precio_lista;
  }
  if (etiquetaInterna) base.opcion_label = etiquetaInterna;
  else delete base.opcion_label;

  return base;
}

export default function FlowEditorPage() {
  const params = useParams<{ flowCode: string }>();
  const flowCode = decodeURIComponent(params?.flowCode ?? "");
  const [nodes, setNodes] = useState<FlowNode[]>([]);
  /** Lectura síncrona del último estado al guardar (evita `liveOpt.label` stale si el clic corre antes del re-render). */
  const nodesRef = useRef<FlowNode[]>([]);
  nodesRef.current = nodes;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [newNodeCode, setNewNodeCode] = useState("");
  const [newNodeType, setNewNodeType] = useState("text");
  const [creatingNode, setCreatingNode] = useState(false);
  const [savingNodeId, setSavingNodeId] = useState<string | null>(null);
  const [deletingNodeId, setDeletingNodeId] = useState<string | null>(null);
  const [reorderBusy, setReorderBusy] = useState(false);
  const [lastSavedNodeId, setLastSavedNodeId] = useState<string | null>(null);
  const [expandedNodeId, setExpandedNodeId] = useState<string | null>(null);
  const [optionPayloadDrafts, setOptionPayloadDrafts] = useState<Record<string, string>>({});
  const [optionEditorMode, setOptionEditorMode] = useState<Record<string, "simple" | "advanced">>({});
  const [optionSimpleDrafts, setOptionSimpleDrafts] = useState<Record<string, OptionSimpleDraft>>({});
  const [optionSaveError, setOptionSaveError] = useState<Record<string, string>>({});
  /** Botón que solo cierra la compra sorteo (no redefine oferta). */
  const [optionFinalizeSorteo, setOptionFinalizeSorteo] = useState<Record<string, boolean>>({});
  const [sorteosOptions, setSorteosOptions] = useState<{ id: string; nombre: string }[]>([]);
  const [flowSorteoId, setFlowSorteoId] = useState<string | null>(null);
  const [flowSorteoNombre, setFlowSorteoNombre] = useState<string | null>(null);
  const [sorteoDraft, setSorteoDraft] = useState<string>("");
  const [savingSorteoLink, setSavingSorteoLink] = useState(false);
  const [sorteoIncompleteMsgDraft, setSorteoIncompleteMsgDraft] = useState("");
  const [savingSorteoIncompleteMsg, setSavingSorteoIncompleteMsg] = useState(false);
  /** Evita pantalla completa «Cargando nodos…» en acciones rápidas (p. ej. crear bloque imagen). */
  const [creatingBlockKey, setCreatingBlockKey] = useState<string | null>(null);

  const [insertModal, setInsertModal] = useState<
    | null
    | {
        sourceType: "node" | "option";
        sourceNodeCode: string;
        sourceOptionId?: string;
        optionLabel?: string;
      }
  >(null);
  const [insertDraft, setInsertDraft] = useState({
    node_code: "",
    node_type: "text",
    message_text: "",
    save_as_field: "",
  });
  const [insertBusy, setInsertBusy] = useState(false);

  const [changeNextModal, setChangeNextModal] = useState<
    | null
    | { kind: "node"; nodeId: string }
    | { kind: "option"; nodeId: string; optionId: string }
  >(null);
  const [changeNextValue, setChangeNextValue] = useState("");
  const [changeNextBusy, setChangeNextBusy] = useState(false);

  const orderedNodes = useMemo(() => [...nodes].sort(compareFlowNodes), [nodes]);

  const nodeByCode = useMemo(
    () => new Map(orderedNodes.map((n) => [n.node_code, n])),
    [orderedNodes]
  );

  const [editorTab, setEditorTab] = useState<"pasos" | "automatizaciones">("pasos");

  const nodePickerOptions = useMemo(
    () =>
      orderedNodes.map((n) => ({
        node_code: n.node_code,
        label: friendlyNodeTitle(n),
      })),
    [orderedNodes]
  );

  const nodeCodes = useMemo(() => orderedNodes.map((n) => n.node_code), [orderedNodes]);

  const graphWarnings = useMemo(
    () =>
      computeFlowGraphWarnings(
        orderedNodes.map((n) => ({
          node_code: n.node_code,
          node_type: n.node_type,
          next_node_code: n.next_node_code,
          options: n.options.map((o) => ({
            id: o.id,
            label: o.label,
            next_node_code: o.next_node_code,
          })),
        }))
      ),
    [orderedNodes]
  );

  const incomingConnections = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const n of orderedNodes) {
      if (n.next_node_code) {
        const list = map.get(n.next_node_code) ?? [];
        list.push(`${prettifyCode(n.node_code)} (siguiente)`);
        map.set(n.next_node_code, list);
      }
      for (const opt of n.options) {
        if (!opt.next_node_code) continue;
        const list = map.get(opt.next_node_code) ?? [];
        list.push(`${prettifyCode(n.node_code)} > ${opt.label}`);
        map.set(opt.next_node_code, list);
      }
    }
    return map;
  }, [orderedNodes]);

  function getIncomingLabels(nodeCode: string): string[] {
    return incomingConnections.get(nodeCode) ?? [];
  }

  function hasSelectableContext(nodeCode: string): boolean {
    return getIncomingLabels(nodeCode).some((label) => label.includes(">"));
  }

  function appendPlaceholderToNodeMessage(nodeId: string, variableKey: string) {
    const token = `{{${variableKey}}}`;
    setNodes((prev) =>
      prev.map((n) =>
        n.id === nodeId ? { ...n, message_text: `${(n.message_text ?? "").trim()}\n${token}`.trim() } : n
      )
    );
  }

  function getImageBlock(node: FlowNode): FlowNodeBlock | undefined {
    return node.blocks.find((b) => b.block_type === "image");
  }

  function getTextPreview(node: FlowNode): string {
    const blockText = node.blocks.find((b) => b.block_type === "text")?.content_text?.trim();
    if (blockText) return blockText;
    return node.message_text?.trim() || "Sin texto de vista previa";
  }

  function nextStepLabel(nextNodeCode: string | null): string {
    if (!nextNodeCode) return "Sin siguiente paso";
    const target = nodeByCode.get(nextNodeCode);
    if (!target) return `${prettifyCode(nextNodeCode)} (pendiente crear)`;
    return friendlyNodeTitle(target);
  }

  function blockBusyKey(nodeId: string, blockType: FlowNodeBlock["block_type"]) {
    return `${nodeId}:${blockType}`;
  }

  async function reload(opts?: { soft?: boolean }): Promise<FlowNode[]> {
    const fullScreen = opts?.soft !== true;
    if (fullScreen) setLoading(true);
    try {
      const res = await fetchWithSupabaseSession(`/api/chat/flows/${encodeURIComponent(flowCode)}/nodes`, {
        credentials: "same-origin",
        cache: "no-store",
      });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        items?: FlowNode[];
      };
      if (!res.ok || !json.ok) throw new Error(json.error ?? "No se pudo cargar nodos");
      const items = json.items ?? [];
      setNodes(items);
      /** Tras cada GET, alinear borradores con servidor (antes solo se inicializaba si faltaba la clave → estado viejo). */
      setOptionPayloadDrafts(() => {
        const next: Record<string, string> = {};
        for (const node of items) {
          for (const option of node.options ?? []) {
            next[option.id] = stringifyOptionPayload(option.option_payload);
          }
        }
        return next;
      });
      setOptionSimpleDrafts(() => {
        const next: Record<string, OptionSimpleDraft> = {};
        for (const node of items) {
          for (const option of node.options ?? []) {
            next[option.id] = toSimpleDraftFromPayload(option);
          }
        }
        return next;
      });
      setOptionEditorMode((prev) => {
        const next = { ...prev };
        for (const node of items) {
          for (const option of node.options ?? []) {
            if (!next[option.id]) next[option.id] = "simple";
          }
        }
        return next;
      });
      setOptionFinalizeSorteo((prev) => {
        const next = { ...prev };
        for (const node of items) {
          for (const option of node.options ?? []) {
            next[option.id] = optionPayloadFinalizesSorteoOrder(option.option_payload);
          }
        }
        return next;
      });
      setError(null);
      return items;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al cargar");
      return [];
    } finally {
      if (fullScreen) setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
    void (async () => {
      try {
        const [sorteosRows, flowRes] = await Promise.all([
          getSorteos().catch(() => []),
          fetchWithSupabaseSession(`/api/chat/flows/${encodeURIComponent(flowCode)}`, {
            credentials: "same-origin",
            cache: "no-store",
          }).then((r) => r.json()),
        ]);
        setSorteosOptions(sorteosRows.map((s) => ({ id: s.id, nombre: s.nombre })));
        const fj = flowRes as {
          ok?: boolean;
          item?: {
            sorteo_id?: string | null;
            sorteo_nombre?: string | null;
            sorteo_datos_incompletos_message?: string | null;
          };
        };
        if (fj.ok && fj.item) {
          setFlowSorteoId(fj.item.sorteo_id ?? null);
          setFlowSorteoNombre(fj.item.sorteo_nombre ?? null);
          setSorteoDraft(fj.item.sorteo_id ?? "");
          setSorteoIncompleteMsgDraft(fj.item.sorteo_datos_incompletos_message ?? "");
        }
      } catch {
        setSorteosOptions([]);
      }
    })();
  }, [flowCode]);

  async function saveSorteoAssociation() {
    setSavingSorteoLink(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await fetchWithSupabaseSession(`/api/chat/flows/${encodeURIComponent(flowCode)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ sorteo_id: sorteoDraft.trim() || null }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        item?: { sorteo_id?: string | null; sorteo_nombre?: string | null };
      };
      if (!res.ok || !json.ok) throw new Error(json.error ?? "No se pudo guardar la asociación");
      const item = json.item;
      if (item) {
        setFlowSorteoId(item.sorteo_id ?? null);
        setFlowSorteoNombre(item.sorteo_nombre ?? null);
      }
      setSuccess("Sorteo asociado guardado.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al guardar sorteo");
    } finally {
      setSavingSorteoLink(false);
    }
  }

  async function saveSorteoIncompleteMessage() {
    setSavingSorteoIncompleteMsg(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await fetchWithSupabaseSession(`/api/chat/flows/${encodeURIComponent(flowCode)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          sorteo_datos_incompletos_message: sorteoIncompleteMsgDraft.trim() || null,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        item?: { sorteo_datos_incompletos_message?: string | null };
      };
      if (!res.ok || !json.ok) throw new Error(json.error ?? "No se pudo guardar el mensaje");
      if (json.item?.sorteo_datos_incompletos_message != null) {
        setSorteoIncompleteMsgDraft(json.item.sorteo_datos_incompletos_message);
      }
      setSuccess("Mensaje de datos incompletos guardado.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al guardar mensaje");
    } finally {
      setSavingSorteoIncompleteMsg(false);
    }
  }

  async function createNode(e: React.FormEvent) {
    e.preventDefault();
    const trimmedCode = newNodeCode.trim();
    if (!trimmedCode) {
      setError("Escribí el nombre del paso (código interno) antes de crear el nodo.");
      return;
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(trimmedCode)) {
      setError("El código del paso solo puede tener letras, números, guion y guion bajo.");
      return;
    }
    setError(null);
    setSuccess(null);
    setCreatingNode(true);
    try {
      const res = await fetchWithSupabaseSession(`/api/chat/flows/${encodeURIComponent(flowCode)}/nodes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          node_code: trimmedCode,
          node_type: newNodeType,
          message_text: "",
        }),
      });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) throw new Error(json.error ?? "No se pudo crear nodo");
      setNewNodeCode("");
      const reloaded = await reload();
      const created = reloaded.find((n) => n.node_code === trimmedCode);
      setExpandedNodeId(created?.id ?? null);
      setSuccess(`Paso ${prettifyCode(trimmedCode)} creado.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error creando nodo");
    } finally {
      setCreatingNode(false);
    }
  }

  async function saveNode(node: FlowNode) {
    setError(null);
    if (node.node_type === "media") {
      const mediaBlock = getImageBlock(node);
      const mediaUrl = mediaBlock?.media_url?.trim() ?? "";
      const captionSize = (mediaBlock?.content_text ?? "").trim().length;
      if (!mediaBlock) {
        throw new Error("Este nodo requiere configurar una imagen antes de guardar.");
      }
      if (!mediaUrl || !isValidHttpUrl(mediaUrl)) {
        throw new Error("El nodo 'Mensaje con imagen' requiere una URL válida de imagen.");
      }
      if (captionSize > MAX_WHATSAPP_IMAGE_CAPTION) {
        throw new Error(`El caption supera ${MAX_WHATSAPP_IMAGE_CAPTION} caracteres.`);
      }
      // UX: guardar el bloque media junto con el paso para evitar errores por cambios no persistidos.
      await saveBlock(node, mediaBlock);
    }
    const res = await fetchWithSupabaseSession(
      `/api/chat/flows/${encodeURIComponent(flowCode)}/nodes/${encodeURIComponent(node.node_code)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          node_type: node.node_type,
          message_text: node.message_text ?? "",
          save_as_field: node.save_as_field ?? null,
          next_node_code: node.next_node_code ?? null,
          is_active: node.is_active,
          crm_action_type: node.crm_action_type ?? null,
          crm_action_config: node.crm_action_config ?? {},
        }),
      }
    );
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!res.ok || !json.ok) throw new Error(json.error ?? "No se pudo guardar nodo");

    /** Sin esto, quien usa solo «Guardar paso» nunca mandaba PATCH de opciones → el texto del botón no persistía en BD. */
    const snap = nodesRef.current.find((n) => n.id === node.id);
    if (snap && snap.node_type === "buttons") {
      const gErr = validateButtonsQuickReplyGroups(snap);
      if (gErr) throw new Error(gErr);
    }
    if (snap && (snap.node_type === "buttons" || snap.node_type === "list") && snap.options.length > 0) {
      for (const o of snap.options) {
        await persistOptionCore(snap, o, { toastSuccess: false, reason: "save_node_batch" });
      }
    }
  }

  /**
   * Persiste una opción (label, payload, siguiente paso). Usado desde «Guardar» por opción y desde «Guardar paso» en lote.
   */
  async function persistOptionCore(
    live: FlowNode,
    liveOpt: FlowNodeOption,
    opts: { toastSuccess: boolean; reason?: string }
  ) {
    const nextCode = liveOpt.next_node_code?.trim() || null;
    if ((live.node_type === "buttons" || live.node_type === "list") && !nextCode) {
      const msg =
        "Elegí un paso destino en «Va a» antes de guardar. Sin siguiente paso el botón no puede continuar el flujo.";
      setOptionSaveError((prev) => ({ ...prev, [liveOpt.id]: msg }));
      throw new Error(msg);
    }
    setOptionSaveError((prev) => {
      const next = { ...prev };
      delete next[liveOpt.id];
      return next;
    });
    const mode = optionEditorMode[liveOpt.id] ?? "simple";
    const finalizeOn = Boolean(flowSorteoId && optionFinalizeSorteo[liveOpt.id]);

    let payloadParsed: Record<string, unknown> = {};
    if (mode === "advanced") {
      const payloadDraft = optionPayloadDrafts[liveOpt.id] ?? stringifyOptionPayload(liveOpt.option_payload);
      try {
        const parsed = JSON.parse(payloadDraft) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("El payload debe ser un objeto JSON");
        }
        const base = stripSorteoFinalizeKeys(parsed as Record<string, unknown>);
        payloadParsed = finalizeOn ? { ...base, confirmar_orden_sorteo: true } : base;
      } catch {
        throw new Error("Variables JSON inválidas para esta opción.");
      }
    } else if (finalizeOn) {
      payloadParsed = { confirmar_orden_sorteo: true };
      setOptionPayloadDrafts((prev) => ({ ...prev, [liveOpt.id]: stringifyOptionPayload(payloadParsed) }));
    } else {
      const draft = optionSimpleDrafts[liveOpt.id] ?? toSimpleDraftFromPayload(liveOpt);
      payloadParsed = stripSorteoFinalizeKeys(buildPayloadFromSimple(liveOpt.option_payload, draft));
      setOptionPayloadDrafts((prev) => ({ ...prev, [liveOpt.id]: stringifyOptionPayload(payloadParsed) }));
    }

    const buttonLabel = liveOpt.label.trim().slice(0, 500);
    if (!buttonLabel) {
      throw new Error('Completá «Texto del botón» (o texto de la opción en lista) antes de guardar.');
    }

    const metaButtonId = resolveUniqueMetaButtonId(live, liveOpt.id, buttonLabel);

    const refNode = nodesRef.current.find((n) => n.id === live.id) ?? live;
    const mergedOptionsForValidate = refNode.options.map((o) => {
      if (o.id !== liveOpt.id) return o;
      return {
        ...o,
        label: buttonLabel,
        meta_button_id: metaButtonId,
        next_node_code: nextCode,
        sort_order: liveOpt.sort_order,
        group_title: liveOpt.group_title ?? null,
        group_order: liveOpt.group_order ?? 0,
        option_payload: payloadParsed,
      };
    });
    const groupValErr = validateButtonsQuickReplyGroups({ ...refNode, options: mergedOptionsForValidate });
    if (groupValErr) {
      setOptionSaveError((prev) => ({ ...prev, [liveOpt.id]: groupValErr }));
      throw new Error(groupValErr);
    }

    const patchBody = {
      label: buttonLabel,
      meta_button_id: metaButtonId,
      next_node_code: nextCode,
      sort_order: liveOpt.sort_order,
      option_payload: payloadParsed,
      ...(live.node_type === "buttons"
        ? {
            group_title: (liveOpt.group_title ?? "").trim() || null,
            group_order: Math.trunc(Number(liveOpt.group_order ?? 0)),
          }
        : {}),
    };
    console.info("[flow-save]", "patch_chat_flow_option", {
      flowCode,
      node_code: live.node_code,
      option_id: liveOpt.id,
      reason: opts.reason ?? "single_option",
      body: patchBody,
      label_from_ref: buttonLabel,
    });
    console.info("[flow-editor]", "save_option_before_fetch", {
      option_id: liveOpt.id,
      texto_boton_snapshot: buttonLabel,
    });
    const res = await fetchWithSupabaseSession(
      `/api/chat/flows/${encodeURIComponent(flowCode)}/nodes/${encodeURIComponent(live.node_code)}/options/${liveOpt.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(patchBody),
      }
    );
    const json = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      item?: FlowNodeOption;
    };
    if (!res.ok || !json.ok) throw new Error(json.error ?? "No se pudo guardar opción");
    console.info("[flow-save]", "patch_chat_flow_option_response", {
      option_id: liveOpt.id,
      item_label: json.item?.label,
      item_opcion_label:
        json.item?.option_payload &&
        typeof json.item.option_payload === "object" &&
        json.item.option_payload !== null &&
        "opcion_label" in json.item.option_payload
          ? (json.item.option_payload as Record<string, unknown>).opcion_label
          : undefined,
    });
    if (json.item?.id === liveOpt.id) {
      const incoming = json.item as Partial<FlowNodeOption>;
      const mergedAfterSave = mergeSavedFlowOption(liveOpt, incoming);
      setNodes((prev) =>
        prev.map((n) =>
          n.id !== live.id
            ? n
            : {
                ...n,
                options: n.options.map((o) =>
                  o.id === liveOpt.id ? mergeSavedFlowOption(o, incoming) : o
                ),
              }
        )
      );
      setOptionSimpleDrafts((prev) => ({
        ...prev,
        [liveOpt.id]: toSimpleDraftFromPayload(mergedAfterSave),
      }));
    }
    setError(null);
    if (opts.toastSuccess) {
      setSuccess(`Botón "${buttonLabel}" guardado.`);
    }
  }

  async function saveOption(node: FlowNode, opt: FlowNodeOption) {
    setSuccess(null);
    const live = nodesRef.current.find((n) => n.id === node.id);
    const liveOpt = live?.options.find((o) => o.id === opt.id);
    if (!live || !liveOpt) {
      throw new Error("No se encontró la opción en el editor. Recargá la página.");
    }
    await persistOptionCore(live, liveOpt, { toastSuccess: true, reason: "guardar_opcion" });
  }

  async function createOption(node: FlowNode, ctx: FlowOptionCreateContext = { kind: "default" }) {
    const live = nodesRef.current.find((n) => n.id === node.id) ?? node;

    if (live.node_type === "list" && live.options.length >= 10) {
      throw new Error(
        "WhatsApp admite como máximo 10 filas en mensaje de lista. Eliminá una opción antes de agregar otra."
      );
    }
    if (live.node_type === "buttons" && live.options.length >= 30) {
      throw new Error(
        "Límite de 30 opciones por nodo de botones. Si usás grupos, cada burbuja lleva hasta 3 botones rápidos."
      );
    }

    const maxGlobalSort = live.options.reduce((m, o) => Math.max(m, o.sort_order ?? 0), 0);

    let sortOrder = maxGlobalSort + 1;
    let nextNodeCode: string | null = null;
    let groupTitleOut: string | null | undefined = undefined;
    let groupOrderOut: number | undefined = undefined;

    if (ctx.kind === "in_group") {
      const anchor = live.options.find((o) => o.id === ctx.anchorOptionId);
      if (!anchor) throw new Error("No se encontró la opción de referencia del grupo.");
      const gt = (anchor.group_title ?? "").trim();
      const go = anchor.group_order ?? 0;
      const peers = live.options.filter(
        (o) => (o.group_order ?? 0) === go && (o.group_title ?? "").trim() === gt
      );
      const maxPeer = peers.reduce((m, o) => Math.max(m, o.sort_order ?? 0), 0);
      sortOrder = Math.max(maxGlobalSort + 1, maxPeer + 1);
      nextNodeCode = anchor.next_node_code?.trim() || null;
      groupTitleOut = gt.length ? anchor.group_title ?? null : null;
      groupOrderOut = go;
    } else if (ctx.kind === "new_group") {
      const maxGo = live.options.reduce((m, o) => Math.max(m, o.group_order ?? 0), 0);
      groupTitleOut = "Nuevo grupo";
      groupOrderOut = maxGo + 1;
      nextNodeCode = null;
      sortOrder = maxGlobalSort + 1;
    } else if (ctx.kind === "ungrouped") {
      groupTitleOut = null;
      groupOrderOut = 0;
      nextNodeCode = null;
      sortOrder = maxGlobalSort + 1;
    } else {
      nextNodeCode = null;
      sortOrder = maxGlobalSort + 1;
    }

    const uniqueSuffix =
      typeof globalThis.crypto !== "undefined" && globalThis.crypto.randomUUID
        ? globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 12)
        : `${Date.now().toString(36)}`;
    const metaButtonId = `opt_${sortOrder}_${uniqueSuffix}`;
    const label =
      ctx.kind === "new_group" ? "Nuevo botón" : sortOrder <= 1 ? "Nueva opción" : `Nueva opción ${sortOrder}`;

    const body: Record<string, unknown> = {
      label,
      meta_button_id: metaButtonId,
      next_node_code: nextNodeCode,
      sort_order: sortOrder,
      option_payload: {},
    };
    if (ctx.kind === "in_group" || ctx.kind === "new_group") {
      body.group_title = groupTitleOut ?? null;
      body.group_order = groupOrderOut ?? 0;
    } else if (ctx.kind === "ungrouped") {
      body.group_title = null;
      body.group_order = 0;
    }

    const res = await fetchWithSupabaseSession(
      `/api/chat/flows/${encodeURIComponent(flowCode)}/nodes/${encodeURIComponent(live.node_code)}/options`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(body),
      }
    );
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!res.ok || !json.ok) throw new Error(json.error ?? "No se pudo crear opción");
    setSuccess(`Opción creada en ${prettifyCode(live.node_code)}.`);
  }

  async function createBlock(node: FlowNode, blockType: FlowNodeBlock["block_type"]): Promise<FlowNodeBlock | null> {
    const res = await fetchWithSupabaseSession(
      `/api/chat/flows/${encodeURIComponent(flowCode)}/nodes/${encodeURIComponent(node.node_code)}/blocks`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          block_type: blockType,
          content_text: blockType === "text" ? "Nuevo texto" : blockType === "buttons" ? "Elegí una opción" : null,
          media_url: null,
          sort_order: node.blocks.length + 1,
        }),
      }
    );
    const raw = await res.text();
    let json: { ok?: boolean; error?: string; item?: FlowNodeBlock } = {};
    try {
      json = raw ? (JSON.parse(raw) as typeof json) : {};
    } catch {
      throw new Error(raw.trim().slice(0, 280) || `Respuesta inválida del servidor (HTTP ${res.status}).`);
    }
    if (!res.ok || !json.ok) throw new Error(json.error ?? `No se pudo crear bloque (HTTP ${res.status}).`);
    return json.item ?? null;
  }

  async function saveBlock(node: FlowNode, block: FlowNodeBlock) {
    const res = await fetchWithSupabaseSession(
      `/api/chat/flows/${encodeURIComponent(flowCode)}/nodes/${encodeURIComponent(node.node_code)}/blocks/${block.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          block_type: block.block_type,
          content_text: block.content_text,
          media_url: block.media_url,
          sort_order: block.sort_order,
        }),
      }
    );
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!res.ok || !json.ok) throw new Error(json.error ?? "No se pudo guardar bloque");
  }

  async function deleteBlock(node: FlowNode, blockId: string) {
    const res = await fetchWithSupabaseSession(
      `/api/chat/flows/${encodeURIComponent(flowCode)}/nodes/${encodeURIComponent(node.node_code)}/blocks/${blockId}`,
      { method: "DELETE", credentials: "same-origin" }
    );
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!res.ok || !json.ok) throw new Error(json.error ?? "No se pudo eliminar bloque");
  }

  async function uploadImage(file: File): Promise<string> {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetchWithSupabaseSession("/api/chat/flow-media/upload", {
      method: "POST",
      body: fd,
      credentials: "same-origin",
    });
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; media_url?: string };
    if (!res.ok || !json.ok || !json.media_url) throw new Error(json.error ?? "No se pudo subir imagen");
    return json.media_url;
  }

  async function deleteOption(node: FlowNode, optionId: string) {
    setError(null);
    setSuccess(null);
    console.info("[flow-editor]", "delete_option_request", {
      flowCode,
      node_code: node.node_code,
      optionId,
    });
    const res = await fetchWithSupabaseSession(
      `/api/chat/flows/${encodeURIComponent(flowCode)}/nodes/${encodeURIComponent(node.node_code)}/options/${encodeURIComponent(optionId)}`,
      { method: "DELETE", credentials: "same-origin" }
    );
    const raw = await res.text();
    let json = {} as { ok?: boolean; error?: string };
    try {
      json = raw ? (JSON.parse(raw) as typeof json) : {};
    } catch {
      throw new Error(raw.trim().slice(0, 220) || `HTTP ${res.status}`);
    }
    if (!res.ok || !json.ok) {
      const msg = json.error ?? `No se pudo eliminar la opción (HTTP ${res.status}).`;
      console.warn("[flow-editor]", "delete_option_failed", { status: res.status, msg });
      throw new Error(msg);
    }
    console.info("[flow-editor]", "delete_option_ok", { optionId });
    setSuccess("Opción eliminada.");
  }

  async function deleteNode(node: FlowNode) {
    if (
      !globalThis.confirm(
        `¿Eliminar el paso «${node.node_code}»? Las opciones y bloques de este paso se borrarán. No se puede deshacer.`
      )
    ) {
      return;
    }
    setError(null);
    setSuccess(null);
    setDeletingNodeId(node.id);
    try {
      const res = await fetchWithSupabaseSession(
        `/api/chat/flows/${encodeURIComponent(flowCode)}/nodes/${encodeURIComponent(node.node_code)}`,
        { method: "DELETE", credentials: "same-origin" }
      );
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        references?: {
          fromNodes?: { node_code: string }[];
          fromOptions?: { parent_node_code: string; label: string }[];
        };
      };
      if (res.status === 409 && json.references) {
        const parts: string[] = [json.error ?? "Hay referencias a este paso."];
        for (const r of json.references.fromNodes ?? []) {
          parts.push(`• Paso «${r.node_code}» lo tiene como siguiente paso.`);
        }
        for (const r of json.references.fromOptions ?? []) {
          parts.push(
            `• Botón/lista «${r.label}» en «${r.parent_node_code}» apunta a este paso.`
          );
        }
        setError(parts.join("\n"));
        return;
      }
      if (!res.ok || !json.ok) throw new Error(json.error ?? "No se pudo eliminar el paso");
      setExpandedNodeId((prev) => (prev === node.id ? null : prev));
      setSuccess(`Paso «${node.node_code}» eliminado.`);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al eliminar paso");
    } finally {
      setDeletingNodeId(null);
    }
  }

  async function applyNodeReorder(dragId: string, targetId: string) {
    if (dragId === targetId) return;
    const sorted = [...nodes].sort(compareFlowNodes);
    const from = sorted.findIndex((n) => n.id === dragId);
    const to = sorted.findIndex((n) => n.id === targetId);
    if (from < 0 || to < 0) return;
    const nextOrder = [...sorted];
    const [moved] = nextOrder.splice(from, 1);
    nextOrder.splice(to, 0, moved);

    setReorderBusy(true);
    setError(null);
    setSuccess(null);
    try {
      for (let i = 0; i < nextOrder.length; i++) {
        const n = nextOrder[i];
        const sortOrder = i + 1;
        if (n.sort_order === sortOrder) continue;
        const res = await fetchWithSupabaseSession(
          `/api/chat/flows/${encodeURIComponent(flowCode)}/nodes/${encodeURIComponent(n.node_code)}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify({ sort_order: sortOrder }),
          }
        );
        const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
        if (!res.ok || !json.ok) throw new Error(json.error ?? "No se pudo guardar el orden");
      }
      setSuccess("Orden de pasos actualizado (solo visualización en el editor; los enlaces del flujo no cambian).");
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al reordenar");
      await reload();
    } finally {
      setReorderBusy(false);
    }
  }

  async function submitInsertBetween() {
    if (!insertModal) return;
    const trimmedCode = insertDraft.node_code.trim();
    if (!trimmedCode) {
      setError("Escribí el código interno del nuevo paso.");
      return;
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(trimmedCode)) {
      setError("El código solo puede tener letras, números, guion y guion bajo.");
      return;
    }
    setInsertBusy(true);
    setError(null);
    try {
      const res = await fetchWithSupabaseSession(
        `/api/chat/flows/${encodeURIComponent(flowCode)}/nodes/insert-between`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            sourceType: insertModal.sourceType,
            sourceNodeCode: insertModal.sourceNodeCode,
            sourceOptionId: insertModal.sourceOptionId,
            newNode: {
              node_code: trimmedCode,
              node_type: insertDraft.node_type,
              message_text: insertDraft.message_text.trim() || null,
              save_as_field: insertDraft.save_as_field.trim() || null,
            },
          }),
        }
      );
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) throw new Error(json.error ?? "No se pudo insertar el paso");
      setInsertModal(null);
      setInsertDraft({ node_code: "", node_type: "text", message_text: "", save_as_field: "" });
      await reload({ soft: true });
      setSuccess(`Paso «${prettifyCode(trimmedCode)}» insertado y enlazado en el grafo.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al insertar paso");
    } finally {
      setInsertBusy(false);
    }
  }

  async function patchNodeNextCodeOnly(node: FlowNode, nextCode: string | null) {
    const res = await fetchWithSupabaseSession(
      `/api/chat/flows/${encodeURIComponent(flowCode)}/nodes/${encodeURIComponent(node.node_code)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ next_node_code: nextCode }),
      }
    );
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!res.ok || !json.ok) throw new Error(json.error ?? "No se pudo actualizar el siguiente paso");
  }

  async function applyChangeNextModal() {
    if (!changeNextModal) return;
    const nextTrim = changeNextValue.trim();
    const nextCode = nextTrim.length === 0 ? null : nextTrim;
    setChangeNextBusy(true);
    setError(null);
    try {
      if (changeNextModal.kind === "node") {
        const node = nodes.find((n) => n.id === changeNextModal.nodeId);
        if (!node) throw new Error("Paso no encontrado");
        await patchNodeNextCodeOnly(node, nextCode);
      } else {
        const node = nodes.find((n) => n.id === changeNextModal.nodeId);
        const opt = node?.options.find((o) => o.id === changeNextModal.optionId);
        if (!node || !opt) throw new Error("Opción no encontrada");
        if ((node.node_type === "buttons" || node.node_type === "list") && !nextCode) {
          throw new Error("Elegí un destino para esta opción.");
        }
        const patchedOpt: FlowNodeOption = { ...opt, next_node_code: nextCode };
        const liveNode: FlowNode = {
          ...node,
          options: node.options.map((o) => (o.id === opt.id ? patchedOpt : o)),
        };
        await persistOptionCore(liveNode, patchedOpt, {
          toastSuccess: false,
          reason: "change_next_modal",
        });
      }
      setChangeNextModal(null);
      await reload({ soft: true });
      setSuccess("Destino actualizado.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al cambiar destino");
    } finally {
      setChangeNextBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap justify-between gap-3 items-start">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Editor de flujo conversacional</h1>
          <p className="text-sm text-slate-500 font-mono mt-0.5">{flowCode}</p>
        </div>
        <Link
          href="/configuracion/conversaciones/flujos"
          className="text-sm font-medium text-[#4FAEB2] hover:underline px-3 py-2 rounded-lg border border-[#4FAEB2]/30 bg-[#4FAEB2]/10"
        >
          Volver a Configuración de Flujos
        </Link>
      </div>

      <div className="flex flex-wrap gap-2 border-b border-slate-200 pb-2">
        <button
          type="button"
          onClick={() => setEditorTab("pasos")}
          className={`px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${
            editorTab === "pasos"
              ? "bg-[#4FAEB2] text-white border-[#4FAEB2]"
              : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50"
          }`}
        >
          Pasos del flujo
        </button>
        <button
          type="button"
          onClick={() => setEditorTab("automatizaciones")}
          className={`px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${
            editorTab === "automatizaciones"
              ? "bg-[#4FAEB2] text-white border-[#4FAEB2]"
              : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50"
          }`}
        >
          Automatizaciones
        </button>
      </div>

      {error && (
        <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-4 py-2 whitespace-pre-wrap">
          {error}
        </div>
      )}
      {success && <div className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-2">{success}</div>}

      {editorTab === "pasos" && (
        <>
      {graphWarnings.length > 0 && (
        <div className="text-sm text-amber-900 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 space-y-2">
          <div className="font-medium">Advertencias del grafo (no bloquean guardado)</div>
          <ul className="list-disc pl-5 space-y-1">
            {graphWarnings.map((w, i) => (
              <li key={`${w.code}-${i}`}>{w.message}</li>
            ))}
          </ul>
        </div>
      )}

      <form onSubmit={createNode} className="bg-white border border-slate-200 rounded-xl p-4 flex flex-wrap gap-3 items-end shadow-sm">
        <div className="flex-1 min-w-[180px]">
          <label className="block text-xs text-slate-500 mb-1">Nombre del paso (código interno)</label>
          <input className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm" value={newNodeCode} onChange={(e) => setNewNodeCode(e.target.value)} placeholder="ej: datos_pago" />
        </div>
        <div className="min-w-[180px]">
          <label className="block text-xs text-slate-500 mb-1">Tipo de nodo</label>
          <select className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm" value={newNodeType} onChange={(e) => setNewNodeType(e.target.value)}>
            {NODE_TYPE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
        <button
          type="submit"
          disabled={creatingNode}
          className="bg-[#4FAEB2] hover:bg-[#3F8E91] disabled:opacity-60 text-white px-4 py-2 rounded-lg text-sm font-medium"
        >
          {creatingNode ? "Creando..." : "Crear nodo"}
        </button>
      </form>

      {loading ? (
        <div className="p-6 text-sm text-slate-400 animate-pulse">Cargando nodos...</div>
      ) : (
        <div className="space-y-4">
          {orderedNodes.map((node, idx) => {
            const isExpanded = expandedNodeId === node.id;
            const editorFlowOptions = sortOptionsStableForEditor(node);
            const showGroupedButtonUi =
              node.node_type === "buttons" &&
              buttonQuickReplyGroupsEnabled(
                node.options.map((o) => ({
                  id: o.id,
                  label: o.label,
                  option_value: o.option_value,
                  meta_button_id: o.meta_button_id,
                  next_node_code: o.next_node_code,
                  sort_order: o.sort_order,
                  group_title: o.group_title ?? null,
                  group_order: o.group_order ?? 0,
                }))
              );
            return (
            <div
              key={node.id}
              className={`bg-white border border-slate-200 border-l-4 ${nodeAccent(node.node_type)} rounded-xl p-4 space-y-3 shadow-sm`}
              onDragOver={(e) => {
                if (reorderBusy) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
              }}
              onDrop={(e) => {
                if (reorderBusy) return;
                e.preventDefault();
                const id =
                  e.dataTransfer.getData("text/plain") ||
                  e.dataTransfer.getData("application/x-neura-node-id");
                if (id) void applyNodeReorder(id, node.id);
              }}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-start gap-2 min-w-0 flex-1">
                  <button
                    type="button"
                    draggable={!reorderBusy}
                    onDragStart={(e) => {
                      e.dataTransfer.setData("text/plain", node.id);
                      e.dataTransfer.setData("application/x-neura-node-id", node.id);
                      e.dataTransfer.effectAllowed = "move";
                    }}
                    className="shrink-0 cursor-grab active:cursor-grabbing text-slate-400 hover:text-slate-600 p-1 rounded border border-transparent hover:border-slate-200 mt-0.5"
                    title="Arrastrar para reordenar (solo orden en el editor; no cambia enlaces del flujo)"
                    aria-label="Arrastrar para reordenar pasos"
                  >
                    <GripVertical className="w-4 h-4" aria-hidden />
                  </button>
                  <div className="min-w-0">
                  <div className="text-sm font-semibold text-slate-800">Paso #{idx + 1}: {friendlyNodeTitle(node)}</div>
                  <div className="text-xs text-slate-500">Tipo: {nodeTypeLabel(node.node_type)} · {nodeTypeHelp(node.node_type)}</div>
                  {lastSavedNodeId === node.id && (
                    <div className="text-xs text-emerald-600 mt-1">Guardado correctamente.</div>
                  )}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2 shrink-0 justify-end">
                  <label className="text-sm text-slate-700 flex items-center gap-2">
                    <input type="checkbox" checked={node.is_active} onChange={(e) => setNodes((prev) => prev.map((n) => n.id === node.id ? { ...n, is_active: e.target.checked } : n))} />
                    Activo
                  </label>
                  {node.node_type !== "buttons" && node.node_type !== "list" && (
                    <button
                      type="button"
                      className="text-xs px-2 py-1 rounded-md border border-[#4FAEB2]/30 bg-[#4FAEB2]/10 text-[#3F8E91] hover:bg-[#4FAEB2]/20"
                      title="Inserta un paso después del actual y antes de su siguiente destino"
                      onClick={() => {
                        setInsertDraft({ node_code: "", node_type: "text", message_text: "", save_as_field: "" });
                        setInsertModal({ sourceType: "node", sourceNodeCode: node.node_code });
                      }}
                    >
                      Insertar después
                    </button>
                  )}
                  {node.node_type !== "buttons" && node.node_type !== "list" && (
                    <button
                      type="button"
                      className="text-xs px-2 py-1 rounded-md border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                      onClick={() => {
                        setChangeNextValue(node.next_node_code ?? "");
                        setChangeNextModal({ kind: "node", nodeId: node.id });
                      }}
                    >
                      Cambiar siguiente
                    </button>
                  )}
                  {(node.node_type === "buttons" || node.node_type === "list") && (
                    <span className="text-[11px] text-slate-500 max-w-[11rem] leading-tight" title="Para pasos con botones o lista, insertá desde cada fila de opción.">
                      Insertá desde cada opción ↓
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => setExpandedNodeId((prev) => (prev === node.id ? null : node.id))}
                    className="text-xs text-[#4FAEB2] hover:underline"
                  >
                    {isExpanded ? "Cerrar edición" : "Editar"}
                  </button>
                  <button
                    type="button"
                    onClick={() => void deleteNode(node)}
                    disabled={deletingNodeId === node.id || reorderBusy}
                    className="p-2 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 disabled:opacity-40"
                    title="Eliminar paso"
                    aria-label={`Eliminar paso ${node.node_code}`}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {!isExpanded && (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
                  <div className="bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
                    <div className="text-[11px] uppercase text-slate-500">Nombre del paso</div>
                    <div className="font-mono text-slate-800">{node.node_code}</div>
                  </div>
                  <div className="bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
                    <div className="text-[11px] uppercase text-slate-500">Tipo</div>
                    <div className="text-slate-800">{nodeTypeLabel(node.node_type)}</div>
                  </div>
                  <div className="bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
                    <div className="text-[11px] uppercase text-slate-500">Siguiente paso</div>
                    <div className="text-slate-800">{nextStepLabel(node.next_node_code)}</div>
                  </div>
                  <div className="md:col-span-3 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
                    <div className="text-[11px] uppercase text-slate-500">Llega desde</div>
                    <div className="text-slate-700">
                      {getIncomingLabels(node.node_code).length
                        ? getIncomingLabels(node.node_code).join(" · ")
                        : "Nodo inicial o sin referencias previas"}
                    </div>
                  </div>
                </div>
              )}

              {isExpanded && (
              <>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs text-slate-500 mb-1">Nombre del paso</label>
                  <input className="border border-slate-200 rounded-lg px-3 py-2 text-sm font-mono w-full" value={node.node_code} readOnly />
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1">Tipo de nodo</label>
                  <select className="border border-slate-200 rounded-lg px-3 py-2 text-sm w-full" value={node.node_type} onChange={(e) => setNodes((prev) => prev.map((n) => n.id === node.id ? { ...n, node_type: e.target.value } : n))}>
                    {NODE_TYPE_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1">Siguiente paso</label>
                  <select className="border border-slate-200 rounded-lg px-3 py-2 text-sm w-full" value={node.next_node_code ?? ""} onChange={(e) => setNodes((prev) => prev.map((n) => n.id === node.id ? { ...n, next_node_code: e.target.value || null } : n))}>
                    <option value="">(finaliza en este paso)</option>
                    {nodeCodes.filter((code) => code !== node.node_code).map((code) => (
                      <option key={code} value={code}>{nextStepLabel(code)}</option>
                    ))}
                  </select>
                </div>
              </div>

              {node.node_type === "image_input" && (
                <div className="rounded-lg border border-violet-200 bg-violet-50/80 px-3 py-2 text-xs text-violet-900 space-y-1">
                  <div className="font-semibold">Solicitar imagen (comprobante)</div>
                  <p>
                    Usá el mensaje de abajo para pedir la imagen. En «Opciones avanzadas», completá{" "}
                    <span className="font-medium">Guardar respuesta como</span> (recomendado:{" "}
                    <code className="bg-violet-100 px-1 rounded">comprobante_pago</code>) y elegí el{" "}
                    <span className="font-medium">Siguiente paso</span>. El flujo avanza solo cuando llega una imagen válida; si mandan texto u otro tipo de archivo, el bot responde pidiendo imagen.
                  </p>
                </div>
              )}

              {node.node_type !== "media" && (
                <div>
                  <label className="block text-xs text-slate-500 mb-1">Mensaje al cliente (compatibilidad)</label>
                  <textarea
                    className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm min-h-[74px]"
                    placeholder={
                      node.node_type === "image_input"
                        ? "Ej: Por favor envianos una foto o captura de tu comprobante de pago."
                        : "Se usa solo en nodos sin bloques configurados"
                    }
                    value={node.message_text ?? ""}
                    onChange={(e) => setNodes((prev) => prev.map((n) => n.id === node.id ? { ...n, message_text: e.target.value } : n))}
                  />
                  <p className="text-[11px] text-slate-500 mt-1">
                    Podés usar placeholders del contexto, por ejemplo: {"{{producto}}"}, {"{{cantidad}}"}, {"{{monto}}"}.
                  </p>
                  {hasSelectableContext(node.node_code) && (
                    <div className="mt-2 border border-sky-100 bg-sky-50/60 rounded-lg p-2 space-y-2">
                      <div className="text-xs font-medium text-sky-800">
                        Usar datos de la selección anterior
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {CONTEXT_VAR_KEYS.map((key) => (
                          <button
                            key={`${node.id}-${key}`}
                            type="button"
                            className="text-xs px-2 py-1 rounded border border-sky-200 text-sky-700 hover:bg-sky-100"
                            onClick={() => appendPlaceholderToNodeMessage(node.id, key)}
                          >
                            Insertar {key}
                          </button>
                        ))}
                        <button
                          type="button"
                          className="text-xs px-2 py-1 rounded border border-sky-300 text-sky-900 hover:bg-sky-100 font-medium"
                          onClick={() =>
                            setNodes((prev) =>
                              prev.map((n) =>
                                n.id !== node.id
                                  ? n
                                  : {
                                      ...n,
                                      message_text: `Resumen de tu compra:\n\n• Opción elegida: {{opcion_label}}\n• Cantidad: {{cantidad}}\n• Producto: {{producto}}\n• Total: {{monto}} Gs`,
                                    }
                              )
                            )
                          }
                        >
                          Insertar resumen de compra
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {node.node_type === "media" && (
                <div className="border border-fuchsia-100 rounded-lg p-4 space-y-3 bg-white shadow-sm ring-1 ring-fuchsia-100/80">
                  <div className="text-sm font-semibold text-fuchsia-800">Mensaje con imagen</div>
                  <p className="text-xs text-slate-600">
                    WhatsApp envía una sola burbuja: imagen arriba y texto opcional debajo (caption).
                  </p>
                  {getImageBlock(node) ? (
                    (() => {
                      const mediaBlock = getImageBlock(node)!;
                      return (
                        <div className="space-y-2">
                          <label className="block text-xs text-slate-500 mb-1">Imagen / URL de imagen</label>
                          <input
                            type="file"
                            accept="image/*"
                            onChange={async (e) => {
                              try {
                                const file = e.target.files?.[0];
                                if (!file) return;
                                const mediaUrl = await uploadImage(file);
                                setNodes((prev) =>
                                  prev.map((n) =>
                                    n.id !== node.id
                                      ? n
                                      : {
                                          ...n,
                                          blocks: n.blocks.map((b) =>
                                            b.id === mediaBlock.id ? { ...b, media_url: mediaUrl } : b
                                          ),
                                        }
                                  )
                                );
                              } catch (err) {
                                setError(err instanceof Error ? err.message : "No se pudo subir imagen");
                              } finally {
                                e.target.value = "";
                              }
                            }}
                            className="text-xs"
                          />
                          <input
                            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
                            value={mediaBlock.media_url ?? ""}
                            placeholder="https://..."
                            onChange={(e) =>
                              setNodes((prev) =>
                                prev.map((n) =>
                                  n.id !== node.id
                                    ? n
                                    : {
                                        ...n,
                                        blocks: n.blocks.map((b) =>
                                          b.id === mediaBlock.id ? { ...b, media_url: e.target.value } : b
                                        ),
                                      }
                                )
                              )
                            }
                          />
                          {!!mediaBlock.media_url && !isValidHttpUrl(mediaBlock.media_url) && (
                            <div className="text-[11px] text-red-600">La URL debe iniciar con http:// o https://</div>
                          )}

                          <label className="block text-xs text-slate-500 mb-1 mt-2">Texto del mensaje (opcional)</label>
                          <textarea
                            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm min-h-[70px]"
                            value={mediaBlock.content_text ?? ""}
                            placeholder="Escribí un texto opcional para mostrar debajo de la imagen"
                            onChange={(e) =>
                              setNodes((prev) =>
                                prev.map((n) =>
                                  n.id !== node.id
                                    ? n
                                    : {
                                        ...n,
                                        blocks: n.blocks.map((b) =>
                                          b.id === mediaBlock.id ? { ...b, content_text: e.target.value } : b
                                        ),
                                      }
                                )
                              )
                            }
                          />
                          {hasSelectableContext(node.node_code) && (
                            <div className="flex flex-wrap gap-2">
                              {CONTEXT_VAR_KEYS.map((key) => (
                                <button
                                  key={`${mediaBlock.id}-${key}`}
                                  type="button"
                                  className="text-xs px-2 py-1 rounded border border-fuchsia-200 text-fuchsia-700 hover:bg-fuchsia-100"
                                  onClick={() =>
                                    setNodes((prev) =>
                                      prev.map((n) =>
                                        n.id !== node.id
                                          ? n
                                          : {
                                              ...n,
                                              blocks: n.blocks.map((b) =>
                                                b.id !== mediaBlock.id
                                                  ? b
                                                  : {
                                                      ...b,
                                                      content_text: `${(b.content_text ?? "").trim()}\n{{${key}}}`.trim(),
                                                    }
                                              ),
                                            }
                                      )
                                    )
                                  }
                                >
                                  Insertar {key}
                                </button>
                              ))}
                            </div>
                          )}
                          <div className={`text-[11px] ${(mediaBlock.content_text ?? "").length > MAX_WHATSAPP_IMAGE_CAPTION ? "text-red-600" : "text-slate-500"}`}>
                            Texto: {(mediaBlock.content_text ?? "").length}/{MAX_WHATSAPP_IMAGE_CAPTION}
                          </div>
                          <p className="text-[11px] text-slate-500">
                            Este texto también acepta placeholders, por ejemplo {"{{opcion_label}}"} o {"{{monto}}"}.
                          </p>
                        </div>
                      );
                    })()
                  ) : (
                    <button
                      type="button"
                      disabled={creatingBlockKey === blockBusyKey(node.id, "image")}
                      className="inline-flex items-center rounded-lg bg-[#4FAEB2] px-4 py-2 text-sm font-medium text-white hover:bg-[#3F8E91] disabled:opacity-60 disabled:pointer-events-none"
                      onClick={async () => {
                        const busy = blockBusyKey(node.id, "image");
                        setError(null);
                        setCreatingBlockKey(busy);
                        try {
                          const item = await createBlock(node, "image");
                          if (item) {
                            setNodes((prev) =>
                              prev.map((n) => {
                                if (n.id !== node.id) return n;
                                const merged = [...n.blocks.filter((b) => b.id !== item.id), item].sort(
                                  (a, b) => a.sort_order - b.sort_order
                                );
                                return { ...n, blocks: merged };
                              })
                            );
                          }
                          await reload({ soft: true });
                          setSuccess("Podés pegar la URL, subir un archivo o escribir el texto debajo de la imagen.");
                        } catch (e) {
                          setError(e instanceof Error ? e.message : "Error al preparar mensaje con imagen");
                        } finally {
                          setCreatingBlockKey((k) => (k === busy ? null : k));
                        }
                      }}
                    >
                      {creatingBlockKey === blockBusyKey(node.id, "image")
                        ? "Preparando…"
                        : "Configurar imagen y texto"}
                    </button>
                  )}
                </div>
              )}

              <div className="text-sm text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
                Este paso va a → <span className="font-medium text-slate-800">{nextStepLabel(node.next_node_code)}</span>
              </div>
              <div className="text-sm text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
                Llega desde →{" "}
                <span className="font-medium text-slate-800">
                  {getIncomingLabels(node.node_code).length
                    ? getIncomingLabels(node.node_code).join(" · ")
                    : "Nodo inicial o sin referencias previas"}
                </span>
              </div>

              <div className="border border-slate-200 rounded-lg p-4 bg-slate-50/80 text-sm text-slate-700">
                {node.node_type === "media" ? (
                  (() => {
                    const mediaBlock = getImageBlock(node);
                    const mediaUrl = mediaBlock?.media_url?.trim() ?? "";
                    const validUrl = Boolean(mediaUrl && isValidHttpUrl(mediaUrl));
                    const caption = mediaBlock?.content_text?.trim() ?? "";
                    return (
                      <div className="space-y-2">
                        <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide">
                          Vista previa (como en WhatsApp)
                        </div>
                        {validUrl ? (
                          <div className="space-y-2">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={mediaUrl}
                              alt="Vista previa"
                              className="max-h-40 w-auto rounded-lg border border-slate-200 bg-white shadow-sm"
                            />
                            <p className="text-sm text-slate-800 whitespace-pre-wrap">
                              {caption || "Sin texto bajo la imagen"}
                            </p>
                          </div>
                        ) : (
                          <p className="text-sm text-slate-500 border border-dashed border-slate-200 rounded-lg px-3 py-3 bg-white/80">
                            {mediaBlock
                              ? "Pegá o subí una imagen con URL https válida en el recuadro de arriba para ver la previsualización."
                              : "Usá el botón «Configurar imagen y texto» y luego la URL o el archivo: la vista previa se actualiza con lo mismo que se envía al guardar el paso."}
                          </p>
                        )}
                      </div>
                    );
                  })()
                ) : (
                  <div>
                    <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Vista previa del mensaje</div>
                    {getTextPreview(node)}
                  </div>
                )}
              </div>

              <details className="border border-slate-100 rounded-lg p-3 bg-slate-50/60">
                <summary className="text-sm font-medium text-slate-700 cursor-pointer">Opciones avanzadas</summary>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-3">
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">Guardar respuesta como</label>
                    <input
                      className="border border-slate-200 rounded-lg px-3 py-2 text-sm w-full"
                      placeholder={
                        node.node_type === "image_input"
                          ? "ej: comprobante_pago (URL pública de la imagen)"
                          : "ej: nombre, cedula, ciudad"
                      }
                      value={node.save_as_field ?? ""}
                      onChange={(e) =>
                        setNodes((prev) =>
                          prev.map((n) =>
                            n.id === node.id ? { ...n, save_as_field: e.target.value || null } : n
                          )
                        )
                      }
                    />
                    {node.node_type === "image_input" && (
                      <p className="text-[11px] text-slate-500 mt-1">
                        Opcional pero recomendado: sin nombre de campo no se guarda en datos del flujo (el avance al siguiente paso igual ocurre).
                      </p>
                    )}
                  </div>
                  <div className="md:col-span-2">
                    <label className="block text-xs text-slate-500 mb-1">Acción en CRM (opcional)</label>
                    <input className="border border-slate-200 rounded-lg px-3 py-2 text-sm w-full" placeholder="ej: create_lead, move_funnel_stage, assign_advisor" value={node.crm_action_type ?? ""} onChange={(e) => setNodes((prev) => prev.map((n) => n.id === node.id ? { ...n, crm_action_type: e.target.value || null } : n))} />
                  </div>
                </div>
              </details>

              {node.node_type !== "media" && (
              <div className="border border-slate-100 rounded-lg p-3 space-y-3 bg-slate-50/60">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs font-semibold text-slate-600 uppercase">
                    {node.node_type === "media" ? "Bloque de imagen saliente" : "Bloques del mensaje"}
                  </div>
                  <div className="flex gap-2">
                    {node.node_type !== "media" && (
                      <button
                        type="button"
                        disabled={creatingBlockKey === blockBusyKey(node.id, "text")}
                        className="text-xs text-[#4FAEB2] hover:underline disabled:opacity-50"
                        onClick={async () => {
                          const busy = blockBusyKey(node.id, "text");
                          setCreatingBlockKey(busy);
                          try {
                            const item = await createBlock(node, "text");
                            if (item) {
                              setNodes((prev) =>
                                prev.map((n) => {
                                  if (n.id !== node.id) return n;
                                  const merged = [...n.blocks.filter((b) => b.id !== item.id), item].sort(
                                    (a, b) => a.sort_order - b.sort_order
                                  );
                                  return { ...n, blocks: merged };
                                })
                              );
                            }
                            await reload({ soft: true });
                          } catch (e) {
                            setError(e instanceof Error ? e.message : "Error");
                          } finally {
                            setCreatingBlockKey((k) => (k === busy ? null : k));
                          }
                        }}
                      >
                        + Texto
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={creatingBlockKey === blockBusyKey(node.id, "image")}
                      className="text-xs text-[#4FAEB2] hover:underline disabled:opacity-50"
                      onClick={async () => {
                        const busy = blockBusyKey(node.id, "image");
                        setCreatingBlockKey(busy);
                        try {
                          const item = await createBlock(node, "image");
                          if (item) {
                            setNodes((prev) =>
                              prev.map((n) => {
                                if (n.id !== node.id) return n;
                                const merged = [...n.blocks.filter((b) => b.id !== item.id), item].sort(
                                  (a, b) => a.sort_order - b.sort_order
                                );
                                return { ...n, blocks: merged };
                              })
                            );
                          }
                          await reload({ soft: true });
                        } catch (e) {
                          setError(e instanceof Error ? e.message : "Error");
                        } finally {
                          setCreatingBlockKey((k) => (k === busy ? null : k));
                        }
                      }}
                    >
                      + Imagen
                    </button>
                    {node.node_type !== "media" && (
                      <button
                        type="button"
                        disabled={creatingBlockKey === blockBusyKey(node.id, "buttons")}
                        className="text-xs text-[#4FAEB2] hover:underline disabled:opacity-50"
                        onClick={async () => {
                          const busy = blockBusyKey(node.id, "buttons");
                          setCreatingBlockKey(busy);
                          try {
                            const item = await createBlock(node, "buttons");
                            if (item) {
                              setNodes((prev) =>
                                prev.map((n) => {
                                  if (n.id !== node.id) return n;
                                  const merged = [...n.blocks.filter((b) => b.id !== item.id), item].sort(
                                    (a, b) => a.sort_order - b.sort_order
                                  );
                                  return { ...n, blocks: merged };
                                })
                              );
                            }
                            await reload({ soft: true });
                          } catch (e) {
                            setError(e instanceof Error ? e.message : "Error");
                          } finally {
                            setCreatingBlockKey((k) => (k === busy ? null : k));
                          }
                        }}
                      >
                        + Botones
                      </button>
                    )}
                  </div>
                </div>
                {node.blocks.length === 0 && (
                  <div className="text-xs text-slate-500">
                    {node.node_type === "media"
                      ? "Este nodo necesita un bloque de imagen con URL válida."
                      : "Sin bloques. Se usará el mensaje de compatibilidad."}
                  </div>
                )}
                {node.node_type === "media" && node.blocks.some((b) => b.block_type !== "image") && (
                  <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
                    Este nodo usa solo bloques de imagen; los demás bloques se ignoran en la vista.
                  </div>
                )}
                {(node.node_type === "media"
                  ? node.blocks.filter((b) => b.block_type === "image")
                  : node.blocks
                ).map((block, bi) => (
                  <div key={block.id} className="bg-white border border-slate-200 rounded-lg p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="text-xs text-slate-500">Bloque #{bi + 1} ({block.block_type})</div>
                      <div className="flex gap-2">
                        <button type="button" className="text-xs text-slate-600 hover:underline" disabled={bi === 0} onClick={async () => {
                          try {
                            const prev = node.blocks[bi - 1];
                            if (!prev) return;
                            await saveBlock(node, { ...block, sort_order: prev.sort_order });
                            await saveBlock(node, { ...prev, sort_order: block.sort_order });
                            await reload();
                          } catch (e) { setError(e instanceof Error ? e.message : "Error"); }
                        }}>↑</button>
                        <button type="button" className="text-xs text-slate-600 hover:underline" disabled={bi === node.blocks.length - 1} onClick={async () => {
                          try {
                            const next = node.blocks[bi + 1];
                            if (!next) return;
                            await saveBlock(node, { ...block, sort_order: next.sort_order });
                            await saveBlock(node, { ...next, sort_order: block.sort_order });
                            await reload();
                          } catch (e) { setError(e instanceof Error ? e.message : "Error"); }
                        }}>↓</button>
                        <button type="button" className="text-xs text-red-600 hover:underline" onClick={async () => {
                          try { await deleteBlock(node, block.id); await reload(); } catch (e) { setError(e instanceof Error ? e.message : "Error"); }
                        }}>Eliminar</button>
                      </div>
                    </div>
                    {block.block_type === "text" && (
                      <textarea
                        className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm min-h-[64px]"
                        value={block.content_text ?? ""}
                        placeholder="Texto del bloque"
                        onChange={(e) => setNodes((prev) => prev.map((n) => n.id !== node.id ? n : ({ ...n, blocks: n.blocks.map((b) => b.id === block.id ? { ...b, content_text: e.target.value } : b) })))}
                      />
                    )}
                    {block.block_type === "image" && (
                      <div className="space-y-2">
                        <p className="text-[11px] text-slate-500">
                          Podés subir una imagen o pegar una URL pública (http/https).
                        </p>
                        <input type="file" accept="image/*" onChange={async (e) => {
                          try {
                            const file = e.target.files?.[0];
                            if (!file) return;
                            const mediaUrl = await uploadImage(file);
                            setNodes((prev) => prev.map((n) => n.id !== node.id ? n : ({ ...n, blocks: n.blocks.map((b) => b.id === block.id ? { ...b, media_url: mediaUrl } : b) })));
                          } catch (err) {
                            setError(err instanceof Error ? err.message : "No se pudo subir imagen");
                          } finally {
                            e.target.value = "";
                          }
                        }} className="text-xs" />
                        <input
                          className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
                          value={block.media_url ?? ""}
                          placeholder="URL pública de imagen"
                          onChange={(e) => setNodes((prev) => prev.map((n) => n.id !== node.id ? n : ({ ...n, blocks: n.blocks.map((b) => b.id === block.id ? { ...b, media_url: e.target.value } : b) })))}
                        />
                        {!!block.media_url && !isValidHttpUrl(block.media_url) && (
                          <div className="text-[11px] text-red-600">La URL debe iniciar con http:// o https://</div>
                        )}
                        <input
                          className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
                          value={block.content_text ?? ""}
                          placeholder="Caption opcional"
                          onChange={(e) => setNodes((prev) => prev.map((n) => n.id !== node.id ? n : ({ ...n, blocks: n.blocks.map((b) => b.id === block.id ? { ...b, content_text: e.target.value } : b) })))}
                        />
                        <div className={`text-[11px] ${(block.content_text ?? "").length > MAX_WHATSAPP_IMAGE_CAPTION ? "text-red-600" : "text-slate-500"}`}>
                          Caption: {(block.content_text ?? "").length}/{MAX_WHATSAPP_IMAGE_CAPTION}
                        </div>
                        {block.media_url && <img src={block.media_url} alt="preview" className="max-h-40 rounded border border-slate-200" />}
                      </div>
                    )}
                    {block.block_type === "buttons" && (
                      <input
                        className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
                        value={block.content_text ?? ""}
                        placeholder="Texto arriba de los botones"
                        onChange={(e) => setNodes((prev) => prev.map((n) => n.id !== node.id ? n : ({ ...n, blocks: n.blocks.map((b) => b.id === block.id ? { ...b, content_text: e.target.value } : b) })))}
                      />
                    )}
                    <button type="button" className="text-xs text-[#4FAEB2] hover:underline" onClick={async () => {
                      try {
                        const latestNode = nodes.find((n) => n.id === node.id);
                        const latestBlock = latestNode?.blocks.find((b) => b.id === block.id);
                        if (!latestBlock) return;
                        if (latestBlock.block_type === "image") {
                          const mediaUrl = latestBlock.media_url?.trim() ?? "";
                          const caption = latestBlock.content_text?.trim() ?? "";
                          if (mediaUrl && !isValidHttpUrl(mediaUrl)) {
                            throw new Error("La URL de imagen debe ser http/https.");
                          }
                          if (caption.length > MAX_WHATSAPP_IMAGE_CAPTION) {
                            throw new Error(`El caption supera ${MAX_WHATSAPP_IMAGE_CAPTION} caracteres.`);
                          }
                        }
                        await saveBlock(node, latestBlock);
                        setSuccess("Bloque guardado.");
                        await reload();
                      } catch (e) {
                        setError(e instanceof Error ? e.message : "Error al guardar bloque");
                      }
                    }}>Guardar bloque</button>
                  </div>
                ))}
              </div>
              )}

              <button
                type="button"
                disabled={savingNodeId === node.id}
                onClick={async () => {
                  try {
                    setSavingNodeId(node.id);
                    await saveNode(node);
                    await reload();
                    setSuccess(`Paso ${prettifyCode(node.node_code)} guardado correctamente.`);
                    setLastSavedNodeId(node.id);
                    setExpandedNodeId(null);
                  } catch (e) {
                    setError(e instanceof Error ? e.message : "Error al guardar nodo");
                  } finally {
                    setSavingNodeId(null);
                  }
                }}
                className="bg-[#4FAEB2] hover:bg-[#3F8E91] disabled:opacity-60 text-white px-4 py-2 rounded-lg text-sm font-medium"
              >
                {savingNodeId === node.id ? "Guardando..." : "Guardar paso"}
              </button>

              {(node.node_type === "buttons" || node.node_type === "list") && (
                <div className="border border-slate-100 rounded-lg p-3 space-y-2 bg-slate-50/60">
                  <div className="text-xs font-semibold text-slate-600 uppercase">
                    {node.node_type === "list" ? "Opciones de lista del cliente" : "Botones del cliente"}
                  </div>
                  {node.node_type === "buttons" && (
                    <div className="space-y-2">
                      <p className="text-[11px] text-slate-700 bg-sky-50 border border-sky-200 rounded-lg px-3 py-2 leading-snug">
                        <span className="font-medium text-sky-900">WhatsApp Cloud API:</span> el texto que ve el cliente
                        en cada botón es el campo <strong>«Texto del botón»</strong>. Se guarda con{" "}
                        <strong>Guardar</strong> o <strong>Guardar paso</strong>.
                      </p>
                      {showGroupedButtonUi ? (
                        <p className="text-[11px] text-amber-900 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 leading-snug">
                          <strong>Modo agrupado:</strong> cada <strong>título de grupo</strong> se envía como una
                          burbuja aparte.{" "}
                          <strong>Cada grupo puede tener hasta 3 botones rápidos de WhatsApp.</strong> No se usa lista
                          interactiva en este modo.
                        </p>
                      ) : (
                        <p className="text-[11px] text-slate-700 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 leading-snug">
                          Sin agrupar: hasta <strong>3</strong> opciones van como botones rápidos en un solo mensaje; con{" "}
                          <strong>4 o más</strong> opciones el sistema puede enviar un <strong>mensaje de lista</strong>{" "}
                          (hasta <strong>10</strong> filas).
                        </p>
                      )}
                    </div>
                  )}
                  {editorFlowOptions.map((opt, optIdx) => {
                    const prevOpt = optIdx > 0 ? editorFlowOptions[optIdx - 1] : null;
                    const gKey = `${opt.group_order ?? 0}\u0000${(opt.group_title ?? "").trim()}`;
                    const prevGKey = prevOpt
                      ? `${prevOpt.group_order ?? 0}\u0000${(prevOpt.group_title ?? "").trim()}`
                      : "";
                    const showGroupHeading =
                      node.node_type === "buttons" &&
                      showGroupedButtonUi &&
                      gKey !== prevGKey;
                    const headingLabel = (opt.group_title ?? "").trim()
                      ? (opt.group_title ?? "").trim()
                      : node.message_text?.trim() || "Opciones";
                    return (
                    <div key={opt.id} className="space-y-2">
                      {showGroupHeading && (
                        <div className="text-xs font-semibold text-slate-700 pt-2 border-t border-slate-200 first:border-t-0 first:pt-0 first:mt-0">
                          Grupo: {headingLabel}
                        </div>
                      )}
                    <div className="grid grid-cols-1 md:grid-cols-4 gap-2 items-start">
                      <div>
                        <label className="block text-xs text-slate-500 mb-1">
                          {node.node_type === "list" ? "Texto de la opción" : "Texto del botón"}
                        </label>
                        <input
                          className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm w-full"
                          value={opt.label}
                          onChange={(e) => {
                            const v = e.target.value;
                            setNodes((prev) =>
                              prev.map((n) =>
                                n.id !== node.id
                                  ? n
                                  : {
                                      ...n,
                                      options: n.options.map((o) =>
                                        o.id === opt.id ? { ...o, label: v } : o
                                      ),
                                    }
                              )
                            );
                          }}
                          placeholder={node.node_type === "list" ? "Ej: Plan Premium" : "Ej: Comprar entrada"}
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-slate-500 mb-1">Va a</label>
                        {node.node_type === "buttons" && (
                          <p className="text-[10px] text-slate-500 mb-1 leading-snug">
                            Destino al pulsar <strong>este</strong> botón (por opción); no depende del grupo.
                          </p>
                        )}
                        <select
                          className={`border rounded-lg px-2 py-1.5 text-sm w-full ${optionSaveError[opt.id] ? "border-amber-400 ring-1 ring-amber-300" : "border-slate-200"}`}
                          value={opt.next_node_code ?? ""}
                          onChange={(e) => {
                            setOptionSaveError((prev) => {
                              const next = { ...prev };
                              delete next[opt.id];
                              return next;
                            });
                            setNodes((prev) =>
                              prev.map((n) =>
                                n.id !== node.id
                                  ? n
                                  : {
                                      ...n,
                                      options: n.options.map((o) =>
                                        o.id === opt.id ? { ...o, next_node_code: e.target.value || null } : o
                                      ),
                                    }
                              )
                            );
                          }}
                        >
                          <option value="">(sin siguiente)</option>
                          {nodeCodes.filter((code) => code !== node.node_code).map((code) => (
                            <option key={code} value={code}>{nextStepLabel(code)}</option>
                          ))}
                        </select>
                        {optionSaveError[opt.id] && (
                          <p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1.5 mt-1">
                            {optionSaveError[opt.id]}
                          </p>
                        )}
                      </div>
                      <div className="flex gap-2 pt-5">
                        <button
                          type="button"
                          onClick={async () => {
                            try {
                              await saveOption(node, opt);
                            } catch (e) {
                              const msg = e instanceof Error ? e.message : "Error al guardar opción";
                              setError(msg);
                              setOptionSaveError((prev) => ({ ...prev, [opt.id]: msg }));
                            }
                          }}
                          className="text-[#4FAEB2] hover:underline text-sm"
                        >
                          Guardar
                        </button>
                        <button
                          type="button"
                          onClick={async () => {
                            try {
                              await deleteOption(node, opt.id);
                              setOptionSimpleDrafts((prev) => {
                                const next = { ...prev };
                                delete next[opt.id];
                                return next;
                              });
                              setOptionPayloadDrafts((prev) => {
                                const next = { ...prev };
                                delete next[opt.id];
                                return next;
                              });
                              setOptionEditorMode((prev) => {
                                const next = { ...prev };
                                delete next[opt.id];
                                return next;
                              });
                              await reload();
                            } catch (e) {
                              const msg = e instanceof Error ? e.message : "Error al eliminar opción";
                              setError(msg);
                              console.warn("[flow-editor]", "delete_option_ui_error", msg);
                            }
                          }}
                          className="text-red-600 hover:underline text-sm"
                        >
                          Eliminar
                        </button>
                        {showGroupedButtonUi && node.node_type === "buttons" && (
                          <button
                            type="button"
                            className="text-emerald-700 hover:underline text-sm"
                            onClick={async () => {
                              try {
                                await createOption(node, { kind: "in_group", anchorOptionId: opt.id });
                                await reload({ soft: true });
                              } catch (e) {
                                setError(e instanceof Error ? e.message : "Error al crear opción");
                              }
                            }}
                          >
                            + En este grupo
                          </button>
                        )}
                      </div>
                      {node.node_type === "buttons" && (
                        <div className="md:col-span-4 grid grid-cols-1 sm:grid-cols-3 gap-2">
                          <div>
                            <label className="block text-xs text-slate-500 mb-1">Orden opción</label>
                            <input
                              type="number"
                              className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm w-full"
                              value={opt.sort_order}
                              onChange={(e) => {
                                const v = parseInt(e.target.value, 10);
                                setNodes((prev) =>
                                  prev.map((n) =>
                                    n.id !== node.id
                                      ? n
                                      : {
                                          ...n,
                                          options: n.options.map((o) =>
                                            o.id === opt.id
                                              ? { ...o, sort_order: Number.isFinite(v) ? v : 0 }
                                              : o
                                          ),
                                        }
                                  )
                                );
                              }}
                            />
                          </div>
                          <div>
                            <label className="block text-xs text-slate-500 mb-1">Título del grupo</label>
                            <input
                              className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm w-full"
                              value={opt.group_title ?? ""}
                              placeholder="Ej: Combos populares"
                              onChange={(e) => {
                                const v = e.target.value;
                                setNodes((prev) =>
                                  prev.map((n) =>
                                    n.id !== node.id
                                      ? n
                                      : {
                                          ...n,
                                          options: n.options.map((o) =>
                                            o.id === opt.id ? { ...o, group_title: v || null } : o
                                          ),
                                        }
                                  )
                                );
                              }}
                            />
                          </div>
                          <div>
                            <label className="block text-xs text-slate-500 mb-1">Orden del grupo</label>
                            <input
                              type="number"
                              className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm w-full"
                              value={opt.group_order ?? 0}
                              onChange={(e) => {
                                const v = parseInt(e.target.value, 10);
                                setNodes((prev) =>
                                  prev.map((n) =>
                                    n.id !== node.id
                                      ? n
                                      : {
                                          ...n,
                                          options: n.options.map((o) =>
                                            o.id === opt.id
                                              ? { ...o, group_order: Number.isFinite(v) ? v : 0 }
                                              : o
                                          ),
                                        }
                                  )
                                );
                              }}
                            />
                          </div>
                        </div>
                      )}
                      <div className="md:col-span-4 flex flex-wrap gap-2 pt-1">
                        <button
                          type="button"
                          className="text-xs px-2 py-1 rounded-md border border-[#4FAEB2]/30 bg-[#4FAEB2]/10 text-[#3F8E91] hover:bg-[#4FAEB2]/20"
                          onClick={() => {
                            setInsertDraft({ node_code: "", node_type: "text", message_text: "", save_as_field: "" });
                            setInsertModal({
                              sourceType: "option",
                              sourceNodeCode: node.node_code,
                              sourceOptionId: opt.id,
                              optionLabel: opt.label,
                            });
                          }}
                        >
                          Insertar después de esta opción
                        </button>
                        <button
                          type="button"
                          className="text-xs px-2 py-1 rounded-md border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                          onClick={() => {
                            setChangeNextValue(opt.next_node_code ?? "");
                            setChangeNextModal({ kind: "option", nodeId: node.id, optionId: opt.id });
                          }}
                        >
                          Cambiar destino
                        </button>
                      </div>
                      <div className="md:col-span-4">
                        <div className="flex items-center justify-between mb-1">
                          <label className="block text-xs text-slate-500">Datos de la opción seleccionada</label>
                          <button
                            type="button"
                            className="text-xs text-[#4FAEB2] hover:underline"
                            onClick={() =>
                              setOptionEditorMode((prev) => ({
                                ...prev,
                                [opt.id]:
                                  (prev[opt.id] ?? "simple") === "simple" ? "advanced" : "simple",
                              }))
                            }
                          >
                            {(optionEditorMode[opt.id] ?? "simple") === "simple"
                              ? "Usar modo JSON avanzado"
                              : "Usar modo simple"}
                          </button>
                        </div>
                        {flowSorteoId && (node.node_type === "buttons" || node.node_type === "list") && (
                          <label className="flex items-start gap-2 mb-3 cursor-pointer rounded-lg border border-violet-200 bg-violet-50/80 px-3 py-2">
                            <input
                              type="checkbox"
                              className="mt-0.5"
                              checked={optionFinalizeSorteo[opt.id] ?? false}
                              onChange={(e) =>
                                setOptionFinalizeSorteo((prev) => ({
                                  ...prev,
                                  [opt.id]: e.target.checked,
                                }))
                              }
                            />
                            <span className="text-xs text-slate-700 leading-snug">
                              <span className="font-medium text-violet-900">Cerrar compra del sorteo</span>
                              <span className="block text-slate-600 mt-0.5">
                                Marcar en el botón final (después de comprobante y datos). No redefine la oferta: solo
                                dispara la orden y cupones. Equivale a{" "}
                                <code className="text-[10px] bg-white/80 px-1 rounded">confirmar_orden_sorteo</code> en
                                el payload.
                              </span>
                            </span>
                          </label>
                        )}
                        {(optionEditorMode[opt.id] ?? "simple") === "simple" ? (
                          optionFinalizeSorteo[opt.id] && flowSorteoId ? (
                            <p className="text-xs text-slate-600 border border-slate-200 rounded-lg px-3 py-2 bg-slate-50">
                              Modo cierre: no se guardan aquí cantidad ni monto; se usa solo la señal de confirmación. La
                              oferta ya quedó al elegir la opción de compra.
                            </p>
                          ) : (
                          <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
                            <div>
                              <label className="block text-[11px] text-slate-500 mb-1">Cantidad</label>
                              <input
                                className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm w-full"
                                value={optionSimpleDrafts[opt.id]?.cantidad ?? ""}
                                onChange={(e) =>
                                  setOptionSimpleDrafts((prev) => ({
                                    ...prev,
                                    [opt.id]: {
                                      ...(prev[opt.id] ?? toSimpleDraftFromPayload(opt)),
                                      cantidad: e.target.value,
                                    },
                                  }))
                                }
                                placeholder="1"
                              />
                            </div>
                            <div>
                              <label className="block text-[11px] text-slate-500 mb-1">Producto</label>
                              <input
                                className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm w-full"
                                value={optionSimpleDrafts[opt.id]?.producto ?? ""}
                                onChange={(e) =>
                                  setOptionSimpleDrafts((prev) => ({
                                    ...prev,
                                    [opt.id]: {
                                      ...(prev[opt.id] ?? toSimpleDraftFromPayload(opt)),
                                      producto: e.target.value,
                                    },
                                  }))
                                }
                                placeholder="1 boleto"
                              />
                            </div>
                            <div>
                              <label className="block text-[11px] text-slate-500 mb-1">Monto</label>
                              <input
                                className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm w-full"
                                value={optionSimpleDrafts[opt.id]?.monto ?? ""}
                                onChange={(e) =>
                                  setOptionSimpleDrafts((prev) => ({
                                    ...prev,
                                    [opt.id]: {
                                      ...(prev[opt.id] ?? toSimpleDraftFromPayload(opt)),
                                      monto: e.target.value,
                                    },
                                  }))
                                }
                                placeholder="20000"
                              />
                            </div>
                            <div>
                              <label className="block text-[11px] text-slate-500 mb-1">Etiqueta seleccionada</label>
                              <input
                                className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm w-full"
                                value={
                                  (optionSimpleDrafts[opt.id] ?? toSimpleDraftFromPayload(opt)).opcion_label
                                }
                                onChange={(e) =>
                                  setOptionSimpleDrafts((prev) => ({
                                    ...prev,
                                    [opt.id]: {
                                      ...(prev[opt.id] ?? toSimpleDraftFromPayload(opt)),
                                      opcion_label: e.target.value,
                                    },
                                  }))
                                }
                                placeholder="Ej: 1 boleta 10.000 Gs (interno / placeholders)"
                              />
                            </div>
                            <div className="md:col-span-2">
                              <label className="block text-[11px] text-slate-500 mb-1">Nombre de la promo</label>
                              <input
                                className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm w-full"
                                value={optionSimpleDrafts[opt.id]?.promo_nombre ?? ""}
                                onChange={(e) =>
                                  setOptionSimpleDrafts((prev) => ({
                                    ...prev,
                                    [opt.id]: {
                                      ...(prev[opt.id] ?? toSimpleDraftFromPayload(opt)),
                                      promo_nombre: e.target.value,
                                    },
                                  }))
                                }
                                placeholder="3 entradas por 50 mil"
                              />
                            </div>
                            <div className="md:col-span-2">
                              <label className="block text-[11px] text-slate-500 mb-1">
                                Precio lista (opcional, referencia)
                              </label>
                              <input
                                className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm w-full"
                                value={optionSimpleDrafts[opt.id]?.precio_regular ?? ""}
                                onChange={(e) =>
                                  setOptionSimpleDrafts((prev) => ({
                                    ...prev,
                                    [opt.id]: {
                                      ...(prev[opt.id] ?? toSimpleDraftFromPayload(opt)),
                                      precio_regular: e.target.value,
                                    },
                                  }))
                                }
                                placeholder="60000"
                              />
                            </div>
                          </div>
                          )
                        ) : (
                          <textarea
                            className="border border-slate-200 rounded-lg px-2 py-1.5 text-xs font-mono w-full min-h-[82px]"
                            value={optionPayloadDrafts[opt.id] ?? stringifyOptionPayload(opt.option_payload)}
                            placeholder={
                              '{\n  "cantidad": 3,\n  "monto": 50000,\n  "promo_nombre": "3 entradas por 50 mil",\n  "precio_regular": 60000,\n  "precio_fuente": "promo",\n  "opcion_label": "3 por 50.000"\n}'
                            }
                            onChange={(e) =>
                              setOptionPayloadDrafts((prev) => ({
                                ...prev,
                                [opt.id]: e.target.value,
                              }))
                            }
                          />
                        )}
                        <p className="text-[11px] text-slate-500 mt-1">
                          Se guardan en contexto al elegir este botón. Con monto numérico se marca{" "}
                          <code className="text-[10px]">precio_fuente=promo</code>. Placeholders:{" "}
                          {`{{cantidad}}, {{producto}}, {{monto}}, {{promo_nombre}}, {{precio_regular}}, {{precio_fuente}}, {{opcion_label}}`}.
                        </p>
                      </div>
                      <div className="md:col-span-4 text-xs text-slate-500 bg-white border border-slate-200 rounded px-2 py-1">
                        {node.node_type === "list" ? "Opción" : "Botón"}: "{opt.label}" → va a: "{nextStepLabel(opt.next_node_code)}"
                      </div>
                    </div>
                    </div>
                  );
                  })}
                  <div className="flex flex-wrap gap-3 items-center pt-1">
                    {node.node_type === "list" ? (
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            await createOption(node);
                            await reload({ soft: true });
                          } catch (e) {
                            setError(e instanceof Error ? e.message : "Error al crear opción");
                          }
                        }}
                        className="text-sm text-[#4FAEB2] hover:underline"
                      >
                        + Agregar opción
                      </button>
                    ) : showGroupedButtonUi ? (
                      <>
                        <button
                          type="button"
                          onClick={async () => {
                            try {
                              await createOption(node, { kind: "new_group" });
                              await reload({ soft: true });
                            } catch (e) {
                              setError(e instanceof Error ? e.message : "Error al crear opción");
                            }
                          }}
                          className="text-sm text-[#4FAEB2] hover:underline"
                        >
                          + Nuevo grupo
                        </button>
                        <button
                          type="button"
                          onClick={async () => {
                            try {
                              await createOption(node, { kind: "ungrouped" });
                              await reload({ soft: true });
                            } catch (e) {
                              setError(e instanceof Error ? e.message : "Error al crear opción");
                            }
                          }}
                          className="text-sm text-slate-600 hover:underline"
                        >
                          + Botón sin grupo
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            await createOption(node);
                            await reload({ soft: true });
                          } catch (e) {
                            setError(e instanceof Error ? e.message : "Error al crear opción");
                          }
                        }}
                        className="text-sm text-[#4FAEB2] hover:underline"
                      >
                        + Agregar botón
                      </button>
                    )}
                  </div>
                </div>
              )}
              </>
              )}
            </div>
          );
          })}
        </div>
      )}

      {insertModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40" role="dialog" aria-modal="true">
          <div className="bg-white rounded-xl shadow-xl max-w-lg w-full p-6 space-y-4 border border-slate-200">
            <h2 className="text-lg font-semibold text-slate-800">Insertar paso en el grafo</h2>
            <p className="text-sm text-slate-600">
              Se creará un nuevo paso <strong>entre</strong>{" "}
              {insertModal.sourceType === "option" ? (
                <>
                  la opción «{insertModal.optionLabel ?? "…"}» ({insertModal.sourceNodeCode}) y su destino anterior
                </>
              ) : (
                <>«{insertModal.sourceNodeCode}» y su siguiente paso anterior</>
              )}
              . La ejecución usa <code className="text-xs bg-slate-100 px-1 rounded">next_node_code</code>, no el orden
              visual.
            </p>
            <div className="space-y-2">
              <label className="block text-xs text-slate-500">Código interno del nuevo paso</label>
              <input
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm font-mono"
                value={insertDraft.node_code}
                onChange={(e) => setInsertDraft((d) => ({ ...d, node_code: e.target.value }))}
                placeholder="ej: confirmacion_extra"
              />
            </div>
            <div className="space-y-2">
              <label className="block text-xs text-slate-500">Tipo</label>
              <select
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
                value={insertDraft.node_type}
                onChange={(e) => setInsertDraft((d) => ({ ...d, node_type: e.target.value }))}
              >
                {INSERT_NODE_TYPE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <label className="block text-xs text-slate-500">Mensaje al cliente (opcional)</label>
              <textarea
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm min-h-[72px]"
                value={insertDraft.message_text}
                onChange={(e) => setInsertDraft((d) => ({ ...d, message_text: e.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <label className="block text-xs text-slate-500">Guardar respuesta como (opcional)</label>
              <input
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
                value={insertDraft.save_as_field}
                onChange={(e) => setInsertDraft((d) => ({ ...d, save_as_field: e.target.value }))}
                placeholder="ej: telefono_contacto"
              />
            </div>
            <div className="flex flex-wrap justify-end gap-2 pt-2">
              <button
                type="button"
                className="px-4 py-2 text-sm rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50"
                disabled={insertBusy}
                onClick={() => setInsertModal(null)}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="px-4 py-2 text-sm rounded-lg bg-[#4FAEB2] text-white hover:bg-[#3F8E91] disabled:opacity-50"
                disabled={insertBusy}
                onClick={() => void submitInsertBetween()}
              >
                {insertBusy ? "Insertando…" : "Insertar y enlazar"}
              </button>
            </div>
          </div>
        </div>
      )}

      {changeNextModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40" role="dialog" aria-modal="true">
          <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6 space-y-4 border border-slate-200">
            <h2 className="text-lg font-semibold text-slate-800">
              {changeNextModal.kind === "node" ? "Cambiar siguiente paso" : "Cambiar destino de la opción"}
            </h2>
            <p className="text-sm text-slate-600">Elige el paso destino (por código). Vacío = sin siguiente.</p>
            <select
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
              value={changeNextValue}
              onChange={(e) => setChangeNextValue(e.target.value)}
            >
              <option value="">(sin siguiente)</option>
              {nodeCodes.map((code) => (
                <option key={code} value={code}>
                  {nextStepLabel(code)}
                </option>
              ))}
            </select>
            <div className="flex flex-wrap justify-end gap-2 pt-2">
              <button
                type="button"
                className="px-4 py-2 text-sm rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50"
                disabled={changeNextBusy}
                onClick={() => setChangeNextModal(null)}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="px-4 py-2 text-sm rounded-lg bg-[#4FAEB2] text-white hover:bg-[#3F8E91] disabled:opacity-50"
                disabled={changeNextBusy}
                onClick={() => void applyChangeNextModal()}
              >
                {changeNextBusy ? "Guardando…" : "Guardar"}
              </button>
            </div>
          </div>
        </div>
      )}

      <details className="bg-white border border-slate-200 rounded-xl shadow-sm group">
        <summary className="cursor-pointer list-none px-4 py-3 flex flex-wrap items-center justify-between gap-2 text-sm font-semibold text-slate-800 hover:bg-slate-50/80 rounded-xl [&::-webkit-details-marker]:hidden">
          <span className="inline-flex items-center gap-2">
            <span className="text-slate-400 group-open:rotate-90 transition-transform">▸</span>
            Integración con sorteos
            <span className="font-normal text-slate-500">(opcional)</span>
          </span>
          {flowSorteoId ? (
            <span className="text-xs font-medium px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-800 border border-emerald-200 max-w-[min(100%,16rem)] truncate">
              {flowSorteoNombre || "Vinculado"}
            </span>
          ) : (
            <span className="text-xs text-slate-500">Sin vincular</span>
          )}
        </summary>
        <div className="px-4 pb-4 pt-0 space-y-3 border-t border-slate-100">
          <p className="text-xs text-slate-500">
            Solo si usás el módulo Sorteos: al asociar un sorteo, al recibir el comprobante por WhatsApp se puede
            generar la orden y los cupones. No afecta la edición de pasos de arriba.
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex-1 min-w-[220px]">
              <label className="block text-xs text-slate-500 mb-1">Sorteo vinculado al flujo</label>
              <select
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
                value={sorteoDraft}
                onChange={(e) => setSorteoDraft(e.target.value)}
              >
                <option value="">Ninguno</option>
                {sorteosOptions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.nombre}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              disabled={savingSorteoLink}
              onClick={() => void saveSorteoAssociation()}
              className="bg-slate-800 hover:bg-slate-900 disabled:opacity-60 text-white px-4 py-2 rounded-lg text-sm font-medium"
            >
              {savingSorteoLink ? "Guardando…" : "Guardar vínculo"}
            </button>
          </div>
          <div className="space-y-2">
            <label className="block text-xs text-slate-500">
              Mensaje si faltan datos para registrar la compra del sorteo (WhatsApp). Vacío = texto por defecto del sistema.
            </label>
            <textarea
              className="w-full min-h-[88px] rounded-md border border-slate-200 px-3 py-2 text-sm"
              value={sorteoIncompleteMsgDraft}
              onChange={(e) => setSorteoIncompleteMsgDraft(e.target.value)}
              placeholder="Ej.: No pudimos registrar esta compra. Tocá de nuevo tu opción y enviá el comprobante."
              maxLength={4000}
            />
            <button
              type="button"
              className="rounded-md bg-slate-700 px-3 py-1.5 text-sm text-white disabled:opacity-50"
              disabled={savingSorteoIncompleteMsg}
              onClick={() => void saveSorteoIncompleteMessage()}
            >
              {savingSorteoIncompleteMsg ? "Guardando…" : "Guardar mensaje"}
            </button>
          </div>
          {sorteosOptions.length === 0 && (
            <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-2 py-1.5">
              No hay sorteos en la empresa. Creá uno en el módulo Sorteos para poder asociarlo.
            </p>
          )}
        </div>
      </details>
        </>
      )}
      {editorTab === "automatizaciones" && (
        <FlowRecontactAutomationsPanel flowCode={flowCode} nodePickerOptions={nodePickerOptions} />
      )}
    </div>
  );
}
