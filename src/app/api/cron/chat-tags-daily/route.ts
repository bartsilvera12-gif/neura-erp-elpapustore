import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import type { Pool } from "pg";
import { getChatPostgresPool } from "@/lib/supabase/chat-pg-pool";
import { assertAllowedChatDataSchema } from "@/lib/supabase/chat-data-schema";
import { schemaHasHiddenByTagColumn } from "@/lib/chat/tags/has-hidden-by-tag-column";
import { schemaHasBulkCategoryFn } from "@/lib/chat/tags/has-bulk-category-fn";
import { getSingleClientSchemaOrNull } from "@/lib/instance/single-client";

/**
 * Etiquetas Automáticas - FASE 6A.
 * Cron diario protegido. Recomendado vía Vercel Cron `"1 3 * * *"` (00:01 PYT).
 *
 * Comportamiento:
 *  - Para cada tenant habilitado en ENABLED_TENANTS:
 *      1. Verifica que el schema tenga la columna `hidden_by_tag` (guard multi-tenant).
 *      2. Resuelve tag_id + rule_id de cada bucket activo.
 *      3. Calcula candidatas elegibles (status open/pending, sin hidden, sin tag,
 *         sin humano, sin actividad reciente, sin applied previo del mismo tag,
 *         con categoría real del clasificador v2).
 *      4. Inserta una fila `action='dry_run'` por cada candidata (snapshot del día).
 *      5. Si `apply=true`, aplica hasta `max_batch` conversaciones (UPDATE + INSERT
 *         `action='applied'`). Orden de prioridad de buckets para asignar la cuota:
 *         compro_varias → compro_boleta → comprobante_pendiente → datos_incompletos
 *         → no_compro. La cuota se consume por orden de antigüedad (last_message_at ASC).
 *      6. Todo en UNA SOLA transacción por tenant.
 *
 * Seguridad:
 *  - Requiere `Authorization: Bearer <CRON_SECRET>`. Sin secret válido → 401.
 *  - Sin CRON_SECRET en env → 401 también (no se acepta ejecución).
 *  - Logs sin secretos.
 *
 * Parámetros query:
 *  - `apply` (bool, default false): si false, solo dry_run.
 *  - `max_batch` (int, default 500, hard cap 500): tope de applies por ejecución
 *    por tenant.
 */

const ENABLED_TENANTS: Array<{ empresa_id: string; schema: string }> = [
  // Papu Store - único tenant con la migración de etiquetas aplicada hoy.
  // NOTA: el `schema` aquí es el histórico Cloud (multi-tenant). En modo
  // single_client se sobreescribe por NEURA_CLIENT_SCHEMA (ver resolveEnabledTenants).
  {
    empresa_id: "5ad0bdda-f94f-446c-9032-1fedf34e8479",
    schema: "erp_el_papu_store_5ad0bdda",
  },
];

/**
 * Lista efectiva de tenants a procesar.
 *
 * - single_client (NEURA_INSTANCE_MODE=single_client): el schema operativo es
 *   NEURA_CLIENT_SCHEMA (p.ej. `elpapustore_erp`), NO el schema Cloud histórico.
 *   El `empresa_id` NO cambia entre Cloud y self-hosted, así que se conserva.
 * - multi_tenant: se mantiene la lista legacy sin cambios (no rompe otros clientes).
 */
function resolveEnabledTenants(): Array<{ empresa_id: string; schema: string }> {
  const singleSchema = getSingleClientSchemaOrNull();
  if (singleSchema) {
    return ENABLED_TENANTS.map((t) => ({ ...t, schema: singleSchema }));
  }
  return ENABLED_TENANTS;
}

const BUCKETS: Array<{ tag_code: string; purchase_condition: string }> = [
  { tag_code: "compro_varias", purchase_condition: "purchased_multiple_tickets" },
  { tag_code: "compro_boleta", purchase_condition: "purchased_once" },
  { tag_code: "comprobante_pendiente", purchase_condition: "payment_received_incomplete" },
  { tag_code: "datos_incompletos", purchase_condition: "data_incomplete" },
  { tag_code: "no_compro", purchase_condition: "no_purchase" },
];

