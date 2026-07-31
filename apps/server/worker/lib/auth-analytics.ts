import { createTenantDb, schema } from '@xid-kit/db'
import type { TenantContext } from '@xid-kit/types'
import { and, eq } from 'drizzle-orm'
import type { ReadSessionStatus } from './session'
import { logWorkerError } from './safe-log'

type AuthAnalyticsInput = {
  env: Env
  tenant: TenantContext
  userId: string
  status: ReadSessionStatus
  timestamp: number
  // guest(provisioned_by = 'anonymous')不计 MAU/DAU:调用方从 users 行带来,缺失按普通用户计。
  provisionedBy?: string | null
  // Support impersonation is not a target-user authentication or billable active-user event.
  isImpersonation?: boolean
}

function utcDay(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10)
}

async function persistMeteringOutbox(input: AuthAnalyticsInput): Promise<void> {
  const db = createTenantDb(input.env.DB, input.tenant)
  const occurredAt = new Date(input.timestamp)
  const values = {
    id: `met_${crypto.randomUUID()}`,
    tenantId: input.tenant.tenantId,
    userId: input.userId,
    day: utcDay(input.timestamp),
    occurredAt,
  }
  try {
    await db.meteringOutbox.insert(values)
  } catch {
    const rows = await db.meteringOutbox.update(
      { occurredAt, deliveredAt: null, lastErrorCode: null },
      and(
        eq(schema.meteringOutbox.userId, input.userId),
        eq(schema.meteringOutbox.day, values.day),
      ),
    )
    if (rows.length === 0) throw new Error('metering outbox event not found after insert conflict')
  }
}

export async function recordAuthenticatedSession(input: AuthAnalyticsInput): Promise<void> {
  if (input.status !== 'active' || input.isImpersonation) return

  // 计量排除:guest 不计 MAU/DAU( queue 与 outbox 兜底同路径跳过);Analytics 登录事件照记。
  if (input.provisionedBy !== schema.USER_PROVISIONED_BY_ANONYMOUS) {
    try {
      await input.env.METERING_QUEUE.send({
        tenantId: input.tenant.tenantId,
        userId: input.userId,
        ts: input.timestamp,
      })
    } catch {
      try {
        await persistMeteringOutbox(input)
      } catch (error) {
        logWorkerError('auth_analytics.metering_outbox.persistence_failed', error, {
          component: 'auth-analytics',
        })
      }
    }
  }

  try {
    input.env.ANALYTICS.writeDataPoint({
      indexes: [input.tenant.tenantId],
      blobs: ['auth.login_success'],
      doubles: [1],
    })
  } catch (error) {
    logWorkerError('auth_analytics.analytics_engine.write_failed', error, {
      component: 'auth-analytics',
    })
  }
}
