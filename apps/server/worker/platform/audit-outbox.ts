import type { AuditQueueMessage } from '@xid-kit/types'
import { createPersistedId } from '../lib/persisted-id'
import { logWorkerError, logWorkerWarning } from '../lib/safe-log'
import { redactAuditPayload } from '../queues/audit-redaction'

const RETRY_DELAY_MS = 60_000
const BATCH_SIZE = 100
const SOURCE_PREFIX = 'platform-audit:'

export type PlatformAuditInput = {
  id?: string
  tenantId: string
  orgId?: string
  action: string
  actorId?: string
  payload: Record<string, unknown>
  ts?: number
}

export type PersistedPlatformAudit = {
  id: string
  input: PlatformAuditInput
}

export type PreparedPlatformAudit = PersistedPlatformAudit & {
  statement: D1PreparedStatement
}

export type PlatformAuditSqlCondition = {
  sql: string
  bindings: readonly unknown[]
}

export type PreparedConditionalPlatformAudit = PreparedPlatformAudit & {
  mutationGate: {
    sql: string
    bindings: readonly [string]
  }
}

export const PLATFORM_AUDIT_MUTATION_GATE_SQL = `EXISTS (
  SELECT 1
    FROM platform_audit_outbox AS mutation_audit_gate
   WHERE mutation_audit_gate.id = ?
)`

function sourceMessageId(id: string): string {
  return `${SOURCE_PREFIX}${id}`
}

function queueMessage(prepared: PersistedPlatformAudit): AuditQueueMessage {
  return {
    tenantId: prepared.input.tenantId,
    ...(prepared.input.orgId ? { orgId: prepared.input.orgId } : {}),
    action: prepared.input.action,
    ...(prepared.input.actorId ? { actorId: prepared.input.actorId } : {}),
    ts: prepared.input.ts ?? Date.now(),
    payload: {
      ...prepared.input.payload,
      sourceMessageId: sourceMessageId(prepared.id),
    },
  }
}

export function preparePlatformAuditOutboxInsert(
  env: Env,
  input: PlatformAuditInput,
  now: number = Date.now(),
): PreparedPlatformAudit {
  const id = input.id ?? createPersistedId('platformAudit')
  const payload = redactAuditPayload(input.payload)
  return {
    id,
    input: { ...input, id, payload, ts: input.ts ?? now },
    statement: env.DB.prepare(
      `INSERT INTO platform_audit_outbox (
         id, tenant_id, org_id, action, actor_id, payload, status,
         available_at, attempt_count, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, 0, ?, ?)`,
    ).bind(
      id,
      input.tenantId,
      input.orgId ?? null,
      input.action,
      input.actorId ?? null,
      JSON.stringify(payload),
      now,
      now,
      now,
    ),
  }
}

export function prepareConditionalPlatformAuditOutboxInsert(
  env: Env,
  input: PlatformAuditInput,
  condition: PlatformAuditSqlCondition,
  now: number = Date.now(),
): PreparedConditionalPlatformAudit {
  const id = input.id ?? createPersistedId('platformAudit')
  const payload = redactAuditPayload(input.payload)
  return {
    id,
    input: { ...input, id, payload, ts: input.ts ?? now },
    statement: env.DB.prepare(
      `INSERT INTO platform_audit_outbox (
         id, tenant_id, org_id, action, actor_id, payload, status,
         available_at, attempt_count, created_at, updated_at
       )
       SELECT ?, ?, ?, ?, ?, ?, 'pending', ?, 0, ?, ?
        WHERE ${condition.sql}`,
    ).bind(
      id,
      input.tenantId,
      input.orgId ?? null,
      input.action,
      input.actorId ?? null,
      JSON.stringify(payload),
      now,
      now,
      now,
      ...condition.bindings,
    ),
    mutationGate: {
      sql: PLATFORM_AUDIT_MUTATION_GATE_SQL,
      bindings: [id],
    },
  }
}

