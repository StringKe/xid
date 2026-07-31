import type { TenantContext } from '@xid-kit/types'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MockDurableObjectState } from '../../durable-objects/__tests__/mock-do-state'
import { ImpersonationGrantDO } from '../../durable-objects/impersonation-grant-do'
import { isAppError } from '../../lib/errors'
import type { SessionData, XidHonoEnv } from '../../lib/types'
import { registerImpersonationRoutes } from '../index'

const TARGET_USER_ID = '00000000-0000-4000-8000-000000000001'
const TARGET_ORGANIZATION_ID = '00000000-0000-4000-8000-000000000002'

const mocks = vi.hoisted(() => ({
  requireInstanceManager: vi.fn(),
  issueSession: vi.fn(),
  revokeSession: vi.fn(),
  readSession: vi.fn(),
  auditSend: vi.fn(),
  targetRow: null as Record<string, unknown> | null,
  currentSession: null as SessionData | null,
  tenantDb: {
    users: { findOne: vi.fn() },
    organizations: { findOne: vi.fn() },
    memberships: { findOne: vi.fn() },
  },
}))

vi.mock('@xid-kit/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xid-kit/db')>()
  return {
    ...actual,
    createTenantDb: vi.fn(() => mocks.tenantDb),
  }
})

vi.mock('../../platform/shared', () => ({
  requireInstanceManager: mocks.requireInstanceManager,
}))

vi.mock('../../lib/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/session')>()
  return {
    ...actual,
    issueSession: mocks.issueSession,
    revokeSession: mocks.revokeSession,
    readSession: mocks.readSession,
  }
})

const MANAGER_TENANT = {
  tenantId: 'org_manager',
  instanceId: 'inst_1',
  issuer: 'https://xid.dev',
  rpId: 'xid.dev',
  signingKeys: { activeKid: 'kid_1', defaultAlg: 'ES256', keys: [] },
  policy: {},
} as TenantContext

const TARGET_TENANT = {
  tenantId: 'org_target',
  instanceId: 'inst_1',
  issuer: 'https://xid.dev',
  rpId: 'target.xid.dev',
  signingKeys: { activeKid: 'kid_1', defaultAlg: 'ES256', keys: [] },
  policy: {},
} as TenantContext

const MANAGER_SESSION: SessionData = {
  sessionId: 'sess_manager',
  userId: 'user_manager',
  status: 'active',
  activeOrgId: 'org_manager',
  authenticatedAt: new Date('2026-07-28T00:00:00Z'),
  lastActiveAt: new Date('2026-07-28T00:00:00Z'),
  expiresAt: new Date('2026-07-29T00:00:00Z'),
  rememberMe: false,
  isImpersonation: false,
  impersonatorUserId: null,
  acr: null,
  amr: null,
  aal: null,
}

function makeImpersonationSession(): SessionData {
  return {
    ...MANAGER_SESSION,
    sessionId: 'sess_impersonation',
    userId: TARGET_USER_ID,
    activeOrgId: TARGET_ORGANIZATION_ID,
    expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    isImpersonation: true,
    impersonatorUserId: MANAGER_SESSION.userId,
  }
}

function makeDurableNamespace(): DurableObjectNamespace {
  const instances = new Map<string, ImpersonationGrantDO>()
  return {
    idFromName: (name: string) => name as unknown as DurableObjectId,
    get: (id: DurableObjectId) => {
      const key = String(id)
      let grant = instances.get(key)
      if (!grant) {
        grant = new ImpersonationGrantDO(
          new MockDurableObjectState() as unknown as DurableObjectState,
        )
        instances.set(key, grant)
      }
      return {
        fetch: (input: RequestInfo | URL, init?: RequestInit) =>
          grant.fetch(input instanceof Request ? input : new Request(input, init)),
      } as unknown as DurableObjectStub
    },
  } as unknown as DurableObjectNamespace
}

function makeEnv(options: { activeImpersonationSession?: boolean } = {}): Env {
  const activeImpersonationSession = options.activeImpersonationSession ?? true
  const prepare = vi.fn((query: string) => {
    let args: unknown[] = []
    const statement = {
      bind: (...values: unknown[]) => {
        args = values
        return statement
      },
      first: vi.fn(async () => (query.includes('FROM users u') ? mocks.targetRow : null)),
      run: vi.fn(async () => {
        const conditionalEndStatement =
          (query.includes('INSERT INTO platform_audit_outbox') &&
            query.includes('FROM sessions')) ||
          (query.includes('UPDATE sessions') && query.includes('mutation_audit_gate'))
        return {
          meta: {
            changes: conditionalEndStatement && !activeImpersonationSession ? 0 : 1,
          },
          args,
        }
      }),
    }
    return statement
  })
  return {
    DB: {
      prepare,
      batch: vi.fn(async (statements: { run: () => Promise<unknown> }[]) =>
        Promise.all(statements.map((statement) => statement.run())),
      ),
    } as unknown as D1Database,
    IMPERSONATION_GRANTS: makeDurableNamespace(),
    AUDIT_QUEUE: { send: mocks.auditSend } as unknown as Queue,
  } as unknown as Env
}

