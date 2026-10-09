import { logWorkerError, logWorkerWarning } from '../lib/safe-log'

export const METER_KEY = 'mau'
export const STRIPE_METER_PROVIDER_DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000
const STRIPE_METER_IDENTIFIER_MAX_LENGTH = 100

export type MeterTarget = {
  tenantId: string
  targetValue: number
  customerId: string
}

type MeterCursor = {
  reportedValue: number
  pendingIdentifier: string | null
  pendingValue: number | null
  pendingTarget: number | null
  pendingCustomerId: string | null
  pendingEventName: string | null
  pendingTimestamp: number | null
  pendingReservedAt: number | null
  providerAcceptedAt: number | null
  reconciliationRequiredAt: number | null
}

export type PendingMeterEvent = {
  identifier: string
  value: number
  target: number
  customerId: string
  eventName: string
  timestampSeconds: number
  reservedAt: number
  providerAcceptedAt: number | null
  reconciliationRequiredAt: number | null
}

type CursorKey = { tenantId: string; period: string; pending: PendingMeterEvent; now: number }

async function shortHash(value: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
  )
  return [...bytes.slice(0, 12)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function meterIdentifier(
  tenantId: string,
  period: string,
  reported: number,
  target: number,
): Promise<string> {
  const identifier = `xid_mau_${period.replace('-', '')}_${await shortHash(tenantId)}_${reported}_${target}`
  if (identifier.length > STRIPE_METER_IDENTIFIER_MAX_LENGTH) {
    throw new Error('stripe_meter_identifier_too_long')
  }
  return identifier
}

async function loadCursor(env: Env, tenantId: string, period: string): Promise<MeterCursor | null> {
  return env.DB.prepare(
    `SELECT reported_value AS reportedValue,
            pending_identifier AS pendingIdentifier,
            pending_value AS pendingValue,
            pending_target AS pendingTarget,
            pending_customer_id AS pendingCustomerId,
            pending_event_name AS pendingEventName,
            pending_timestamp AS pendingTimestamp,
            pending_reserved_at AS pendingReservedAt,
            provider_accepted_at AS providerAcceptedAt,
            reconciliation_required_at AS reconciliationRequiredAt
     FROM billing_meter_reports
     WHERE tenant_id = ? AND meter_key = ? AND period = ?
     LIMIT 1`,
  )
    .bind(tenantId, METER_KEY, period)
    .first<MeterCursor>()
}

function pendingFromCursor(cursor: MeterCursor): PendingMeterEvent | null {
  if (cursor.pendingIdentifier === null) return null
  if (
    cursor.pendingValue === null ||
    cursor.pendingTarget === null ||
    cursor.pendingCustomerId === null ||
    cursor.pendingEventName === null ||
    cursor.pendingTimestamp === null ||
    cursor.pendingReservedAt === null
  ) {
    throw new Error('stripe_meter_pending_cursor_incomplete')
  }
  return {
    identifier: cursor.pendingIdentifier,
    value: cursor.pendingValue,
    target: cursor.pendingTarget,
    customerId: cursor.pendingCustomerId,
    eventName: cursor.pendingEventName,
    timestampSeconds: cursor.pendingTimestamp,
    reservedAt: cursor.pendingReservedAt,
    providerAcceptedAt: cursor.providerAcceptedAt,
    reconciliationRequiredAt: cursor.reconciliationRequiredAt,
  }
}

export async function reserveMeterDelta(
  env: Env,
  input: {
    target: MeterTarget
    period: string
    eventName: string
    timestampSeconds: number
    now: number
  },
): Promise<PendingMeterEvent | null> {
  const { target, period, eventName, timestampSeconds, now } = input
  let cursor = await loadCursor(env, target.tenantId, period)
  if (!cursor) {
    const identifier = await meterIdentifier(target.tenantId, period, 0, target.targetValue)
    await env.DB.prepare(
      `INSERT INTO billing_meter_reports (
         tenant_id, meter_key, period, reported_value,
         pending_identifier, pending_value, pending_target, pending_customer_id,
         pending_event_name, pending_timestamp, pending_reserved_at,
         provider_accepted_at, reconciliation_required_at, created_at, updated_at
       ) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
       ON CONFLICT (tenant_id, meter_key, period) DO NOTHING`,
    )
      .bind(
        target.tenantId,
        METER_KEY,
        period,
        identifier,
        target.targetValue,
        target.targetValue,
        target.customerId,
        eventName,
        timestampSeconds,
        now,
        now,
        now,
      )
      .run()
    cursor = await loadCursor(env, target.tenantId, period)
    if (!cursor) throw new Error('stripe_meter_cursor_insert_failed')
  }

  const existingPending = pendingFromCursor(cursor)
  if (existingPending) return existingPending
  if (target.targetValue <= cursor.reportedValue) return null

  const identifier = await meterIdentifier(
    target.tenantId,
    period,
    cursor.reportedValue,
    target.targetValue,
  )
  await env.DB.prepare(
    `UPDATE billing_meter_reports
     SET pending_identifier = ?,
         pending_value = ?,
         pending_target = ?,
         pending_customer_id = ?,
         pending_event_name = ?,
         pending_timestamp = ?,
         pending_reserved_at = ?,
         provider_accepted_at = NULL,
         reconciliation_required_at = NULL,
         updated_at = ?
     WHERE tenant_id = ? AND meter_key = ? AND period = ?
       AND reported_value = ? AND pending_identifier IS NULL`,
  )
    .bind(
      identifier,
      target.targetValue - cursor.reportedValue,
      target.targetValue,
      target.customerId,
      eventName,
      timestampSeconds,
      now,
      now,
      target.tenantId,
      METER_KEY,
      period,
      cursor.reportedValue,
    )
    .run()
  const reserved = await loadCursor(env, target.tenantId, period)
  if (!reserved) throw new Error('stripe_meter_cursor_missing')
  return pendingFromCursor(reserved)
}

export async function markMeterProviderAccepted(env: Env, input: CursorKey): Promise<void> {
  const result = await env.DB.prepare(
    `UPDATE billing_meter_reports
     SET provider_accepted_at = COALESCE(provider_accepted_at, ?), updated_at = ?
     WHERE tenant_id = ? AND meter_key = ? AND period = ?
       AND pending_identifier = ? AND reconciliation_required_at IS NULL`,
  )
    .bind(input.now, input.now, input.tenantId, METER_KEY, input.period, input.pending.identifier)
    .run()
  if (result.meta.changes === 1) return
  const cursor = await loadCursor(env, input.tenantId, input.period)
  if (
    cursor &&
    (cursor.providerAcceptedAt !== null ||
      (cursor.pendingIdentifier === null && cursor.reportedValue >= input.pending.target))
  ) {
    return
  }
  throw new Error('stripe_meter_provider_acceptance_persist_failed')
}

// 超出 Stripe 去重窗口且未确认受理时不能重发;billing_meter_reports.reconciliation_required_at
// 保留给运维人工对账,后续日批跳过该游标,避免每天重复失败并产生新的死信。
export async function meterRetryAllowed(env: Env, input: CursorKey): Promise<boolean> {
  if (input.pending.reconciliationRequiredAt !== null) {
    logWorkerWarning('billing.stripe_meter.reconciliation_pending', {
      component: 'stripe-metering',
      operation: 'report_mau',
      outcome: 'skipped',
    })
    return false
  }
  if (input.now - input.pending.reservedAt < STRIPE_METER_PROVIDER_DEDUP_WINDOW_MS) return true

  await env.DB.prepare(
    `UPDATE billing_meter_reports
     SET reconciliation_required_at = COALESCE(reconciliation_required_at, ?), updated_at = ?
     WHERE tenant_id = ? AND meter_key = ? AND period = ?
       AND pending_identifier = ? AND provider_accepted_at IS NULL`,
  )
    .bind(input.now, input.now, input.tenantId, METER_KEY, input.period, input.pending.identifier)
    .run()
  const cursor = await loadCursor(env, input.tenantId, input.period)
  if (cursor?.providerAcceptedAt !== null && cursor?.providerAcceptedAt !== undefined) return true
  logWorkerError('billing.stripe_meter.reconciliation_required', undefined, {
    component: 'stripe-metering',
    operation: 'report_mau',
    outcome: 'skipped',
  })
  return false
}

export async function finalizeMeterDelta(env: Env, input: CursorKey): Promise<void> {
  const { tenantId, period, pending, now } = input
  const result = await env.DB.prepare(
    `UPDATE billing_meter_reports
     SET reported_value = ?,
         pending_identifier = NULL,
         pending_value = NULL,
         pending_target = NULL,
         pending_customer_id = NULL,
         pending_event_name = NULL,
         pending_timestamp = NULL,
         pending_reserved_at = NULL,
         provider_accepted_at = NULL,
         reconciliation_required_at = NULL,
         updated_at = ?
     WHERE tenant_id = ? AND meter_key = ? AND period = ?
       AND pending_identifier = ?`,
  )
    .bind(pending.target, now, tenantId, METER_KEY, period, pending.identifier)
    .run()
  if (result.meta.changes === 1) return
  const cursor = await loadCursor(env, tenantId, period)
  if (cursor && cursor.pendingIdentifier === null && cursor.reportedValue >= pending.target) return
  throw new Error('stripe_meter_cursor_finalize_failed')
}
