// Metering Queue Consumer:认证成功事件去重 + MAU 聚合 + 写 usage_daily 与当月 usage_monthly。
// 见 docs/design/07-platform-operations.md 第 7 节、7.1.2。
// - 按 tenant_id 分组,路由到 MeteringDO(metering:{tenantId})串行去重,解决 KV RMW 竞态。
// - DAU:由 MeteringDO 返回精确日快照，D1 只做单调覆盖，Queue 重投不重复累计。
// - MeteringDO.recordUser 幂等(per-user membership 键去重)，重复计量事件不增 MAU。

import type {
  MeteringQueueEnvelope,
  MeteringQueueMessage,
  StripeMeteringQueueMessage,
} from '@xid-kit/types'
import { handleStripeMeteringQueueMessage } from '../billing/stripe-metering'
import { logWorkerError } from '../lib/safe-log'

const STRIPE_PROVIDER_CONCURRENCY = 10
// xid-metering 的 max_retries 为 5:30 分钟起翻倍,五次重试共约 15.5 小时,都落在 Stripe
// 24 小时去重窗口内,短暂故障不会让结果不明的上报进入人工对账。
const STRIPE_RETRY_BASE_SECONDS = 30 * 60
const QUEUE_MAX_RETRY_DELAY_SECONDS = 12 * 60 * 60

export function stripeRetryDelaySeconds(attempts: number): number {
  const exponent = Number.isSafeInteger(attempts) && attempts > 1 ? attempts - 1 : 0
  return Math.min(STRIPE_RETRY_BASE_SECONDS * 2 ** exponent, QUEUE_MAX_RETRY_DELAY_SECONDS)
}

// MeteringDO RPC stub 形状(见 metering-do.ts)。
type MeteringStub = {
  recordUser(
    tenantId: string,
    userId: string,
    yearMonth: string,
    day: string,
  ): Promise<{ dau: number; mau: number }>
}

type MeteringSnapshot = {
  day: string
  yearMonth: string
  dau: number
  mau: number
}

// ts(Unix 毫秒)-> "YYYY-MM"(UTC)。
export function toYearMonth(ts: number): string {
  const d = new Date(ts)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  return `${y}-${m}`
}

// ts(Unix 毫秒)-> "YYYY-MM-DD"(UTC)。
export function toDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10)
}

function getMeteringStub(env: Env, tenantId: string): MeteringStub {
  const id = env.METERING.idFromName(`metering:${tenantId}`)
  return env.METERING.get(id) as unknown as DurableObjectStub & MeteringStub
}

function groupByTenant(
  messages: ReadonlyArray<Message<MeteringQueueMessage>>,
): Map<string, Array<Message<MeteringQueueMessage>>> {
  const groups = new Map<string, Array<Message<MeteringQueueMessage>>>()
  for (const message of messages) {
    const tenantId = message.body.tenantId
    const existing = groups.get(tenantId)
    if (existing === undefined) {
      groups.set(tenantId, [message])
    } else {
      existing.push(message)
    }
  }
  return groups
}

function isStripeMeteringMessage(body: MeteringQueueEnvelope): body is StripeMeteringQueueMessage {
  return (
    'type' in body && (body.type === 'stripe_mau_dispatch' || body.type === 'stripe_mau_report')
  )
}

async function handleStripeMessage(
  message: Message<StripeMeteringQueueMessage>,
  env: Env,
): Promise<void> {
  try {
    await handleStripeMeteringQueueMessage(env, message.body)
    message.ack()
  } catch (cause) {
    logWorkerError('billing.stripe_meter_queue_failed', cause, {
      component: 'metering-queue',
      operation: message.body.type,
      outcome: 'queue_retry',
    })
    message.retry({ delaySeconds: stripeRetryDelaySeconds(message.attempts) })
  }
}