function makeApp(): Hono<XidHonoEnv> {
  const app = new Hono<XidHonoEnv>()
  app.onError((error, c) => {
    if (isAppError(error)) {
      return c.json({ code: error.code }, error.httpStatus as 400)
    }
    throw error
  })
  app.use('*', async (c: Context<XidHonoEnv>, next) => {
    const targetHost = new URL(c.req.url).hostname === 'target.xid.dev'
    c.set('tenant', targetHost ? TARGET_TENANT : MANAGER_TENANT)
    c.set('session', mocks.currentSession)
    await next()
  })
  registerImpersonationRoutes(app)
  app.get('/v1/read-only-probe', (c) => c.json({ ok: true }))
  app.options('/v1/read-only-probe', (c) => c.body(null, 204))
  app.patch('/v1/read-only-probe', (c) => c.json({ ok: true }))
  app.post('/v1/sessions/token', (c) => c.json({ token: 'session-token' }))
  app.get('/authorize', (c) => c.json({ code: 'authorization-code' }))
  app.get('/end_session', (c) => c.json({ ok: true }))
  app.post('/end_session', (c) => c.json({ ok: true }))
  app.get('/auth/config', (c) => c.json({ ok: true }))
  app.post('/auth/password/sign-in', (c) => c.json({ ok: true }))
  app.post('/auth/sign-out', (c) => c.json({ ok: true }))
  app.post('/sso/hrd', (c) => c.json({ ok: true }))
  app.get('/v1ish/not-management', (c) => c.json({ ok: true }))
  return app
}

const execCtx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext

async function start(
  app: Hono<XidHonoEnv>,
  env: Env,
): Promise<{
  response: Response
  handoff: { action: string; method: string; fields: { grantId: string; secret: string } }
}> {
  const response = await app.request(
    'https://xid.dev/v1/platform/impersonation/start',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'cf-connecting-ip': '203.0.113.10',
      },
      body: JSON.stringify({
        userId: TARGET_USER_ID,
        organizationId: TARGET_ORGANIZATION_ID,
      }),
    },
    env,
    execCtx,
  )
  const body = (await response.clone().json()) as {
    handoff: { action: string; method: string; fields: { grantId: string; secret: string } }
  }
  return { response, handoff: body.handoff }
}

