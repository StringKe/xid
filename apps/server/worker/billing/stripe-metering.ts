import type { StripeMeteringQueueMessage } from '@xid-kit/types'
import { createStripeMeterEvent } from './stripe-client'
import {
  finalizeMeterDelta,
  markMeterProviderAccepted,
  meterRetryAllowed,
  reserveMeterDelta,
  type MeterTarget,
} from './stripe-meter-cursor'
import { billingEnabled, usageBillingConfiguration } from '../lib/usage-billing'

export const STRIPE_METER_PAGE_SIZE = 100
const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/u
const MAX_IDENTIFIER_LENGTH = 255

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
  const cursorKey = { tenantId: target.tenantId, period, pending, now: now.getTime() }
  if (!(await meterRetryAllowed(env, cursorKey))) return
  if (pending.providerAcceptedAt === null) {
    await createStripeMeterEvent(env, {
      eventName: pending.eventName,
      identifier: pending.identifier,
      customerId: pending.customerId,
      value: pending.value,
      timestampSeconds: pending.timestampSeconds,
    })
    await markMeterProviderAccepted(env, cursorKey)
  }
  await finalizeMeterDelta(env, cursorKey)
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

export async function enqueueStripeMauUsageReports(
  env: Env,
  now: Date = new Date(),
): Promise<void> {
  if (!billingEnabled(env)) return
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
  const config = usageBillingConfiguration(env)
  if (!config) return
  const eventName = config.meterEventName
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

// Cron 兼容入口:只入队有界任务,scheduled 内不做 provider I/O。
export async function reportStripeMauUsage(env: Env, now: Date = new Date()): Promise<void> {
  await enqueueStripeMauUsageReports(env, now)
}