async function handleStripeMessages(
  messages: ReadonlyArray<Message<StripeMeteringQueueMessage>>,
  env: Env,
): Promise<void> {
  const dispatchMessages = messages.filter((message) => message.body.type === 'stripe_mau_dispatch')
  const reportMessages = messages.filter((message) => message.body.type === 'stripe_mau_report')
  const firstDispatch = dispatchMessages[0]
  if (firstDispatch) await handleStripeMessage(firstDispatch, env)
  for (const deferred of dispatchMessages.slice(1)) {
    deferred.retry({ delaySeconds: 1 })
  }

  for (let offset = 0; offset < reportMessages.length; offset += STRIPE_PROVIDER_CONCURRENCY) {
    await Promise.all(
      reportMessages
        .slice(offset, offset + STRIPE_PROVIDER_CONCURRENCY)
        .map((message) => handleStripeMessage(message, env)),
    )
  }
}

function maxBy(
  snapshots: ReadonlyArray<MeteringSnapshot>,
  key: 'day' | 'yearMonth',
  value: 'dau' | 'mau',
): Map<string, number> {
  const latest = new Map<string, number>()
  for (const snapshot of snapshots) {
    latest.set(snapshot[key], Math.max(latest.get(snapshot[key]) ?? 0, snapshot[value]))
  }
  return latest
}

// DO 返回的日、月精确快照在同一个 D1 batch 里单调覆盖，当月 MAU 不会落后于当日 DAU。
// D1 成功而 ack 失败时，重投只会覆盖同一值。
async function upsertUsage(
  env: Env,
  tenantId: string,
  snapshots: ReadonlyArray<MeteringSnapshot>,
): Promise<void> {
  const now = Date.now()
  const archivedAt = new Date(now).toISOString()
  const dailyStatements = Array.from(maxBy(snapshots, 'day', 'dau')).map(([day, dau]) =>
    env.DB.prepare(
      `INSERT INTO usage_daily (tenant_id, day, dau, api_calls, email_count, created_at, updated_at)
       VALUES (?, ?, ?, 0, 0, ?, ?)
       ON CONFLICT (tenant_id, day) DO UPDATE SET dau = MAX(usage_daily.dau, excluded.dau), updated_at = excluded.updated_at`,
    ).bind(tenantId, day, dau, now, now),
  )
  const monthlyStatements = Array.from(maxBy(snapshots, 'yearMonth', 'mau')).map(
    ([yearMonth, mau]) =>
      env.DB.prepare(
        `INSERT INTO usage_monthly (tenant_id, year_month, mau, archived_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (tenant_id, year_month) DO UPDATE SET mau = MAX(usage_monthly.mau, excluded.mau), archived_at = excluded.archived_at`,
      ).bind(tenantId, yearMonth, mau, archivedAt),
  )
  const statements = [...dailyStatements, ...monthlyStatements]
  if (statements.length > 0) {
    await env.DB.batch(statements)
  }
}

export async function handleMeteringBatch(
  batch: MessageBatch<MeteringQueueEnvelope>,
  env: Env,
): Promise<void> {
  const identityMessages: Array<Message<MeteringQueueMessage>> = []
  const stripeMessages: Array<Message<StripeMeteringQueueMessage>> = []
  for (const message of batch.messages) {
    if (isStripeMeteringMessage(message.body)) {
      stripeMessages.push(message as Message<StripeMeteringQueueMessage>)
    } else {
      identityMessages.push(message as Message<MeteringQueueMessage>)
    }
  }

  const groups = groupByTenant(identityMessages)
  for (const [tenantId, messages] of groups) {
    try {
      const stub = getMeteringStub(env, tenantId)
      const snapshots: MeteringSnapshot[] = []
      // DO 将月度和日度集合一起持久化。每条消息获得该日的精确总数快照。
      for (const message of messages) {
        const yearMonth = toYearMonth(message.body.ts)
        const day = toDay(message.body.ts)
        const snapshot = await stub.recordUser(tenantId, message.body.userId, yearMonth, day)
        snapshots.push({ day, yearMonth, dau: snapshot.dau, mau: snapshot.mau })
      }
      await upsertUsage(env, tenantId, snapshots)
      for (const message of messages) {
        message.ack()
      }
    } catch (cause) {
      logWorkerError('metering.record_failed', cause, {
        component: 'metering-queue',
        operation: 'record_user',
        outcome: 'queue_retry',
      })
      for (const message of messages) {
        message.retry()
      }
    }
  }
  await handleStripeMessages(stripeMessages, env)
}
