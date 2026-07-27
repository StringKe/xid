import type { TenantContext } from '@xid-kit/types'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionData, XidHonoEnv } from '../types'
import { isAppError } from '../errors'
import { requireApiKeyOrTopLevelOrgManager, requireOrgManager } from '../../v1/shared'
import { requireInstanceManager } from '../../platform/shared'

const mocks = vi.hoisted(() => {
  const tenantDb = {
    apiKeys: { findOne: vi.fn() },
    organizations: { findOne: vi.fn() },
    memberships: { findOne: vi.fn() },
    managerAssignments: { findOne: vi.fn() },
    users: { findOne: vi.fn() },
    userEmails: { findOne: vi.fn() },
  }
  return {
    tenantDb,
    instanceManagerRows: [] as { id: string }[],
  }
})

vi.mock('@xid-kit/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xid-kit/db')>()
  return {
    ...actual,
    createTenantDb: vi.fn(() => mocks.tenantDb),
  }
})

vi.mock('drizzle-orm/d1', () => ({
  drizzle: vi.fn(() => ({
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => mocks.instanceManagerRows),
        })),
      })),
    })),
  })),
}))

const TENANT: TenantContext = {
  tenantId: 'tenant_1',
  issuer: 'https://tenant.example.test',
  rpId: 'tenant.example.test',
  signingKeys: { activeKid: 'kid_1', defaultAlg: 'ES256', keys: [] },
  policy: {},
}

function session(status: SessionData['status'] = 'active'): SessionData {
  const now = new Date()
  return {
    sessionId: 'session_1',
    userId: 'user_1',
    status,
    activeOrgId: 'org_1',
    authenticatedAt: now,
    lastActiveAt: now,
    expiresAt: new Date(now.getTime() + 60_000),
    rememberMe: false,
    isImpersonation: false,
    impersonatorUserId: null,
    acr: null,
    amr: null,
    aal: null,
  }
}

function buildApp(currentSession: SessionData): Hono<XidHonoEnv> {
  const app = new Hono<XidHonoEnv>()
  app.onError((error, c) => {
    if (isAppError(error)) return c.json({ code: error.code }, error.httpStatus as 400)
    throw error
  })
  app.use('*', async (c: Context<XidHonoEnv>, next) => {
    c.set('tenant', TENANT)
    c.set('session', currentSession)
    await next()
  })
  const readOrganization = async (c: Context<XidHonoEnv>): Promise<Response> => {
    await requireOrgManager(c, 'org_1')
    return c.json({ ok: true })
  }
  app.on('GET', '/org', readOrganization)
  app.on('HEAD', '/org', readOrganization)
  app.on('OPTIONS', '/org', readOrganization)
  app.post('/org', async (c) => {
    await requireOrgManager(c, 'org_1')
    return c.json({ ok: true })
  })
  app.post('/top-level', async (c) => {
    await requireApiKeyOrTopLevelOrgManager(c, 'applications:write')
    return c.json({ ok: true })
  })
  app.get('/platform', async (c) => {
    await requireInstanceManager(c)
    return c.json({ ok: true })
  })
  app.patch('/platform', async (c) => {
    await requireInstanceManager(c)
    return c.json({ ok: true })
  })
  return app
}

function request(app: Hono<XidHonoEnv>, path: string, init?: RequestInit): Promise<Response> {
  return Promise.resolve(app.request(`https://tenant.example.test${path}`, init, { DB: {} } as Env))
}

describe('management cookie mutation verification gate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.instanceManagerRows = [{ id: 'manager_1' }]
    mocks.tenantDb.organizations.findOne.mockResolvedValue({ id: 'org_1', status: 'active' })
    mocks.tenantDb.memberships.findOne.mockResolvedValue({
      userId: 'user_1',
      orgId: 'org_1',
      role: 'owner',
      status: 'active',
    })
    mocks.tenantDb.managerAssignments.findOne.mockResolvedValue(undefined)
    mocks.tenantDb.users.findOne.mockResolvedValue({
      id: 'user_1',
      primaryEmailId: 'email_1',
    })
    mocks.tenantDb.userEmails.findOne.mockResolvedValue({
      id: 'email_1',
      userId: 'user_1',
      isPrimary: true,
      verified: true,
    })
  })

  it('allows an active verified owner to mutate an organization', async () => {
    const response = await request(buildApp(session()), '/org', {
      method: 'POST',
    })

    expect(response.status).toBe(200)
  })

  it.each(['GET', 'HEAD', 'OPTIONS'] as const)(
    'allows an active unverified owner to use safe %s management methods',
    async (method) => {
      mocks.tenantDb.userEmails.findOne.mockResolvedValue(undefined)

      const response = await request(buildApp(session()), '/org', { method })

      expect(response.status).toBe(200)
      expect(mocks.tenantDb.users.findOne).not.toHaveBeenCalled()
      expect(mocks.tenantDb.userEmails.findOne).not.toHaveBeenCalled()
    },
  )

  it('rejects an active unverified owner organization mutation with a stable error', async () => {
    mocks.tenantDb.userEmails.findOne.mockResolvedValue(undefined)

    const response = await request(buildApp(session()), '/org', {
      method: 'POST',
    })

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({
      code: 'email_verification_required',
    })
  })

  it('rejects pending MFA before an organization mutation', async () => {
    const response = await request(buildApp(session('pending_mfa')), '/org', { method: 'POST' })

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ code: 'unauthorized' })
    expect(mocks.tenantDb.userEmails.findOne).not.toHaveBeenCalled()
  })

  it('rejects an unverified top-level organization manager cookie mutation', async () => {
    mocks.tenantDb.userEmails.findOne.mockResolvedValue(undefined)

    const response = await request(buildApp(session()), '/top-level', { method: 'POST' })

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({
      code: 'email_verification_required',
    })
  })

  it('allows API key mutations without consulting a user email', async () => {
    const token = 'sk_live_management_gate'
    mocks.tenantDb.apiKeys.findOne.mockResolvedValue({
      id: 'api_key_1',
      scopes: ['applications:write'],
      revokedAt: null,
      expiresAt: null,
    })
    mocks.tenantDb.userEmails.findOne.mockResolvedValue(undefined)

    const response = await request(buildApp(session('pending_mfa')), '/top-level', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    })

    expect(response.status).toBe(200)
    expect(mocks.tenantDb.apiKeys.findOne).toHaveBeenCalled()
    expect(mocks.tenantDb.userEmails.findOne).not.toHaveBeenCalled()
  })

  it('allows an active unverified instance manager to use safe platform methods', async () => {
    mocks.tenantDb.userEmails.findOne.mockResolvedValue(undefined)

    const response = await request(buildApp(session()), '/platform')

    expect(response.status).toBe(200)
    expect(mocks.tenantDb.userEmails.findOne).not.toHaveBeenCalled()
  })

  it('rejects an active unverified instance manager platform mutation', async () => {
    mocks.tenantDb.userEmails.findOne.mockResolvedValue(undefined)

    const response = await request(buildApp(session()), '/platform', {
      method: 'PATCH',
    })

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({
      code: 'email_verification_required',
    })
  })
})