const HARD_CAP_BATCH = 500;

function isAuthorized(request: NextRequest): boolean {
  const expected = process.env.CRON_SECRET?.trim();
  if (!expected) return false;
  const auth = request.headers.get("authorization") ?? "";
  return auth === `Bearer ${expected}`;
}

function parseBool(v: string | null, fallback: boolean): boolean {
  if (v == null) return fallback;
  const s = v.trim().toLowerCase();
  if (s === "true" || s === "1" || s === "yes") return true;
  if (s === "false" || s === "0" || s === "no") return false;
  return fallback;
}

function parseIntCap(v: string | null, fallback: number, max: number): number {
  if (!v) return fallback;
  const n = parseInt(v, 10);
  if (Number.isNaN(n) || n < 0) return fallback;
  return Math.min(n, max);
}

interface BucketStats {
  tag_code: string;
  eligible: number;
  applied: number;
  skipped_no_quota: number;
}

interface TenantResult {
  empresa_id_short: string;
  schema: string;
  ok: boolean;
  total_eligible: number;
  total_applied: number;
  buckets: BucketStats[];
  error?: string;
}

async function processTenant(
  pool: Pool,
  tenant: { empresa_id: string; schema: string },
  opts: { apply: boolean; maxBatch: number; runKey: string; batchId: string }
): Promise<TenantResult> {
  const schema = assertAllowedChatDataSchema(tenant.schema);
  const empresaShort = tenant.empresa_id.slice(0, 8);

  // Guard multi-tenant.
  const hasCol = await schemaHasHiddenByTagColumn(pool, schema);
  if (!hasCol) {
    return {
      empresa_id_short: empresaShort,
      schema,
      ok: false,
      total_eligible: 0,
      total_applied: 0,
      buckets: [],
      error: "schema_missing_hidden_by_tag_column",
    };
  }

  // Optimización: si el schema expone el clasificador set-based, se calcula la
  // categoría de TODAS las conversaciones en una pasada (CTE con el bulk, ~2 s)
  // en vez de llamar la función fila-por-fila por cada candidata y por cada
  // bucket (con ~68k conversaciones ×5 buckets tardaba ~165 s/bucket y saturaba
  // la base compartida). Fallback transparente a la función original cuando el
  // schema no tiene el bulk. Paridad verificada: 0 diferencias func vs bulk.
  const useBulk = await schemaHasBulkCategoryFn(pool, schema);
  console.info("[chat-tags][cron-daily] clasificador", {
    empresa_id_short: empresaShort,
    schema,
    modo: useBulk ? "bulk_set_based" : "fila_por_fila_fallback",
  });

  // Resolver tag_id + rule_id por bucket.
  const resolved: Array<{
    tag_code: string;
    tag_id: string;
    rule_id: string;
    purchase_condition: string;
  }> = [];
  for (const b of BUCKETS) {
    const r = await pool.query(
      `SELECT t.id::text AS tag_id, r.id::text AS rule_id
         FROM "${schema}".chat_conversation_tags t
         LEFT JOIN "${schema}".chat_conversation_tag_rules r
           ON r.empresa_id = t.empresa_id
          AND r.purchase_condition = $3
          AND r.is_active = true
          AND r.shadow_mode = true
          AND r.config->>'source' = 'fase_3b_shadow_rules'
        WHERE t.empresa_id = $1 AND t.code = $2
        LIMIT 1`,
      [tenant.empresa_id, b.tag_code, b.purchase_condition]
    );
    const row = r.rows[0] as { tag_id?: string; rule_id?: string } | undefined;
    if (!row?.tag_id || !row?.rule_id) {
      // Sin regla shadow no procesamos este bucket. No bloqueamos el resto.
      continue;
    }
    resolved.push({
      tag_code: b.tag_code,
      tag_id: row.tag_id,
      rule_id: row.rule_id,
      purchase_condition: b.purchase_condition,
    });
  }

  const buckets: BucketStats[] = [];
  let totalEligible = 0;
  let appliedQuota = opts.maxBatch;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    for (const r of resolved) {
      // Eligibles directos (NO usa snapshot previo) — calcula categoría con clasificador v2.
      // Excluye conversaciones que ya tienen applied del mismo tag.
      // La fuente de la categoría es el bulk (CTE) cuando el schema lo tiene, o
      // la función fila-por-fila como fallback. El resto de los filtros de
      // elegibilidad es IDÉNTICO en ambos caminos (solo cambia de dónde sale la
      // categoría), por eso el conjunto de candidatas no varía.
      const catCte = useBulk
        ? `WITH cats AS (
             SELECT conversation_id, category
               FROM "${schema}".chat_tag_purchase_category_bulk($1)
           )`
        : "";
      const catClause = useBulk
        ? `AND EXISTS (
             SELECT 1 FROM cats
              WHERE cats.conversation_id = c.id
                AND cats.category = $2
           )`
        : `AND "${schema}".chat_tag_purchase_category(c.id) = $2`;
      const sql = `
        ${catCte}
        SELECT c.id::text AS conv_id,
               c.contact_id::text AS contact_id,
               c.last_message_at,
               EXTRACT(EPOCH FROM (now() - c.last_message_at)) / 86400.0 AS days_idle,
               c.flow_current_node
          FROM "${schema}".chat_conversations c
         WHERE c.empresa_id = $1
           AND c.status IN ('open','pending')
           AND COALESCE(c.hidden_by_tag, false) = false
           AND c.current_tag_id IS NULL
           AND c.human_taken_over = false
           AND (c.flow_status IS NULL OR c.flow_status <> 'human')
           AND c.last_message_at < now() - interval '7 days'
           AND c.closed_by_usuario_id IS NULL
           ${catClause}
           AND NOT EXISTS (
             SELECT 1 FROM "${schema}".chat_conversation_tag_history hp
              WHERE hp.empresa_id = $1
                AND hp.conversation_id = c.id
                AND hp.action = 'applied'
                AND hp.new_tag_id = $3::uuid
           )
         ORDER BY c.last_message_at ASC
      `;
      const cands = await client.query(sql, [tenant.empresa_id, r.purchase_condition, r.tag_id]);
      const eligible = cands.rows.length;
      totalEligible += eligible;
      let applied = 0;

      for (const row of cands.rows as Array<{
        conv_id: string;
        contact_id: string | null;
        last_message_at: Date | null;
        days_idle: string | number | null;
        flow_current_node: string | null;
      }>) {
        const lmIso = row.last_message_at instanceof Date ? row.last_message_at.toISOString() : null;
        const di =
          row.days_idle == null
            ? null
            : Math.floor(typeof row.days_idle === "string" ? parseFloat(row.days_idle) : row.days_idle);

        const dryMeta = {
          run_key: opts.runKey,
          cron: true,
          source_phase: "fase_6a_cron_daily",
          tag_code: r.tag_code,
          purchase_condition: r.purchase_condition,
          days_idle: di,
          last_message_at: lmIso,
          current_node_code: row.flow_current_node,
        };

        await client.query(
          `INSERT INTO "${schema}".chat_conversation_tag_history
             (empresa_id, conversation_id, contact_id, previous_tag_id, new_tag_id, rule_id,
              action, reason, source, metadata)
           VALUES ($1::uuid, $2::uuid, $3::uuid, NULL, $4::uuid, $5::uuid,
                   'dry_run', 'fase_6a_cron_daily_dry_run', 'auto_rule', $6::jsonb)`,
          [tenant.empresa_id, row.conv_id, row.contact_id, r.tag_id, r.rule_id, JSON.stringify(dryMeta)]
        );

        if (opts.apply && appliedQuota > 0) {
          const up = await client.query(
            `UPDATE "${schema}".chat_conversations
                SET hidden_by_tag = true,
                    current_tag_id = $1::uuid,
                    hidden_by_tag_at = now(),
                    hidden_by_tag_rule_id = $2::uuid,
                    last_tagged_at = now(),
                    updated_at = now()
              WHERE id = $3::uuid AND empresa_id = $4::uuid
                AND hidden_by_tag = false AND current_tag_id IS NULL
                AND status IN ('open','pending')
                AND human_taken_over = false
                AND (flow_status IS NULL OR flow_status <> 'human')`,
            [r.tag_id, r.rule_id, row.conv_id, tenant.empresa_id]
          );
          if ((up.rowCount ?? 0) > 0) {
            const applyMeta = { ...dryMeta, applied_batch_id: opts.batchId };
            await client.query(
              `INSERT INTO "${schema}".chat_conversation_tag_history
                 (empresa_id, conversation_id, contact_id, previous_tag_id, new_tag_id, rule_id,
                  action, reason, source, metadata)
               VALUES ($1::uuid, $2::uuid, $3::uuid, NULL, $4::uuid, $5::uuid,
                       'applied', 'fase_6a_cron_daily_applied', 'auto_rule', $6::jsonb)`,
              [
                tenant.empresa_id,
                row.conv_id,
                row.contact_id,
                r.tag_id,
                r.rule_id,
                JSON.stringify(applyMeta),
              ]
            );
            applied++;
            appliedQuota--;
          }
        }
      }

      buckets.push({
        tag_code: r.tag_code,
        eligible,
        applied,
        skipped_no_quota: Math.max(0, eligible - applied),
      });
    }

    await client.query("COMMIT");
    const totalApplied = buckets.reduce((s, b) => s + b.applied, 0);
    return {
      empresa_id_short: empresaShort,
      schema,
      ok: true,
      total_eligible: totalEligible,
      total_applied: totalApplied,
      buckets,
    };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    return {
      empresa_id_short: empresaShort,
      schema,
      ok: false,
      total_eligible: 0,
      total_applied: 0,
      buckets,
      error: e instanceof Error ? e.message : "unknown",
    };
  } finally {
    client.release();
  }
}

