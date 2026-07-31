import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import type { XidHonoEnv } from '../../lib/types'
import { registerPlatformDeadLetterRoutes } from '../dead-letters'

const mocks = vi.hoisted(() => ({
  replayDeadLetter: vi.fn(),
  prepareAudit: vi.fn(),
  enqueueAudit: vi.fn(),
  requireInstanceManager: vi.fn(),
  managementDb: vi.fn(),
}))

vi.mock('../../queues', () => ({
  replayDeadLetter: mocks.replayDeadLetter,
}))

vi.mock('../audit-outbox', () => ({
  prepareConditionalPlatformAuditOutboxInsert: mocks.prepareAudit,
  enqueuePersistedPlatformAudit: mocks.enqueueAudit,
}))

vi.mock('../shared', () => ({
  decodeCursor: vi.fn(),
  encodeCursor: vi.fn(),
  managementDb: mocks.managementDb,
  parsePlatformPagination: vi.fn(),
  requireInstanceManager: mocks.requireInstanceManager,
}))

function asType<T>(value: unknown): T {
  return value as T
}

const deadLetter = {
  id: 'dlq_1',
  tenantId: 'tenant_1',
  orgId: 'org_1',
  sourceQueue: 'xid-email',
}

const preparedAudit = {
  id: 'paud_1',
  input: {
    tenantId: 'tenant_1',
    orgId: 'org_1',
    action: 'platform.queue_dead_letter.replayed',
    actorId: 'manager_1',
    payload: {},
  },
  statement: {},
  mutationGate: {
    sql: 'EXISTS (SELECT 1 FROM platform_audit_outbox WHERE id = ?)',
    bindings: ['paud_1'],
  },
}

function makeManagementDb() {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [deadLetter],
        }),
      }),
    }),
  }
}

function makeApp(): Hono<XidHonoEnv> {
  const app = new Hono<XidHonoEnv>()
  registerPlatformDeadLetterRoutes(app)
  return app
}

describe('platform dead-letter replay audit handoff', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requireInstanceManager.mockResolvedValue({ userId: 'manager_1' })
    mocks.managementDb.mockReturnValue(makeManagementDb())
    mocks.prepareAudit.mockReturnValue(preparedAudit)
    mocks.enqueueAudit.mockResolvedValue(true)
    mocks.replayDeadLetter.mockImplementation(
      async (
        _env: Env,
        id: string,
        actorId: string,
        prepareAudit: (claimedAt: number) => unknown,
      ) => {
        prepareAudit(1_234)
        return { id, status: 'replayed', replayed: true, idempotent: false, actorId }
      },
    )
  })

  it('prepares the claim-bound outbox row and enqueues it only after replay completion', async () => {
    const env = asType<Env>({})
    const response = await makeApp().request(
      'https://xid.dev/v1/platform/dead-letters/dlq_1/replay',
      { method: 'POST' },
      env,
    )

    expect(response.status).toBe(200)
    expect(mocks.replayDeadLetter).toHaveBeenCalledWith(
      env,
      'dlq_1',
      'manager_1',
      expect.any(Function),
    )
    expect(mocks.prepareAudit).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        tenantId: 'tenant_1',
        orgId: 'org_1',
        action: 'platform.queue_dead_letter.replayed',
        actorId: 'manager_1',
        payload: {
          targetType: 'queue_dead_letter',
          targetId: 'dlq_1',
          sourceQueue: 'xid-email',
        },
      }),
      expect.objectContaining({
        bindings: ['dlq_1', 1_234],
      }),
    )
    expect(mocks.enqueueAudit).toHaveBeenCalledWith(env, preparedAudit)
  })

  it('does not enqueue a second audit for an idempotent replay response', async () => {
    mocks.replayDeadLetter.mockResolvedValue({
      id: 'dlq_1',
      status: 'replayed',
      replayed: false,
      idempotent: true,
    })

    const response = await makeApp().request(
      'https://xid.dev/v1/platform/dead-letters/dlq_1/replay',
      { method: 'POST' },
      asType<Env>({}),
    )

    expect(response.status).toBe(200)
    expect(mocks.prepareAudit).not.toHaveBeenCalled()
    expect(mocks.enqueueAudit).not.toHaveBeenCalled()
  })
})
