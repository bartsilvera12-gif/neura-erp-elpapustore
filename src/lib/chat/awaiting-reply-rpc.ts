/**
 * Mismo allowlist que la función SQL `neura_inbox_awaiting_reply_since_batch`
 * (`sch !~ '^(zentra_erp|public|er_[0-9a-f]{32}|erp_[a-z0-9_]+)$'` → RAISE). Los schemas de las
 * empresas (`elpapustore_erp`, `caribenaerp`, …) no lo cumplen: la RPC siempre falla y el listado
 * usa el cálculo por último mensaje. Sin este chequeo se perdía una consulta remota por carga.
 */
const AWAITING_RPC_SCHEMA_ALLOWLIST = /^(zentra_erp|public|er_[0-9a-f]{32}|erp_[a-z0-9_]+)$/;

export function awaitingReplyRpcAdmitsSchema(schema: string): boolean {
  return AWAITING_RPC_SCHEMA_ALLOWLIST.test(String(schema ?? "").trim());
}