async function handle(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ ok: false, error: "no autorizado" }, { status: 401 });
  }

  const pool = getChatPostgresPool();
  if (!pool) {
    return NextResponse.json({ ok: false, error: "pool no disponible" }, { status: 503 });
  }

  const url = new URL(request.url);
  const apply = parseBool(url.searchParams.get("apply"), false);
  const maxBatch = parseIntCap(url.searchParams.get("max_batch"), 500, HARD_CAP_BATCH);

  const today = new Date().toISOString().slice(0, 10);
  const runKey = `cron_daily_${today}_${randomUUID().slice(0, 8)}`;
  const batchId = randomUUID();
  const startedAt = new Date().toISOString();

  const enabledTenants = resolveEnabledTenants();

  console.info("[chat-tags][cron-daily] start", {
    run_key: runKey,
    batch_id_short: batchId.slice(0, 8),
    apply,
    max_batch: maxBatch,
    tenants_count: enabledTenants.length,
    schemas: enabledTenants.map((t) => t.schema),
  });

  const tenants: TenantResult[] = [];
  for (const tenant of enabledTenants) {
    const r = await processTenant(pool, tenant, { apply, maxBatch, runKey, batchId });
    tenants.push(r);
    console.info("[chat-tags][cron-daily] tenant", {
      empresa_id_short: r.empresa_id_short,
      ok: r.ok,
      total_eligible: r.total_eligible,
      total_applied: r.total_applied,
      buckets: r.buckets,
      error: r.error,
    });
  }
  const endedAt = new Date().toISOString();

  return NextResponse.json({
    ok: true,
    started_at: startedAt,
    ended_at: endedAt,
    run_key: runKey,
    batch_id: batchId,
    apply,
    max_batch: maxBatch,
    tenants,
  });
}

export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}
