import type { StripeMeteringQueueMessage } from '@xid-kit/types'
import { createStripeMeterEvent, StripeApiError } from './stripe-client'
import {
  clearMeterSendAfterRejection,
  finalizeMeterDelta,
  markMeterProviderAccepted,
  markMeterSendStarted,
  METER_KEY,
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
    await markMeterSendStarted(env, cursorKey)
    try {
      await createStripeMeterEvent(env, {
        eventName: pending.eventName,
        identifier: pending.identifier,
        customerId: pending.customerId,
        value: pending.value,
        timestampSeconds: pending.timestampSeconds,
      })
    } catch (cause) {
      if (pending.sentAt === null && isDefinitiveStripeRejection(cause)) {
        await clearMeterSendAfterRejection(env, cursorKey)
      }
      throw cause
    }
    await markMeterProviderAccepted(env, cursorKey)
  }
  await finalizeMeterDelta(env, cursorKey)
}

// 4xx 表示 Stripe 没有处理这次请求;409 是同一 Idempotency-Key 的请求仍在处理,结果不明。
// 网络错误、超时和 5xx 都可能已经入账。
function isDefinitiveStripeRejection(cause: unknown): boolean {
  return (
    cause instanceof StripeApiError &&
    cause.status >= 400 &&
    cause.status < 500 &&
    cause.status !== 409
  )
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
     LEFT JOIN billing_meter_reports AS reports
       ON reports.tenant_id = usage.tenant_id
      AND reports.meter_key = '${METER_KEY}'
      AND reports.period = usage.year_month
     WHERE usage.year_month = ?
       AND usage.mau > 0
       AND plans.status IN ('active', 'trialing')
       AND plans.external_customer_id IS NOT NULL
       AND (
         reports.tenant_id IS NULL
         OR (reports.reconciliation_required_at IS NULL
             AND (reports.pending_identifier IS NOT NULL OR usage.mau > reports.reported_value))
       )
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

function previousPeriod(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
    .toISOString()
    .slice(0, 7)
}

// Stripe 按 timestamp 把事件归入计费周期:补报上月差额时时间取上月最后一秒。
export function meterEventTime(period: string, requestedAt: number): Date {
  const [year, month] = period.split('-').map(Number) as [number, number]
  const periodEnd = Date.UTC(year, month, 1) - 1000
  return new Date(Math.min(requestedAt, periodEnd))
}

// 每天同时派发当月和上月:月末最后一天 02:00 之后新增的 MAU 在下一次日批补报到上月。
export async function enqueueStripeMauUsageReports(
  env: Env,
  now: Date = new Date(),
): Promise<void> {
  if (!billingEnabled(env)) return
  await env.METERING_QUEUE.sendBatch(
    [previousPeriod(now), now.toISOString().slice(0, 7)].map((period) => ({
      body: {
        type: 'stripe_mau_dispatch',
        period,
        requestedAt: now.getTime(),
      } satisfies StripeMeteringQueueMessage,
    })),
  )
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
    eventTime: meterEventTime(message.period, message.requestedAt),
    now,
  })
}

// Cron 兼容入口:只入队有界任务,scheduled 内不做 provider I/O。
export async function reportStripeMauUsage(env: Env, now: Date = new Date()): Promise<void> {
  await enqueueStripeMauUsageReports(env, now)
}
