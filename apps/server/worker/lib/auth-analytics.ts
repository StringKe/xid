import { createTenantDb, schema } from '@xid-kit/db'
import type { TenantContext } from '@xid-kit/types'
import { and, eq } from 'drizzle-orm'
import type { ReadSessionStatus } from './session'

type AuthAnalyticsInput = {
  env: Env
  tenant: TenantContext
  userId: string
  status: ReadSessionStatus
  timestamp: number
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
  if (input.status !== 'active') return

  try {
    await input.env.METERING_QUEUE.send({
      tenantId: input.tenant.tenantId,
      userId: input.userId,
      ts: input.timestamp,
    })
  } catch {
    try {
      await persistMeteringOutbox(input)
    } catch {
      console.error('[auth-analytics] metering outbox persistence failed')
    }
  }

  try {
    input.env.ANALYTICS.writeDataPoint({
      indexes: [input.tenant.tenantId],
      blobs: ['auth.login_success'],
      doubles: [1],
    })
  } catch {
    console.error('[auth-analytics] analytics engine write failed')
  }
}
