import type { StripeMeteringQueueMessage } from '@xid-kit/types'
import { METER_KEY, meterIdentifier } from './stripe-meter-cursor'
import { AppError } from '../lib/errors'
import {
  enqueuePersistedPlatformAudit,
  prepareConditionalPlatformAuditOutboxInsert,
} from '../platform/audit-outbox'

// Stripe 只接受 35 天内的 meter event timestamp;更早的增量只能由运维确认后标记为已上报。
export const STRIPE_METER_MAX_BACKDATE_MS = 35 * 24 * 60 * 60 * 1000

export const METER_RECONCILIATION_ACTIONS = ['mark_reported', 'report_again'] as const
export type MeterReconciliationAction = (typeof METER_RECONCILIATION_ACTIONS)[number]

export type MeterReconciliationItem = {
  tenantId: string
  organizationName: string | null
  period: string
  identifier: string
  value: number
  reportedValue: number
  targetValue: number
  customerId: string
  eventTimestamp: string
  sentAt: string | null
  reconciliationRequiredAt: string
}

type ReconciliationRow = {
  tenantId: string
  organizationName: string | null
  period: string
  identifier: string
  value: number
  reportedValue: number
  targetValue: number
  customerId: string
  eventTimestamp: number
  sentAt: number | null
  reconciliationRequiredAt: number
}

export type MeterReconciliationRequest = {
  tenantId: string
  period: string
  identifier: string
  action: MeterReconciliationAction
  actorId: string
  now: number
}

const SELECT_COLUMNS = `reports.tenant_id AS tenantId,
       organizations.name AS organizationName,
       reports.period AS period,
       reports.pending_identifier AS identifier,
       reports.pending_value AS value,
       reports.reported_value AS reportedValue,
       reports.pending_target AS targetValue,
       reports.pending_customer_id AS customerId,
       reports.pending_timestamp AS eventTimestamp,
       reports.pending_sent_at AS sentAt,
       reports.reconciliation_required_at AS reconciliationRequiredAt`

const FROM_RECONCILIATION = `FROM billing_meter_reports AS reports
  LEFT JOIN organizations
    ON organizations.id = reports.tenant_id AND organizations.tenant_id = reports.tenant_id
  WHERE reports.meter_key = '${METER_KEY}'
    AND reports.reconciliation_required_at IS NOT NULL
    AND reports.pending_identifier IS NOT NULL`

function toItem(row: ReconciliationRow): MeterReconciliationItem {
  return {
    ...row,
    eventTimestamp: new Date(row.eventTimestamp * 1000).toISOString(),
    sentAt: row.sentAt === null ? null : new Date(row.sentAt).toISOString(),
    reconciliationRequiredAt: new Date(row.reconciliationRequiredAt).toISOString(),
  }
}

// 游标是上一页最后一行的 "tenantId\nperiod",按 (tenant_id, period) 递增翻页。
export async function listMeterReconciliations(
  env: Env,
  input: { limit: number; after: { tenantId: string; period: string } | null },
): Promise<{ items: MeterReconciliationItem[]; hasMore: boolean; total: number }> {
  const after = input.after
  const cursorClause =
    after === null
      ? ''
      : 'AND (reports.tenant_id > ? OR (reports.tenant_id = ? AND reports.period > ?))'
  const bindings: unknown[] =
    after === null
      ? [input.limit + 1]
      : [after.tenantId, after.tenantId, after.period, input.limit + 1]
  const [rows, count] = await Promise.all([
    env.DB.prepare(
      `SELECT ${SELECT_COLUMNS}
       ${FROM_RECONCILIATION}
       ${cursorClause}
       ORDER BY reports.tenant_id, reports.period
       LIMIT ?`,
    )
      .bind(...bindings)
      .all<ReconciliationRow>(),
    env.DB.prepare(`SELECT COUNT(*) AS value ${FROM_RECONCILIATION}`).first<{ value: number }>(),
  ])
  return {
    items: rows.results.slice(0, input.limit).map(toItem),
    hasMore: rows.results.length > input.limit,
    total: count?.value ?? 0,
  }
}