describe('platform impersonation routes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.currentSession = null
    mocks.targetRow = {
      targetUserId: TARGET_USER_ID,
      targetTenantId: TARGET_TENANT.tenantId,
      targetOrganizationId: TARGET_ORGANIZATION_ID,
      targetInstanceId: TARGET_TENANT.instanceId,
      organizationSlug: 'target',
      primaryDomain: 'xid.dev',
      instanceMode: 'multi_tenant',
    }
    mocks.requireInstanceManager.mockResolvedValue(MANAGER_SESSION)
    mocks.tenantDb.users.findOne.mockResolvedValue({ id: TARGET_USER_ID, status: 'active' })
    mocks.tenantDb.organizations.findOne.mockResolvedValue({
      id: TARGET_ORGANIZATION_ID,
      slug: 'target',
      instanceId: TARGET_TENANT.instanceId,
      status: 'active',
    })
    mocks.tenantDb.memberships.findOne.mockResolvedValue({
      userId: TARGET_USER_ID,
      orgId: TARGET_ORGANIZATION_ID,
      status: 'active',
    })
    mocks.auditSend.mockResolvedValue(undefined)
    mocks.revokeSession.mockResolvedValue(undefined)
    mocks.readSession.mockImplementation(async () => mocks.currentSession)
    mocks.issueSession.mockImplementation(async (_c, input) => ({
      session: {
        ...makeImpersonationSession(),
        sessionId: input.sessionId,
        userId: input.userId,
        activeOrgId: input.activeOrgId,
        authenticatedAt: input.authenticatedAt,
        lastActiveAt: input.authenticatedAt,
        expiresAt: input.expiresAt,
        rememberMe: input.rememberMe,
        isImpersonation: input.isImpersonation,
        impersonatorUserId: input.impersonatorUserId,
      },
      refreshToken: 'not-returned-to-client',
    }))
  })

  it('starts an opaque POST handoff without target identity in URL or response', async () => {
    const app = makeApp()
    const env = makeEnv()
    const { response, handoff } = await start(app, env)

    expect(response.status).toBe(201)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    expect(handoff).toMatchObject({
      action: 'https://target.xid.dev/auth/impersonation/handoff',
      method: 'POST',
    })
    expect(new URL(handoff.action).search).toBe('')
    expect(handoff.fields.grantId).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(handoff.fields.secret).toMatch(/^[A-Za-z0-9_-]+$/)
    const wire = await response.text()
    expect(wire).not.toContain(TARGET_USER_ID)
    expect(wire).not.toContain(TARGET_ORGANIZATION_ID)
    expect(wire).not.toContain('target@example.com')
    expect(mocks.auditSend).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'platform.impersonation.grant_created' }),
    )
  })

  it('preserves the local development port for a loopback target handoff', async () => {
    mocks.targetRow = {
      ...mocks.targetRow,
      primaryDomain: 'localhost',
    }
    const app = makeApp()
    const env = makeEnv()
    const response = await app.request(
      'http://localhost:8787/v1/platform/impersonation/start',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          userId: TARGET_USER_ID,
          organizationId: TARGET_ORGANIZATION_ID,
        }),
      },
      env,
      execCtx,
    )

    expect(response.status).toBe(201)
    await expect(response.json()).resolves.toMatchObject({
      handoff: { action: 'http://target.localhost:8787/auth/impersonation/handoff' },
    })
  })

  it('returns a usable grant when Queue handoff fails after durable outbox persistence', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.auditSend.mockRejectedValue(new Error('queue unavailable'))
    const app = makeApp()
    const env = makeEnv()

    const { response } = await start(app, env)

    expect(response.status).toBe(201)
    expect(mocks.auditSend).toHaveBeenCalledOnce()
    expect(env.DB.prepare).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO platform_audit_outbox'),
    )
    expect(env.DB.prepare).toHaveBeenCalledWith(expect.stringContaining("SET status = 'pending'"))
    log.mockRestore()
  })

  it('binds consume to the exact target host, then consumes the grant only once', async () => {
    const app = makeApp()
    const env = makeEnv()
    const { handoff } = await start(app, env)

    const wrongHost = await app.request(
      'https://other.xid.dev/auth/impersonation/consume',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(handoff.fields),
      },
      env,
      execCtx,
    )
    expect(wrongHost.status).toBe(401)
    expect(mocks.issueSession).not.toHaveBeenCalled()

    const before = Date.now()
    const consumed = await app.request(
      'https://target.xid.dev/auth/impersonation/consume',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(handoff.fields),
      },
      env,
      execCtx,
    )
    expect(consumed.status).toBe(201)
    expect(mocks.issueSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: TARGET_USER_ID,
        activeOrgId: TARGET_ORGANIZATION_ID,
        rememberMe: false,
        isImpersonation: true,
        impersonatorUserId: MANAGER_SESSION.userId,
      }),
    )
    const issued = mocks.issueSession.mock.calls[0]?.[1] as { expiresAt: Date }
    expect(issued.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 15 * 60 * 1000)
    expect(issued.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 15 * 60 * 1000)
    expect(TARGET_TENANT.issuer).toBe('https://xid.dev')
    expect(TARGET_TENANT.rpId).toBe('target.xid.dev')

    const replay = await app.request(
      'https://target.xid.dev/auth/impersonation/consume',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(handoff.fields),
      },
      env,
      execCtx,
    )
    expect(replay.status).toBe(401)
    expect(mocks.issueSession).toHaveBeenCalledOnce()
    expect(mocks.auditSend).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'platform.impersonation.started',
        actorId: MANAGER_SESSION.userId,
        orgId: TARGET_ORGANIZATION_ID,
      }),
    )
  })

  it('accepts a form POST handoff and redirects without adding a query string', async () => {
    const app = makeApp()
    const env = makeEnv()
    const { handoff } = await start(app, env)

    const response = await app.request(
      handoff.action,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(handoff.fields),
      },
      env,
      execCtx,
    )

    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/console')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
  })

  it('fails closed when target state becomes inactive after grant creation', async () => {
    const app = makeApp()
    const env = makeEnv()
    const { handoff } = await start(app, env)
    mocks.tenantDb.users.findOne.mockResolvedValue(null)

    const response = await app.request(
      'https://target.xid.dev/auth/impersonation/consume',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(handoff.fields),
      },
      env,
      execCtx,
    )

    expect(response.status).toBe(401)
    expect(mocks.issueSession).not.toHaveBeenCalled()
    expect(mocks.auditSend).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'platform.impersonation.grant_consumed' }),
    )
  })

  it('fails closed when the target host slug no longer belongs to the granted organization', async () => {
    const app = makeApp()
    const env = makeEnv()
    const { handoff } = await start(app, env)
    mocks.tenantDb.organizations.findOne.mockResolvedValue({
      id: TARGET_ORGANIZATION_ID,
      slug: 'renamed',
      instanceId: TARGET_TENANT.instanceId,
      status: 'active',
    })

    const response = await app.request(
      'https://target.xid.dev/auth/impersonation/consume',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(handoff.fields),
      },
      env,
      execCtx,
    )

    expect(response.status).toBe(401)
    expect(mocks.issueSession).not.toHaveBeenCalled()
  })

  it('ends only an impersonation session and records the end audit', async () => {
    const app = makeApp()
    const env = makeEnv()
    mocks.currentSession = makeImpersonationSession()

    const ended = await app.request(
      'https://target.xid.dev/auth/impersonation/end',
      { method: 'POST', headers: { 'cf-connecting-ip': '198.51.100.20' } },
      env,
      execCtx,
    )

    expect(ended.status).toBe(200)
    await expect(ended.clone().json()).resolves.toMatchObject({
      ok: true,
      redirectUrl: 'https://xid.dev/console/platform/users',
    })
    expect(mocks.revokeSession).toHaveBeenCalledWith(expect.anything(), mocks.currentSession)
    expect(mocks.auditSend).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'platform.impersonation.ended',
        actorId: MANAGER_SESSION.userId,
        orgId: TARGET_ORGANIZATION_ID,
      }),
    )

    mocks.currentSession = MANAGER_SESSION
    const ordinary = await app.request(
      'https://xid.dev/auth/impersonation/end',
      { method: 'POST' },
      env,
      execCtx,
    )
    expect(ordinary.status).toBe(403)
    expect(mocks.revokeSession).toHaveBeenCalledOnce()
  })

  it('does not record an end audit when the D1 session was already inactive', async () => {
    const app = makeApp()
    const env = makeEnv({ activeImpersonationSession: false })
    mocks.currentSession = makeImpersonationSession()

    const ended = await app.request(
      'https://target.xid.dev/auth/impersonation/end',
      { method: 'POST' },
      env,
      execCtx,
    )

    expect(ended.status).toBe(200)
    expect(mocks.revokeSession).toHaveBeenCalledWith(expect.anything(), mocks.currentSession)
    expect(mocks.auditSend).not.toHaveBeenCalled()
  })

  it('allows only GET, HEAD, and OPTIONS under /v1 for an impersonation session', async () => {
    const app = makeApp()
    const env = makeEnv()
    mocks.currentSession = makeImpersonationSession()

    const responses = await Promise.all(
      ['GET', 'HEAD', 'OPTIONS'].map((method) =>
        app.request('https://target.xid.dev/v1/read-only-probe', { method }, env, execCtx),
      ),
    )

    expect(responses.map((response) => response.status)).toEqual([200, 200, 204])
  })

  it.each([
    ['GET /authorize', 'GET', '/authorize'],
    ['GET /end_session', 'GET', '/end_session'],
    ['POST /end_session', 'POST', '/end_session'],
    ['GET /auth/config', 'GET', '/auth/config'],
    ['POST /auth/password/sign-in', 'POST', '/auth/password/sign-in'],
    ['POST /auth/sign-out', 'POST', '/auth/sign-out'],
    ['POST /sso/hrd', 'POST', '/sso/hrd'],
    ['POST /v1/sessions/token', 'POST', '/v1/sessions/token'],
    ['PATCH /v1/read-only-probe', 'PATCH', '/v1/read-only-probe'],
    ['GET /v1ish/not-management', 'GET', '/v1ish/not-management'],
  ])('blocks impersonation escape through %s', async (_label, method, path) => {
    const app = makeApp()
    const env = makeEnv()
    mocks.currentSession = makeImpersonationSession()

    const response = await app.request(`https://target.xid.dev${path}`, { method }, env, execCtx)

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({ code: 'forbidden' })
  })

  it('does not restrict ordinary or anonymous sessions', async () => {
    const app = makeApp()
    const env = makeEnv()

    mocks.currentSession = MANAGER_SESSION
    const ordinary = await app.request('https://xid.dev/authorize', { method: 'GET' }, env, execCtx)
    mocks.currentSession = null
    const anonymous = await app.request(
      'https://xid.dev/auth/password/sign-in',
      { method: 'POST' },
      env,
      execCtx,
    )

    expect(ordinary.status).toBe(200)
    expect(anonymous.status).toBe(200)
  })
})
