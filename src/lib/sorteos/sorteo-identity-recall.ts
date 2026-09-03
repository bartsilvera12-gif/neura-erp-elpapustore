/**
 * Recompra rápida: "¿Querés adquirir las boletas con tus datos registrados?"
 *
 * Un cliente que ya compró vuelve a escribir desde el mismo número. En vez de volver a pedirle
 * cédula / nombre / ciudad, el flujo le muestra lo que hay registrado y le ofrece dos caminos:
 * confirmar y seguir, o cargar los datos de otra persona.
 *
 * IMPORTANTE — por qué esto NO reabre el bug de la recompra (ver 2388584):
 * `mergeConversationFlowDataFromOlderSessions` sigue excluyendo la identidad, así que nada se
 * hereda en silencio. Acá la identidad se escribe en `chat_flow_data` de la sesión ACTUAL recién
 * cuando el cliente toca "Sí, confirmar" — es decir, queda indistinguible de haberla tipeado.
 * Y el "No, ingresar nuevo" **vacía** los slots de forma explícita: no basta con no escribir,
 * porque cualquier resto haría que el gate de completitud dé la identidad por buena y cree la
 * orden temprano con datos ajenos (exactamente el bug original).
 *
 * Helpers puros: sin `pg` ni Supabase, para que la UI del editor de flujos pueda importarlos.
 * La búsqueda del cliente vive en `sorteo-identity-recall-lookup.ts` (server-only).
 */

/** `chat_flow_nodes.node_type` del paso de recompra rápida. */
export const IDENTITY_RECALL_NODE_TYPE = "identity_recall" as const;

export type IdentityRecallCliente = {
  clienteId: string;
  nombreCompleto: string;
  cedula: string;
  ciudad: string;
  telefono: string;
};

function truthyPayloadFlag(payload: unknown, keys: readonly string[]): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const o = payload as Record<string, unknown>;
  for (const k of keys) {
    const v = o[k];
    if (v === true || v === "true" || v === "1" || v === 1) return true;
  }
  return false;
}

/**
 * Botón "✅ Sí, confirmar" — en su `option_payload`:
 * `{ "usar_datos_registrados": true }`.
 */
export function optionPayloadUsesRegisteredIdentity(payload: unknown): boolean {
  return truthyPayloadFlag(payload, [
    "usar_datos_registrados",
    "use_registered_identity",
    "confirmar_datos_registrados",
  ]);
}

/**
 * Botón "❌ No, ingresar nuevo" — en su `option_payload`:
 * `{ "cargar_datos_nuevos": true }`.
 */
export function optionPayloadRequestsNewIdentity(payload: unknown): boolean {
  return truthyPayloadFlag(payload, [
    "cargar_datos_nuevos",
    "request_new_identity",
    "ingresar_datos_nuevos",
  ]);
}

/** Primer token = nombre, resto = apellido (mismo criterio que el resto del flujo). */
export function splitNombreCompleto(nombreCompleto: string): {
  nombre: string;
  apellido: string;
} {
  const parts = nombreCompleto.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { nombre: "", apellido: "" };
  if (parts.length === 1) return { nombre: parts[0] as string, apellido: "" };
  return { nombre: parts[0] as string, apellido: parts.slice(1).join(" ") };
}

/**
 * Claves canónicas que escribe el "Sí". Son exactamente las que lee
 * `parseSorteoParticipantFromFlowData`, para que el recomprador siga el mismo camino que
 * alguien que tipeó los datos a mano.
 */
export function buildIdentityRecallFlowDataWrites(
  cliente: IdentityRecallCliente
): Array<{ field_name: string; field_value: string }> {
  const { nombre, apellido } = splitNombreCompleto(cliente.nombreCompleto);
  const rows: Array<{ field_name: string; field_value: string }> = [
    { field_name: "nombre", field_value: nombre },
    { field_name: "apellido", field_value: apellido },
    { field_name: "cedula", field_value: cliente.cedula.trim() },
    { field_name: "ciudad", field_value: cliente.ciudad.trim() },
  ];
  /**
   * `nombre_completo` se recalcula desde nombre + apellido en el parser, pero si quedó un valor
   * viejo de otra sesión gana por precedencia. Lo reescribimos con el confirmado.
   */
  rows.push({ field_name: "nombre_completo", field_value: cliente.nombreCompleto.trim() });
  return rows.filter((r) => r.field_value.length > 0 || r.field_name === "apellido");
}

/**
 * Slots de identidad (con todos sus alias) que el "No, ingresar nuevo" vacía.
 * Espeja los buckets de `bucketForSaveField`: si un alias queda con valor, el gate de
 * completitud lo toma como identidad cargada.
 */
