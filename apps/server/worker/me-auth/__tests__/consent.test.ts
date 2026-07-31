// GET /auth/consent-params + POST /auth/consent 单测:
// 无 session -> 401;consent-params happy -> client 展示数据 + 本地化 scope;
// consent approved -> 持久化 + 续签 code redirectUrl;denied -> access_denied redirectUrl;
// prompt_id 失效(DO 无记录)-> invalid_request。

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@xid-kit/protocol', () => ({
  generateAuthorizationCode: (now: number) => ({ code: 'ac_test', expiresAt: now + 60 }),
}))

vi.mock('@xid-kit/db', () => ({
  createTenantDb: vi.fn(),
  schema: {
    projects: { id: 'id' },
    organizations: { id: 'id' },
    oauthConsents: { userId: 'userId', clientId: 'clientId' },
    authorizationCodes: {},
    resourceServers: { audience: 'audience' },
  },
}))

vi.mock('../../oidc/shared', () => ({
  findClient: vi.fn(),
  loadActiveSigner: vi.fn().mockResolvedValue({
    kid: 'k1',
    alg: 'ES256',
    privateKey: {} as CryptoKey,
  }),
}))

vi.mock('../../oidc/authorize-respond', async () => {
  const actual = await vi.importActual<typeof import('../../oidc/authorize-respond')>(
    '../../oidc/authorize-respond',
  )
  return {
    ...actual,
    signAuthorizationResponseJwt: vi.fn(async (input) => {
      const params = input.params as Record<string, string>
      return `signed:${params['code'] ?? params['error']}:${params['state'] ?? ''}`
    }),
  }
})

vi.mock('../../lib/session', () => ({
  readSession: vi.fn(),
  ACTIVE_SESSION_STATUS: 'active',
  PENDING_MFA_SESSION_STATUS: 'pending_mfa',
  PENDING_MFA_SETUP_SESSION_STATUS: 'pending_mfa_setup',
}))

import { createTenantDb } from '@xid-kit/db'
import { findClient } from '../../oidc/shared'
import { readSession } from '../../lib/session'
import { registerSessionAuthRoutes } from '../index'
import { execCtx, makeApp, makeEnv, makeSession } from './helpers'

// OAUTH_STATE DO:consume 返回 pendingParams,store 默认返回 201。pending=null 模拟失效。
// consumeBody 传原始串,用于构造 DO 返回坏 body 的场景。
function oauthStateNs(
  pending: Record<string, string> | null,
  storeStatus = 201,
  consumeStatus = 200,
  consumeBody?: string,
): DurableObjectNamespace {
  return {
    idFromName: () => ({ toString: () => 'authz-id' }) as DurableObjectId,
    get: () =>
      ({
        fetch: async (input: string | Request) => {
          const rawUrl = typeof input === 'string' ? input : input.url
          const url = new URL(rawUrl)
          if (url.pathname === '/store') return new Response(null, { status: storeStatus })
          if (!pending) return new Response('not found', { status: 404 })
          return new Response(
            consumeBody ?? JSON.stringify({ record: { pendingParams: pending } }),
            { status: consumeStatus },
          )
        },
      }) as unknown as DurableObjectStub,
  } as unknown as DurableObjectNamespace
}

const PENDING = {
  client_id: 'client-1',
  redirect_uri: 'https://rp.example.com/callback',
  scope: 'openid email',
  response_type: 'code',
  state: 'rp-state',
  dpop_jkt: 'jkt_consent',
}

const JARM_PENDING = { ...PENDING, response_mode: 'query.jwt' }
const UNSUPPORTED_AAL3_PENDING = { ...PENDING, acr_values: 'urn:xid:aal3' }
const RAR_DETAILS = [
  {
    type: 'resource_access',
    locations: ['https://api.example/v1'],
    actions: ['read'],
  },
]
const RAR_PENDING = {
  ...PENDING,
  scope: 'openid email',
  authorization_details: JSON.stringify(RAR_DETAILS),
}

