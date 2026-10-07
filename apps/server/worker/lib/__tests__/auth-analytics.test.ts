import { describe, expect, it, vi } from 'vitest'
import { createTenantDb } from '@xid-kit/db'
import { AUTH_LOGIN_SUCCEEDED_EVENT } from '@xid-kit/types'
import type { TenantContext } from '@xid-kit/types'
import { recordAuthenticatedSession } from '../auth-analytics'

vi.mock('@xid-kit/db', () => ({
  createTenantDb: vi.fn(),
  schema: {
    meteringOutbox: { userId: 'userId', day: 'day' },
    users: { id: 'id' },
    USER_PROVISIONED_BY_ANONYMOUS: 'anonymous',
  },
}))

function tenant(): TenantContext {
  return { tenantId: 'tenant_1' } as TenantContext
}

function makeEnv(input: { queueRejects?: boolean; analyticsRejects?: boolean } = {}): {
  env: Env
  queueSend: ReturnType<typeof vi.fn>
  auditSend: ReturnType<typeof vi.fn>
  writeDataPoint: ReturnType<typeof vi.fn>
} {
  const auditSend = vi.fn().mockResolvedValue(undefined)
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
      AUDIT_QUEUE: { send: auditSend },
      ANALYTICS: { writeDataPoint },
    } as unknown as Env,
    queueSend,
    auditSend,
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

  it('queues one login success audit event for the overview success rate', async () => {
    const { env, auditSend } = makeEnv()

    await recordAuthenticatedSession({
      env,
      tenant: tenant(),
      userId: 'user_1',
      status: 'active',
      timestamp: 1_700_000_000_000,
    })

    expect(auditSend).toHaveBeenCalledWith({
      tenantId: 'tenant_1',
      action: AUTH_LOGIN_SUCCEEDED_EVENT,
      actorId: 'user_1',
      ts: 1_700_000_000_000,
      payload: {},
    })
  })

  it('does not count pending MFA or impersonation sessions as authenticated logins', async () => {
    const { env, queueSend, auditSend, writeDataPoint } = makeEnv()
    await recordAuthenticatedSession({
      env,
      tenant: tenant(),
      userId: 'user_1',
      status: 'pending_mfa',
      timestamp: 1,
    })
    await recordAuthenticatedSession({
      env,
      tenant: tenant(),
      userId: 'user_1',
      status: 'active',
      timestamp: 1,
      isImpersonation: true,
    })
    expect(queueSend).not.toHaveBeenCalled()
    expect(auditSend).not.toHaveBeenCalled()
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

  it('records the sign-in time on the tenant-scoped user row', async () => {
    const { env } = makeEnv()
    const update = vi.fn().mockResolvedValue([{ id: 'user_1' }])
    vi.mocked(createTenantDb).mockReturnValue({
      users: { update },
    } as unknown as ReturnType<typeof createTenantDb>)

    await recordAuthenticatedSession({
      env,
      tenant: tenant(),
      userId: 'user_1',
      status: 'active',
      timestamp: Date.UTC(2025, 0, 15),
    })

    expect(createTenantDb).toHaveBeenCalledWith(env.DB, tenant())
    expect(update).toHaveBeenCalledWith(
      { lastLoginAt: new Date(Date.UTC(2025, 0, 15)) },
      expect.anything(),
    )
  })

  it('excludes guest (provisioned_by anonymous) sessions from MAU metering but keeps analytics', async () => {
    const insert = vi.fn()
    vi.mocked(createTenantDb).mockReturnValue({
      meteringOutbox: { insert },
      users: { update: vi.fn().mockResolvedValue([]) },
    } as unknown as ReturnType<typeof createTenantDb>)
    const { env, queueSend, writeDataPoint } = makeEnv({ queueRejects: true })
    await recordAuthenticatedSession({
      env,
      tenant: tenant(),
      userId: 'user_guest',
      status: 'active',
      timestamp: 1_700_000_000_000,
      provisionedBy: 'anonymous',
    })
    // 计量排除:queue 与 outbox 兜底同路径跳过。
    expect(queueSend).not.toHaveBeenCalled()
    expect(insert).not.toHaveBeenCalled()
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
