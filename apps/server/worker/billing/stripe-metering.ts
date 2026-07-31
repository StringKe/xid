import type { StripeMeteringQueueMessage } from '@xid-kit/types'
import { createStripeMeterEvent, stripeMeterEventName } from './stripe-client'
import { AppError } from '../lib/errors'

const METER_KEY = 'mau'
export const STRIPE_METER_PAGE_SIZE = 100
export const STRIPE_METER_PROVIDER_DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000
const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/u
const MAX_IDENTIFIER_LENGTH = 255
const STRIPE_METER_IDENTIFIER_MAX_LENGTH = 100

type MeterTarget = {
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

type PendingMeterEvent = {
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

async function reserveMeterDelta(
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

async function markMeterProviderAccepted(
  env: Env,
  input: { tenantId: string; period: string; pending: PendingMeterEvent; now: number },
): Promise<void> {
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

async function requireMeterRetryInsideProviderWindow(
  env: Env,
  input: { tenantId: string; period: string; pending: PendingMeterEvent; now: number },
): Promise<void> {
  if (input.pending.reconciliationRequiredAt !== null) {
    throw new Error('stripe_meter_reconciliation_required')
  }
  if (input.now - input.pending.reservedAt < STRIPE_METER_PROVIDER_DEDUP_WINDOW_MS) return

  await env.DB.prepare(
    `UPDATE billing_meter_reports
     SET reconciliation_required_at = COALESCE(reconciliation_required_at, ?), updated_at = ?
     WHERE tenant_id = ? AND meter_key = ? AND period = ?
       AND pending_identifier = ? AND provider_accepted_at IS NULL`,
  )
    .bind(input.now, input.now, input.tenantId, METER_KEY, input.period, input.pending.identifier)
    .run()
  const cursor = await loadCursor(env, input.tenantId, input.period)
  if (cursor?.providerAcceptedAt !== null && cursor?.providerAcceptedAt !== undefined) return
  throw new Error('stripe_meter_reconciliation_required')
}

async function finalizeMeterDelta(
  env: Env,
  input: {
    tenantId: string
    period: string
    pending: PendingMeterEvent
    now: number
  },
): Promise<void> {
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

async function reportTarget(
  env: Env,
  input: {
    target: MeterTarget
    period: string
    eventName: string
    eventTime: Date
    now: Date
  },
): Promise<void> {
  const { target, period, eventName, eventTime, now } = input
  if (
    !Number.isSafeInteger(target.targetValue) ||
    target.targetValue <= 0 ||
    target.customerId.length === 0 ||
    target.customerId.length > MAX_IDENTIFIER_LENGTH
  ) {
    throw new Error('stripe_meter_target_invalid')
  }
  const pending = await reserveMeterDelta(env, {
    target,
    period,
    eventName,
    timestampSeconds: Math.floor(eventTime.getTime() / 1000),
    now: now.getTime(),
  })
  if (!pending) return
  await requireMeterRetryInsideProviderWindow(env, {
    tenantId: target.tenantId,
    period,
    pending,
    now: now.getTime(),
  })
  if (pending.providerAcceptedAt === null) {
    await createStripeMeterEvent(env, {
      eventName: pending.eventName,
      identifier: pending.identifier,
      customerId: pending.customerId,
      value: pending.value,
      timestampSeconds: pending.timestampSeconds,
    })
    await markMeterProviderAccepted(env, {
      tenantId: target.tenantId,
      period,
      pending,
      now: now.getTime(),
    })
  }
  await finalizeMeterDelta(env, {
    tenantId: target.tenantId,
    period,
    pending,
    now: now.getTime(),
  })
}

async function loadMeterTargets(
  env: Env,
  period: string,
  cursor: string | null,
): Promise<MeterTarget[]> {
  const cursorClause = cursor === null ? '' : 'AND usage.tenant_id > ?'
  const bindings: unknown[] =
    cursor === null ? [period, STRIPE_METER_PAGE_SIZE] : [period, cursor, STRIPE_METER_PAGE_SIZE]
  const rows = await env.DB.prepare(
    `SELECT usage.tenant_id AS tenantId,
            usage.mau AS targetValue,
            plans.external_customer_id AS customerId
     FROM usage_monthly AS usage
     INNER JOIN organization_plans AS plans
       ON plans.tenant_id = usage.tenant_id
     WHERE usage.year_month = ?
       AND usage.mau > 0
       AND plans.status IN ('active', 'trialing')
       AND plans.external_customer_id IS NOT NULL
       ${cursorClause}
     ORDER BY usage.tenant_id
     LIMIT ?`,
  )
    .bind(...bindings)
    .all<MeterTarget>()
  return rows.results
}

async function loadMeterTarget(
  env: Env,
  tenantId: string,
  period: string,
): Promise<MeterTarget | null> {
  return env.DB.prepare(
    `SELECT usage.tenant_id AS tenantId,
            usage.mau AS targetValue,
            plans.external_customer_id AS customerId
     FROM usage_monthly AS usage
     INNER JOIN organization_plans AS plans
       ON plans.tenant_id = usage.tenant_id
     WHERE usage.tenant_id = ? AND usage.year_month = ?
       AND usage.mau > 0
       AND plans.status IN ('active', 'trialing')
       AND plans.external_customer_id IS NOT NULL
     LIMIT 1`,
  )
    .bind(tenantId, period)
    .first<MeterTarget>()
}

function requireStripeMeteringConfiguration(env: Env): string | null {
  const eventName = stripeMeterEventName(env)
  if (!eventName) return null
  if (!env.STRIPE_SECRET_KEY) {
    throw new AppError('service_unavailable', { httpStatus: 503 })
  }
  return eventName
}

export async function enqueueStripeMauUsageReports(
  env: Env,
  now: Date = new Date(),
): Promise<void> {
  const eventName = requireStripeMeteringConfiguration(env)
  // Metered billing is an independent opt-in. A deployer can use Stripe subscriptions without a
  // usage meter; only a configured meter name turns this daily provider path on.
  if (!eventName) return
  await env.METERING_QUEUE.send({
    type: 'stripe_mau_dispatch',
    period: now.toISOString().slice(0, 7),
    requestedAt: now.getTime(),
  })
}

async function dispatchStripeMeterPage(
  env: Env,
  message: Extract<StripeMeteringQueueMessage, { type: 'stripe_mau_dispatch' }>,
): Promise<void> {
  const targets = await loadMeterTargets(env, message.period, message.cursor ?? null)
  if (targets.length > 0) {
    await env.METERING_QUEUE.sendBatch(
      targets.map((target) => ({
        body: {
          type: 'stripe_mau_report',
          tenantId: target.tenantId,
          period: message.period,
          requestedAt: message.requestedAt,
        } satisfies StripeMeteringQueueMessage,
      })),
    )
  }
  if (targets.length === STRIPE_METER_PAGE_SIZE) {
    const cursor = targets.at(-1)?.tenantId
    if (!cursor) throw new Error('stripe_meter_dispatch_cursor_missing')
    await env.METERING_QUEUE.send({
      type: 'stripe_mau_dispatch',
      period: message.period,
      cursor,
      requestedAt: message.requestedAt,
    })
  }
}

export async function handleStripeMeteringQueueMessage(
  env: Env,
  message: StripeMeteringQueueMessage,
  now: Date = new Date(),
): Promise<void> {
  if (
    !PERIOD_PATTERN.test(message.period) ||
    !Number.isSafeInteger(message.requestedAt) ||
    message.requestedAt < 0 ||
    ('tenantId' in message &&
      (message.tenantId.length === 0 || message.tenantId.length > MAX_IDENTIFIER_LENGTH)) ||
    ('cursor' in message &&
      message.cursor !== undefined &&
      (message.cursor.length === 0 || message.cursor.length > MAX_IDENTIFIER_LENGTH))
  ) {
    throw new Error('stripe_meter_queue_message_invalid')
  }
  const eventName = requireStripeMeteringConfiguration(env)
  if (!eventName) return
  if (message.type === 'stripe_mau_dispatch') {
    await dispatchStripeMeterPage(env, message)
    return
  }

  const target = await loadMeterTarget(env, message.tenantId, message.period)
  if (!target) return
  await reportTarget(env, {
    target,
    period: message.period,
    eventName,
    eventTime: new Date(message.requestedAt),
    now,
  })
}

// Compatibility entrypoint retained for existing Cron imports. It only enqueues bounded work and
// never performs provider I/O inside the scheduled invocation.
export async function reportStripeMauUsage(env: Env, now: Date = new Date()): Promise<void> {
  await enqueueStripeMauUsageReports(env, now)
}