export const IDENTITY_RECALL_CLEAR_FIELDS: readonly string[] = [
  // cédula
  "cedula",
  "cédula",
  "documento",
  "nro_documento",
  "numero_documento",
  "ci",
  "dni",
  "ruc",
  // nombre
  "nombre",
  "primer_nombre",
  "nombres",
  "nombre_completo",
  "nombre_y_apellido",
  // apellido
  "apellido",
  "primer_apellido",
  "apellidos",
  // ciudad
  "ciudad",
  "localidad",
  "ubicacion",
  "ubicación",
  // snapshot de lo mostrado: si el comprador rechaza, no debe sobrevivir para promoverse después
  "recall_snap_datos",
  // y la marca de confirmación: sin ella no se saltea ningún paso de captura
  "recall_identidad_confirmada",
];

/**
 * Snapshot de lo que se le MOSTRÓ al comprador, guardado al enviar el nodo.
 *
 * El "Sí" promueve este snapshot a las claves canónicas en vez de volver a consultar la base:
 * así lo que se guarda en la orden es exactamente lo que la persona vio y aprobó, sin ventana
 * para que un cambio intermedio en `clientes` meta otros datos.
 */
export const IDENTITY_RECALL_SNAPSHOT_FIELD = "recall_snap_datos" as const;

/**
 * Marca que en ESTA sesión el comprador confirmó usar sus datos registrados.
 *
 * Sirve para saltear los pasos de captura de identidad que ya quedaron llenos: sin la marca no
 * se saltea nada, así que ninguna compra normal ni ningún otro flujo cambia de comportamiento.
 * El "No, ingresar nuevo" no la escribe, y la limpieza de identidad la borra.
 */
export const IDENTITY_RECALL_CONFIRMED_FIELD = "recall_identidad_confirmada" as const;

export function identityRecallWasConfirmed(flowData: Record<string, string>): boolean {
  return (flowData[IDENTITY_RECALL_CONFIRMED_FIELD] ?? "").trim().toLowerCase() === "si";
}

export function buildIdentityRecallSnapshotWrites(
  cliente: IdentityRecallCliente
): Array<{ field_name: string; field_value: string }> {
  return [
    {
      field_name: IDENTITY_RECALL_SNAPSHOT_FIELD,
      field_value: JSON.stringify({
        clienteId: cliente.clienteId,
        nombreCompleto: cliente.nombreCompleto,
        cedula: cliente.cedula,
        ciudad: cliente.ciudad,
        telefono: cliente.telefono,
      }),
    },
  ];
}

/** Lee el snapshot; `null` si falta o quedó corrupto (el flujo pide los datos como siempre). */
export function readIdentityRecallSnapshot(
  raw: string | undefined | null
): IdentityRecallCliente | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  try {
    const o = JSON.parse(s) as Record<string, unknown>;
    const nombreCompleto = typeof o.nombreCompleto === "string" ? o.nombreCompleto.trim() : "";
    const cedula = typeof o.cedula === "string" ? o.cedula.trim() : "";
    if (!nombreCompleto || !cedula) return null;
    return {
      clienteId: typeof o.clienteId === "string" ? o.clienteId : "",
      nombreCompleto,
      cedula,
      ciudad: typeof o.ciudad === "string" ? o.ciudad.trim() : "",
      telefono: typeof o.telefono === "string" ? o.telefono.trim() : "",
    };
  } catch {
    return null;
  }
}

/** Variables `{{...}}` disponibles en el `message_text` del nodo de recompra. */
export function buildIdentityRecallVars(
  cliente: IdentityRecallCliente
): Record<string, string> {
  const { nombre, apellido } = splitNombreCompleto(cliente.nombreCompleto);
  return {
    datos_cedula: cliente.cedula.trim(),
    datos_nombre: cliente.nombreCompleto.trim(),
    datos_primer_nombre: nombre,
    datos_apellido: apellido,
    datos_ciudad: cliente.ciudad.trim(),
    datos_telefono: cliente.telefono.trim(),
  };
}

/** Texto por defecto si el nodo se crea sin `message_text`. */
export const IDENTITY_RECALL_DEFAULT_MESSAGE = [
  "¿Querés adquirir las boletas con tus datos registrados?",
  "",
  "C.I.: {{datos_cedula}}",
  "Nombre: {{datos_nombre}}",
  "Ciudad: {{datos_ciudad}}",
  "Teléfono: {{datos_telefono}}",
].join("\n");