async function loadReconciliation(
  env: Env,
  request: MeterReconciliationRequest,
): Promise<ReconciliationRow> {
  const row = await env.DB.prepare(
    `SELECT ${SELECT_COLUMNS}
     ${FROM_RECONCILIATION}
       AND reports.tenant_id = ? AND reports.period = ?
     LIMIT 1`,
  )
    .bind(request.tenantId, request.period)
    .first<ReconciliationRow>()
  if (!row) throw new AppError('not_found', { httpStatus: 404 })
  if (row.identifier !== request.identifier) throw new AppError('conflict', { httpStatus: 409 })
  return row
}

function randomAttempt(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4))
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function mutationStatement(
  env: Env,
  input: { newIdentifier: string | null; gateSql: string },
): D1PreparedStatement {
  const { newIdentifier, gateSql } = input
  const keyClause = `WHERE tenant_id = ? AND meter_key = ? AND period = ?
       AND pending_identifier = ? AND reconciliation_required_at IS NOT NULL
       AND ${gateSql}`
  if (newIdentifier === null) {
    return env.DB.prepare(
      `UPDATE billing_meter_reports
       SET reported_value = pending_target,
           pending_identifier = NULL, pending_value = NULL, pending_target = NULL,
           pending_customer_id = NULL, pending_event_name = NULL, pending_timestamp = NULL,
           pending_reserved_at = NULL, pending_sent_at = NULL, provider_accepted_at = NULL,
           reconciliation_required_at = NULL, updated_at = ?
       ${keyClause}`,
    )
  }
  return env.DB.prepare(
    `UPDATE billing_meter_reports
     SET pending_identifier = ?, pending_reserved_at = ?,
         pending_sent_at = NULL, provider_accepted_at = NULL,
         reconciliation_required_at = NULL, updated_at = ?
     ${keyClause}`,
  )
}

// 运维在 Stripe 后台核对后二选一:事件已入账则标记为已上报;没有入账则换新 identifier 重报。
// 审计记录与游标更新在同一个 D1 batch 里提交。
export async function resolveMeterReconciliation(
  env: Env,
  request: MeterReconciliationRequest,
): Promise<{ identifier: string | null }> {
  const row = await loadReconciliation(env, request)
  const reportAgain = request.action === 'report_again'
  if (reportAgain && request.now - row.eventTimestamp * 1000 > STRIPE_METER_MAX_BACKDATE_MS) {
    throw new AppError('validation_failed', { httpStatus: 422, meta: { paramName: 'action' } })
  }
  const newIdentifier = reportAgain
    ? await meterIdentifier(
        {
          tenantId: row.tenantId,
          period: row.period,
          reported: row.reportedValue,
          target: row.targetValue,
        },
        randomAttempt(),
      )
    : null
  const audit = prepareConditionalPlatformAuditOutboxInsert(
    env,
    {
      tenantId: row.tenantId,
      action: reportAgain
        ? 'billing.meter_report.reported_again'
        : 'billing.meter_report.marked_reported',
      actorId: request.actorId,
      payload: {
        targetType: 'billing_meter_report',
        targetId: `${row.tenantId}:${row.period}`,
        period: row.period,
        identifier: row.identifier,
        newIdentifier,
        value: row.value,
      },
    },
    {
      sql: `EXISTS (
        SELECT 1 FROM billing_meter_reports
        WHERE tenant_id = ? AND meter_key = ? AND period = ?
          AND pending_identifier = ? AND reconciliation_required_at IS NOT NULL
      )`,
      bindings: [row.tenantId, METER_KEY, row.period, row.identifier],
    },
    request.now,
  )
  const updateBindings =
    newIdentifier === null ? [request.now] : [newIdentifier, request.now, request.now]
  const results = await env.DB.batch([
    audit.statement,
    mutationStatement(env, { newIdentifier, gateSql: audit.mutationGate.sql }).bind(
      ...updateBindings,
      row.tenantId,
      METER_KEY,
      row.period,
      row.identifier,
      ...audit.mutationGate.bindings,
    ),
  ])
  if (results[1]?.meta.changes !== 1) throw new AppError('conflict', { httpStatus: 409 })
  await enqueuePersistedPlatformAudit(env, audit)
  if (reportAgain) {
    await env.METERING_QUEUE.send({
      type: 'stripe_mau_report',
      tenantId: row.tenantId,
      period: row.period,
      requestedAt: request.now,
    } satisfies StripeMeteringQueueMessage)
  }
  return { identifier: newIdentifier }
}