async function markQueued(env: Env, id: string, now: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE platform_audit_outbox
     SET status = 'queued', queued_at = COALESCE(queued_at, ?),
         last_error_code = NULL, updated_at = ?
     WHERE id = ? AND status IN ('pending', 'queued')`,
  )
    .bind(now, now, id)
    .run()
}

async function noteQueueFailure(env: Env, id: string, now: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE platform_audit_outbox
     SET status = 'pending', available_at = ?, attempt_count = attempt_count + 1,
         last_error_code = 'audit_queue_send_failed', updated_at = ?
     WHERE id = ? AND status IN ('pending', 'queued')`,
  )
    .bind(now + RETRY_DELAY_MS, now, id)
    .run()
}

export async function enqueuePersistedPlatformAudit(
  env: Env,
  prepared: PersistedPlatformAudit,
): Promise<boolean> {
  try {
    await env.AUDIT_QUEUE.send(queueMessage(prepared))
  } catch (error) {
    try {
      await noteQueueFailure(env, prepared.id, Date.now())
    } catch (stateError) {
      logWorkerError('platform.audit_outbox.queue_failure_state_write_failed', stateError, {
        component: 'platform-audit-outbox',
        outcome: 'cron_recovery_required',
      })
    }
    logWorkerError('platform.audit_outbox.queue_send_failed', error, {
      component: 'platform-audit-outbox',
      outcome: 'cron_recovery_required',
    })
    return false
  }

  try {
    await markQueued(env, prepared.id, Date.now())
  } catch (error) {
    // Queue acceptance happened first. A Cron retry uses the same sourceMessageId, so AuditSeqDO
    // deduplicates the append if this state write was the only failed step.
    logWorkerError('platform.audit_outbox.queued_state_write_failed', error, {
      component: 'platform-audit-outbox',
      outcome: 'idempotent_redelivery_expected',
    })
  }
  return true
}

export async function recordPlatformAudit(
  env: Env,
  input: PlatformAuditInput,
): Promise<PreparedPlatformAudit> {
  const prepared = preparePlatformAuditOutboxInsert(env, input)
  await prepared.statement.run()
  await enqueuePersistedPlatformAudit(env, prepared)
  return prepared
}

type PendingPlatformAuditRow = {
  id: string
  tenantId: string
  orgId: string | null
  action: string
  actorId: string | null
  payload: string
  createdAt: number
}

function parsePayload(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('platform_audit_outbox_payload_invalid')
  }
  return parsed as Record<string, unknown>
}

export async function redeliverPendingPlatformAudits(
  env: Env,
  now: number = Date.now(),
): Promise<void> {
  const rows = (
    await env.DB.prepare(
      `SELECT id, tenant_id AS tenantId, org_id AS orgId, action, actor_id AS actorId,
              payload, created_at AS createdAt
       FROM platform_audit_outbox
       WHERE status = 'pending' AND available_at <= ?
       ORDER BY available_at ASC, id ASC
       LIMIT ?`,
    )
      .bind(now, BATCH_SIZE)
      .all<PendingPlatformAuditRow>()
  ).results

  for (const row of rows) {
    try {
      await enqueuePersistedPlatformAudit(env, {
        id: row.id,
        input: {
          id: row.id,
          tenantId: row.tenantId,
          ...(row.orgId ? { orgId: row.orgId } : {}),
          action: row.action,
          ...(row.actorId ? { actorId: row.actorId } : {}),
          payload: parsePayload(row.payload),
          ts: row.createdAt,
        },
      })
    } catch (error) {
      logWorkerError('platform.audit_outbox.redelivery_failed', error, {
        component: 'platform-audit-outbox',
        outcome: 'retry_next_cron',
      })
    }
  }
  if (rows.length === BATCH_SIZE) {
    logWorkerWarning('platform.audit_outbox.redelivery_batch_full', {
      component: 'platform-audit-outbox',
      outcome: 'remaining_rows_next_cron',
    })
  }
}

export async function completePlatformAuditOutbox(
  env: Env,
  sourceId: string,
  now: number = Date.now(),
): Promise<void> {
  if (!sourceId.startsWith(SOURCE_PREFIX)) return
  const id = sourceId.slice(SOURCE_PREFIX.length)
  if (id === '') throw new Error('platform_audit_source_id_invalid')
  await env.DB.prepare(
    `UPDATE platform_audit_outbox
     SET status = 'delivered', updated_at = ?
     WHERE id = ? AND status IN ('pending', 'queued')`,
  )
    .bind(now, id)
    .run()
}