function clientDb() {
  return {
    projects: { findOne: vi.fn().mockResolvedValue({ name: 'Acme App', orgId: 'org-1' }) },
    organizations: { findOne: vi.fn().mockResolvedValue({ logoUrl: 'https://logo' }) },
    oauthConsents: {
      findOne: vi.fn().mockResolvedValue(undefined),
      insert: vi.fn().mockResolvedValue({ id: 'consent-1' }),
      update: vi.fn().mockResolvedValue([]),
    },
    authorizationCodes: { insert: vi.fn().mockResolvedValue({ code: 'ac_test' }) },
    resourceServers: {
      findOne: vi.fn().mockResolvedValue({
        audience: 'https://api.example/v1',
        scopes: ['read'],
      }),
      findMany: vi.fn().mockResolvedValue([
        {
          audience: 'https://api.example/v1',
          scopes: ['read'],
        },
      ]),
    },
  } as unknown as ReturnType<typeof createTenantDb>
}

describe('GET /auth/consent-params', () => {
  beforeEach(() => vi.clearAllMocks())

  it('无 session -> 401', async () => {
    vi.mocked(readSession).mockResolvedValue(null)
    const app = makeApp(registerSessionAuthRoutes, { session: null })
    const res = await app.request(
      '/auth/consent-params?prompt_id=p1',
      { method: 'GET' },
      makeEnv(),
      execCtx,
    )
    expect(res.status).toBe(401)
  })

  it('happy -> client 展示数据 + 本地化 scope description', async () => {
    vi.mocked(findClient).mockResolvedValue({
      clientId: 'client-1',
      projectId: 'project-1',
      firstParty: false,
    } as never)
    vi.mocked(createTenantDb).mockReturnValue(clientDb())
    const app = makeApp(registerSessionAuthRoutes, { session: makeSession() })
    const env = makeEnv({ oauthStateNs: oauthStateNs(PENDING) })
    const res = await app.request(
      '/auth/consent-params?prompt_id=p1',
      { method: 'GET' },
      env,
      execCtx,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      clientId: string
      clientName: string
      scopes: { name: string; description: string }[]
      authorizationDetails: typeof RAR_DETAILS
      firstParty: boolean
    }
    expect(body.clientId).toBe('client-1')
    expect(body.clientName).toBe('Acme App')
    expect(body.scopes.find((s) => s.name === 'openid')?.description).toBe('Verify your identity')
    expect(body.authorizationDetails).toEqual([])
  })

  it('happy + RAR -> 返回 authorizationDetails 供 consent 展示', async () => {
    vi.mocked(findClient).mockResolvedValue({
      clientId: 'client-1',
      projectId: 'project-1',
      firstParty: false,
    } as never)
    vi.mocked(createTenantDb).mockReturnValue(clientDb())
    const app = makeApp(registerSessionAuthRoutes, { session: makeSession() })
    const env = makeEnv({ oauthStateNs: oauthStateNs(RAR_PENDING) })
    const res = await app.request(
      '/auth/consent-params?prompt_id=p1',
      { method: 'GET' },
      env,
      execCtx,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { authorizationDetails: typeof RAR_DETAILS }
    expect(body.authorizationDetails).toEqual(RAR_DETAILS)
  })

  it('pending 参数 re-store 失败 -> server_error(不返回可用的 consent 页)', async () => {
    vi.mocked(findClient).mockResolvedValue({
      clientId: 'client-1',
      projectId: 'project-1',
      firstParty: false,
    } as never)
    vi.mocked(createTenantDb).mockReturnValue(clientDb())
    const app = makeApp(registerSessionAuthRoutes, { session: makeSession() })
    const env = makeEnv({ oauthStateNs: oauthStateNs(PENDING, 500) })

    const res = await app.request(
      '/auth/consent-params?prompt_id=p1',
      { method: 'GET' },
      env,
      execCtx,
    )

    expect(res.status).toBe(500)
    expect((await res.json()) as { code: string }).toMatchObject({ code: 'server_error' })
  })

  it('pending 参数 consume 返回 malformed body -> server_error(不当作失效放行)', async () => {
    const app = makeApp(registerSessionAuthRoutes, { session: makeSession() })
    const env = makeEnv({
      oauthStateNs: oauthStateNs(PENDING, 201, 200, JSON.stringify({ record: null })),
    })

    const res = await app.request(
      '/auth/consent-params?prompt_id=p1',
      { method: 'GET' },
      env,
      execCtx,
    )

    expect(res.status).toBe(500)
    expect((await res.json()) as { code: string }).toMatchObject({ code: 'server_error' })
  })

  it('pending 参数 consume 返回非预期状态 -> server_error(区别于 404 失效)', async () => {
    const app = makeApp(registerSessionAuthRoutes, { session: makeSession() })
    const env = makeEnv({ oauthStateNs: oauthStateNs(PENDING, 201, 500) })

    const res = await app.request(
      '/auth/consent-params?prompt_id=p1',
      { method: 'GET' },
      env,
      execCtx,
    )

    expect(res.status).toBe(500)
    expect((await res.json()) as { code: string }).toMatchObject({ code: 'server_error' })
  })

  it('prompt_id 失效(DO 无记录)-> invalid_request', async () => {
    const app = makeApp(registerSessionAuthRoutes, { session: makeSession() })
    const env = makeEnv({ oauthStateNs: oauthStateNs(null) })
    const res = await app.request(
      '/auth/consent-params?prompt_id=gone',
      { method: 'GET' },
      env,
      execCtx,
    )
    expect(((await res.json()) as { code: string }).code).toBe('invalid_request')
  })
})

function post(app: ReturnType<typeof makeApp>, env: Env, body: unknown) {
  return app.request(
    '/auth/consent',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    env,
    execCtx,
  )
}

// handleConsent 批准路径复核 client 现状(TOCTOU):mock 一个 active client。
function mockActiveClient(allowedScopes: string[] = ['openid', 'email', 'read']) {
  vi.mocked(findClient).mockResolvedValue({ clientId: 'client-1', allowedScopes } as never)
}

describe('POST /auth/consent', () => {
  beforeEach(() => vi.clearAllMocks())

  it('approved=true -> 持久化 consent + code redirectUrl', async () => {
    const db = clientDb()
    vi.mocked(createTenantDb).mockReturnValue(db)
    mockActiveClient()
    const app = makeApp(registerSessionAuthRoutes, { session: makeSession() })
    const env = makeEnv({ oauthStateNs: oauthStateNs(PENDING) })
    const res = await post(app, env, { promptId: 'p1', approved: true })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { redirectUrl: string }
    expect(body.redirectUrl).toContain('code=ac_test')
    expect(body.redirectUrl).toContain('state=rp-state')
    expect(db.oauthConsents.insert).toHaveBeenCalledOnce()
    expect(db.authorizationCodes.insert).toHaveBeenCalledWith(
      expect.objectContaining({ dpopJkt: 'jkt_consent', sessionId: 'sess-1' }),
    )
  })

  it('approved=true + RAR -> 持久化 action scope、resource 和 authorizationDetails', async () => {
    const db = clientDb()
    vi.mocked(createTenantDb).mockReturnValue(db)
    mockActiveClient()
    const app = makeApp(registerSessionAuthRoutes, { session: makeSession() })
    const env = makeEnv({ oauthStateNs: oauthStateNs(RAR_PENDING) })
    const res = await post(app, env, { promptId: 'p1', approved: true })
    expect(res.status).toBe(200)
    expect(db.oauthConsents.insert).toHaveBeenCalledWith(
      expect.objectContaining({ grantedScopes: ['openid', 'email', 'read'] }),
    )
    expect(db.authorizationCodes.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'openid email read',
        resource: ['https://api.example/v1'],
        authorizationDetails: RAR_DETAILS,
      }),
    )
  })

  it('approved=true + legacy pending AAL3 request -> 明确拒绝且不签发 code', async () => {
    const db = clientDb()
    vi.mocked(createTenantDb).mockReturnValue(db)
    mockActiveClient()
    const app = makeApp(registerSessionAuthRoutes, { session: makeSession() })
    const env = makeEnv({ oauthStateNs: oauthStateNs(UNSUPPORTED_AAL3_PENDING) })
    const res = await post(app, env, { promptId: 'p1', approved: true })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { redirectUrl: string }
    const redirect = new URL(body.redirectUrl)
    expect(redirect.searchParams.get('error')).toBe('interaction_required')
    expect(redirect.searchParams.get('error_description')).toContain('not supported')
    expect(db.oauthConsents.insert).not.toHaveBeenCalled()
    expect(db.authorizationCodes.insert).not.toHaveBeenCalled()
  })

  it('approved=true + JARM -> redirectUrl 只回传 response JWT', async () => {
    const db = clientDb()
    vi.mocked(createTenantDb).mockReturnValue(db)
    mockActiveClient()
    const app = makeApp(registerSessionAuthRoutes, { session: makeSession() })
    const env = makeEnv({ oauthStateNs: oauthStateNs(JARM_PENDING) })
    const res = await post(app, env, { promptId: 'p1', approved: true })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { redirectUrl: string }
    const url = new URL(body.redirectUrl)
    expect(url.searchParams.get('code')).toBeNull()
    expect(url.searchParams.get('response')).toBe('signed:ac_test:rp-state')
  })

  it('approved=false -> access_denied redirectUrl(不持久化)', async () => {
    const db = clientDb()
    vi.mocked(createTenantDb).mockReturnValue(db)
    const app = makeApp(registerSessionAuthRoutes, { session: makeSession() })
    const env = makeEnv({ oauthStateNs: oauthStateNs(PENDING) })
    const res = await post(app, env, { promptId: 'p1', approved: false })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { redirectUrl: string }
    expect(body.redirectUrl).toContain('error=access_denied')
    expect(db.oauthConsents.insert).not.toHaveBeenCalled()
  })

  it('approved=false + JARM -> redirectUrl 只回传 response JWT', async () => {
    const db = clientDb()
    vi.mocked(createTenantDb).mockReturnValue(db)
    const app = makeApp(registerSessionAuthRoutes, { session: makeSession() })
    const env = makeEnv({ oauthStateNs: oauthStateNs(JARM_PENDING) })
    const res = await post(app, env, { promptId: 'p1', approved: false })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { redirectUrl: string }
    const url = new URL(body.redirectUrl)
    expect(url.searchParams.get('error')).toBeNull()
    expect(url.searchParams.get('response')).toBe('signed:access_denied:rp-state')
    expect(db.oauthConsents.insert).not.toHaveBeenCalled()
  })

  it('无 session -> 401', async () => {
    vi.mocked(readSession).mockResolvedValue(null)
    const app = makeApp(registerSessionAuthRoutes, { session: null })
    const res = await post(app, makeEnv(), { promptId: 'p1', approved: true })
    expect(res.status).toBe(401)
  })

  it('pending_mfa session -> 401(MFA 未完成不算已认证)', async () => {
    vi.mocked(readSession).mockResolvedValue(null)
    const app = makeApp(registerSessionAuthRoutes, {
      session: { ...makeSession(), status: 'pending_mfa' },
    })
    const res = await post(app, makeEnv(), { promptId: 'p1', approved: true })
    expect(res.status).toBe(401)
  })

  it('approved=true 但 client 已被禁用 -> invalid_client,不发 code 不持久化(TOCTOU)', async () => {
    const db = clientDb()
    vi.mocked(createTenantDb).mockReturnValue(db)
    vi.mocked(findClient).mockResolvedValue(null)
    const app = makeApp(registerSessionAuthRoutes, { session: makeSession() })
    const env = makeEnv({ oauthStateNs: oauthStateNs(PENDING) })
    const res = await post(app, env, { promptId: 'p1', approved: true })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { code: string }).code).toBe('invalid_client')
    expect(db.oauthConsents.insert).not.toHaveBeenCalled()
    expect(db.authorizationCodes.insert).not.toHaveBeenCalled()
  })

  it('approved=true 但 scope 已被收窄 -> invalid_scope,不发 code 不持久化(TOCTOU)', async () => {
    const db = clientDb()
    vi.mocked(createTenantDb).mockReturnValue(db)
    mockActiveClient(['openid'])
    const app = makeApp(registerSessionAuthRoutes, { session: makeSession() })
    const env = makeEnv({ oauthStateNs: oauthStateNs(PENDING) })
    const res = await post(app, env, { promptId: 'p1', approved: true })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { code: string }).code).toBe('invalid_scope')
    expect(db.oauthConsents.insert).not.toHaveBeenCalled()
    expect(db.authorizationCodes.insert).not.toHaveBeenCalled()
  })
})
