// POST /v1/sessions/active-organization 单测:
// cookie session 认证、active membership + active org 校验、清空 active org、拒绝跨 org/soft deleted org。

import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('@xid-kit/db', () => ({
  createTenantDb: vi.fn(),
  schema: {
    memberships: { userId: 'userId', orgId: 'orgId', status: 'status' },
    organizations: { id: 'id', status: 'status', deletedAt: 'deletedAt' },
    sessions: { id: 'id', userId: 'userId', status: 'status' },
  },
}))

vi.mock('../../lib/session', () => ({
  readSession: vi.fn(),
  ACTIVE_SESSION_STATUS: 'active',
  PENDING_MFA_SESSION_STATUS: 'pending_mfa',
  PENDING_MFA_SETUP_SESSION_STATUS: 'pending_mfa_setup',
}))

import { createTenantDb } from '@xid-kit/db'
import { registerSessionAuthRoutes } from '../index'
import { execCtx, makeApp, makeEnv, makeSession } from './helpers'

function makeDb(options: {
  membership?: Record<string, unknown> | null
  organization?: Record<string, unknown> | null
  update?: ReturnType<typeof vi.fn>
}) {
  return {
    memberships: {
      findOne: vi.fn().mockResolvedValue(options.membership ?? null),
    },
    organizations: {
      findOne: vi.fn().mockResolvedValue(options.organization ?? null),
    },
    sessions: {
      update: options.update ?? vi.fn().mockResolvedValue([]),
    },
  }
}

async function post(body: unknown, db: ReturnType<typeof makeDb>, session = makeSession()) {
  vi.mocked(createTenantDb).mockReturnValue(db as never)
  const app = makeApp(registerSessionAuthRoutes, { session })
  return app.request(
    '/v1/sessions/active-organization',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    makeEnv(),
    execCtx,
  )
}

describe('POST /v1/sessions/active-organization', () => {
  beforeEach(() => vi.clearAllMocks())

  it('sets active organization for current session membership', async () => {
    const update = vi.fn().mockResolvedValue([])
    const db = makeDb({
      membership: { id: 'mem-1' },
      organization: { id: 'org-1', status: 'active', deletedAt: null },
      update,
    })

    const res = await post({ organizationId: 'org-1' }, db)

    expect(res.status).toBe(200)
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ activeOrgId: 'org-1' }),
      expect.anything(),
    )
    const body = (await res.json()) as Record<string, unknown>
    expect(body['activeOrganizationId']).toBe('org-1')
  })

  it('clears active organization without membership lookup', async () => {
    const update = vi.fn().mockResolvedValue([])
    const db = makeDb({ update })

    const res = await post({ organizationId: null }, db)

    expect(res.status).toBe(200)
    expect(db.memberships.findOne).not.toHaveBeenCalled()
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ activeOrgId: null }),
      expect.anything(),
    )
  })

  it('rejects organization without active membership', async () => {
    const db = makeDb({ membership: null, organization: { id: 'org-1' } })

    const res = await post({ organizationId: 'org-1' }, db)

    expect(res.status).toBe(404)
    expect(((await res.json()) as Record<string, unknown>)['code']).toBe('not_found')
    expect(db.sessions.update).not.toHaveBeenCalled()
  })

  it('rejects deleted organization even with active membership', async () => {
    const db = makeDb({ membership: { id: 'mem-1' }, organization: null })

    const res = await post({ organizationId: 'org-deleted' }, db)

    expect(res.status).toBe(404)
    expect(db.sessions.update).not.toHaveBeenCalled()
  })

  it('validates organizationId type', async () => {
    const db = makeDb({})

    const res = await post({ organizationId: 123 }, db)

    expect(res.status).toBe(422)
    expect(((await res.json()) as { meta?: { paramName?: string } }).meta?.paramName).toBe(
      'organizationId',
    )
  })

  it('requires organizationId to be present', async () => {
    const db = makeDb({})

    const res = await post({}, db)

    expect(res.status).toBe(422)
    expect(((await res.json()) as { meta?: { paramName?: string } }).meta?.paramName).toBe(
      'organizationId',
    )
    expect(db.sessions.update).not.toHaveBeenCalled()
  })

  it('rejects empty organizationId', async () => {
    const db = makeDb({})

    const res = await post({ organizationId: '' }, db)

    expect(res.status).toBe(422)
    expect(((await res.json()) as { meta?: { paramName?: string } }).meta?.paramName).toBe(
      'organizationId',
    )
    expect(db.sessions.update).not.toHaveBeenCalled()
  })

  it('rejects pending_mfa session with 401', async () => {
    const db = makeDb({})

    const res = await post({ organizationId: 'org-1' }, db, {
      ...makeSession(),
      status: 'pending_mfa',
    })

    expect(res.status).toBe(401)
    expect(db.sessions.update).not.toHaveBeenCalled()
  })

  it.each([{ organizationId: 'org-2' }, { organizationId: null }])(
    'pins an impersonation session to its active organization',
    async (body) => {
      const db = makeDb({})
      const res = await post(body, db, {
        ...makeSession(),
        activeOrgId: 'org-1',
        isImpersonation: true,
        impersonatorUserId: 'user-manager',
      })

      expect(res.status).toBe(403)
      expect(((await res.json()) as Record<string, unknown>)['code']).toBe('forbidden')
      expect(db.memberships.findOne).not.toHaveBeenCalled()
      expect(db.sessions.update).not.toHaveBeenCalled()
    },
  )
})
