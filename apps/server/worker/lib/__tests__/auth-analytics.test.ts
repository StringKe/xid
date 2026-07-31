import { describe, expect, it, vi } from 'vitest'
import { createTenantDb } from '@xid-kit/db'
import type { TenantContext } from '@xid-kit/types'
import { recordAuthenticatedSession } from '../auth-analytics'

vi.mock('@xid-kit/db', () => ({
  createTenantDb: vi.fn(),
  schema: {
    meteringOutbox: { userId: 'userId', day: 'day' },
    USER_PROVISIONED_BY_ANONYMOUS: 'anonymous',
  },
}))

function tenant(): TenantContext {
  return { tenantId: 'tenant_1' } as TenantContext
}

function makeEnv(input: { queueRejects?: boolean; analyticsRejects?: boolean } = {}): {
  env: Env
  queueSend: ReturnType<typeof vi.fn>
  writeDataPoint: ReturnType<typeof vi.fn>
} {
  const queueSend = input.queueRejects
    ? vi.fn().mockRejectedValue(new Error('queue unavailable'))
    : vi.fn().mockResolvedValue(undefined)
  const writeDataPoint = input.analyticsRejects
    ? vi.fn(() => {
        throw new Error('analytics unavailable')
      })
    : vi.fn()
  return {
    env: {
      METERING_QUEUE: { send: queueSend },
      ANALYTICS: { writeDataPoint },
    } as unknown as Env,
    queueSend,
    writeDataPoint,
  }
}

describe('recordAuthenticatedSession', () => {
  it('persists one idempotent outbox event when metering queue send fails', async () => {
    const { env, queueSend } = makeEnv({ queueRejects: true })
    const insert = vi.fn().mockResolvedValue({ id: 'met_1' })
    vi.mocked(createTenantDb).mockReturnValue({
      meteringOutbox: { insert },
    } as unknown as ReturnType<typeof createTenantDb>)

    await expect(
      recordAuthenticatedSession({
        env,
        tenant: tenant(),
        userId: 'user_1',
        status: 'active',
        timestamp: Date.UTC(2025, 0, 15),
      }),
    ).resolves.toBeUndefined()

    expect(queueSend).toHaveBeenCalledOnce()
    expect(createTenantDb).toHaveBeenCalledWith(env.DB, tenant())
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant_1',
        userId: 'user_1',
        day: '2025-01-15',
        occurredAt: new Date(Date.UTC(2025, 0, 15)),
      }),
    )
  })

  it('reopens a delivered same-day outbox event after an insert conflict', async () => {
    const { env } = makeEnv({ queueRejects: true })
    const update = vi.fn().mockResolvedValue([{ id: 'met_1' }])
    vi.mocked(createTenantDb).mockReturnValue({
      meteringOutbox: {
        insert: vi.fn().mockRejectedValue(new Error('unique constraint failed')),
        update,
      },
    } as unknown as ReturnType<typeof createTenantDb>)

    await expect(
      recordAuthenticatedSession({
        env,
        tenant: tenant(),
        userId: 'user_1',
        status: 'active',
        timestamp: Date.UTC(2025, 0, 15),
      }),
    ).resolves.toBeUndefined()

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        occurredAt: new Date(Date.UTC(2025, 0, 15)),
        deliveredAt: null,
        lastErrorCode: null,
      }),
      expect.anything(),
    )
  })

  it('writes one anonymous login event and one metering event for active sessions', async () => {
    const { env, queueSend, writeDataPoint } = makeEnv()
    await recordAuthenticatedSession({
      env,
      tenant: tenant(),
      userId: 'user_1',
      status: 'active',
      timestamp: 1_700_000_000_000,
    })
    expect(queueSend).toHaveBeenCalledWith({
      tenantId: 'tenant_1',
      userId: 'user_1',
      ts: 1_700_000_000_000,
    })
    expect(writeDataPoint).toHaveBeenCalledWith({
      indexes: ['tenant_1'],
      blobs: ['auth.login_success'],
      doubles: [1],
    })
    expect(JSON.stringify(writeDataPoint.mock.calls)).not.toContain('user_1')
  })

  it('does not count pending MFA sessions as authenticated logins', async () => {
    const { env, queueSend, writeDataPoint } = makeEnv()
    await recordAuthenticatedSession({
      env,
      tenant: tenant(),
      userId: 'user_1',
      status: 'pending_mfa',
      timestamp: 1,
    })
    expect(queueSend).not.toHaveBeenCalled()
    expect(writeDataPoint).not.toHaveBeenCalled()
  })

  it('does not count support impersonation as a login or billable active user', async () => {
    const { env, queueSend, writeDataPoint } = makeEnv()
    await recordAuthenticatedSession({
      env,
      tenant: tenant(),
      userId: 'user_target',
      status: 'active',
      timestamp: 1,
      isImpersonation: true,
    })
    expect(queueSend).not.toHaveBeenCalled()
    expect(writeDataPoint).not.toHaveBeenCalled()
  })

  it('excludes guest (provisioned_by anonymous) sessions from MAU metering but keeps analytics', async () => {
    vi.mocked(createTenantDb).mockClear()
    const { env, queueSend, writeDataPoint } = makeEnv({ queueRejects: true })
    await recordAuthenticatedSession({
      env,
      tenant: tenant(),
      userId: 'user_guest',
      status: 'active',
      timestamp: 1_700_000_000_000,
      provisionedBy: 'anonymous',
    })
    // 计量排除:queue 与 outbox 兜底同路径跳过(createTenantDb 不应被触达)。
    expect(queueSend).not.toHaveBeenCalled()
    expect(createTenantDb).not.toHaveBeenCalled()
    expect(writeDataPoint).toHaveBeenCalledWith({
      indexes: ['tenant_1'],
      blobs: ['auth.login_success'],
      doubles: [1],
    })
  })

  it('contains outbox and analytics failures without rejecting successful authentication', async () => {
    const { env, writeDataPoint } = makeEnv({ queueRejects: true, analyticsRejects: true })
    vi.mocked(createTenantDb).mockReturnValue({
      meteringOutbox: { insert: vi.fn().mockRejectedValue(new Error('database unavailable')) },
    } as unknown as ReturnType<typeof createTenantDb>)
    await expect(
      recordAuthenticatedSession({
        env,
        tenant: tenant(),
        userId: 'user_1',
        status: 'active',
        timestamp: 1,
      }),
    ).resolves.toBeUndefined()
    expect(writeDataPoint).toHaveBeenCalledOnce()
  })
})
