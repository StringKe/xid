// oidc-rp.ts 单元测试。
// 验证:state 防重放/跨租户 state 拒绝/nonce 校验/invalid_request 分支。

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { HostedAuthPolicy, TenantContext } from '@xid-kit/types'
import { DEFAULT_HOSTED_AUTH_POLICY } from '@xid-kit/types'

// --- mock ---
vi.mock('@xid-kit/db', () => ({
  createTenantDb: vi.fn(() => ({
    ssoConnections: { findOne: mockSsoConnectionsFindOne },
  })),
  resolveTenantContextById: vi.fn(),
  resolveTenantContextBySsoConnection: vi.fn(),
  schema: {
    ssoConnections: { id: 'id', status: 'status' },
  },
}))

vi.mock('@xid-kit/crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xid-kit/crypto')>()
  return {
    ...actual,
    base64UrlEncode: (b: Uint8Array) => Buffer.from(b).toString('base64url'),
    importJwkForVerify: vi.fn().mockResolvedValue({} as CryptoKey),
    verifyJwt: vi.fn(),
  }
})

vi.mock('../jit', () => ({
  jitProvision: vi.fn().mockResolvedValue({ userId: 'user-jit', provisioned: false }),
}))

vi.mock('../../lib/session', () => ({
  issueSession: vi.fn().mockResolvedValue({ session: {}, refreshToken: 'rt' }),
}))

vi.mock('../../lib/mfa-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/mfa-session')>()
  return { ...actual, resolvePostAuthMfaGate: vi.fn().mockResolvedValue({}) }
})

const mockSsoConnectionsFindOne = vi.fn()

import { Hono } from 'hono'
import type { ErrorHandler } from 'hono'
import type { XidHonoEnv } from '../../lib/types'
import { isAppError } from '../../lib/errors'
import { registerOidcRpRoutes } from '../oidc-rp'
import { verifyJwt } from '@xid-kit/crypto'
import { issueSession } from '../../lib/session'
import {
  createTenantDb,
  resolveTenantContextById,
  resolveTenantContextBySsoConnection,
} from '@xid-kit/db'

const testErrorHandler: ErrorHandler<XidHonoEnv> = (err, c) => {
  if (isAppError(err)) {
    return c.json({ code: err.code }, err.httpStatus as Parameters<typeof c.json>[1])
  }
  return c.json({ code: 'server_error' }, 500)
}

const ENTERPRISE_SSO_ENABLED: HostedAuthPolicy = {
  ...DEFAULT_HOSTED_AUTH_POLICY,
  enterpriseSso: {
    enabled: true,
    allowLogin: true,
    allowJitUserCreation: true,
    domainDiscovery: true,
    allowedEmailDomains: [],
    blockedEmailDomains: [],
  },
}

function buildApp(tenantId = 'tenant-1', hostedAuth = ENTERPRISE_SSO_ENABLED) {
  const app = new Hono<XidHonoEnv>()
  app.onError(testErrorHandler)
  app.use('*', async (c, next) => {
    c.set('tenant', {
      tenantId,
      issuer: `https://${tenantId}.xid.dev`,
      rpId: `${tenantId}.xid.dev`,
      signingKeys: { activeKid: 'k1', defaultAlg: 'ES256', keys: [] },
      policy: { hostedAuth },
    })
    await next()
  })
  registerOidcRpRoutes(app)
  return app
}

function rootApp() {
  const app = new Hono<XidHonoEnv>()
  app.onError(testErrorHandler)
  app.use('*', async (c, next) => {
    c.set('tenant', {
      tenantId: 'tenant-entry',
      issuer: 'https://xid.dev',
      rpId: 'xid.dev',
      signingKeys: { activeKid: 'k1', defaultAlg: 'ES256', keys: [] },
      policy: {},
      resolution: { kind: 'instance_entry', primaryDomain: 'xid.dev', unresolvedRoot: true },
    })
    await next()
  })
  registerOidcRpRoutes(app)
  return app
}

function resolvedTenant(
  tenantId = 'tenant-resolved',
  hostedAuth = ENTERPRISE_SSO_ENABLED,
): TenantContext {
  return {
    tenantId,
    issuer: 'https://xid.dev',
    rpId: `${tenantId}.xid.dev`,
    signingKeys: { activeKid: 'k1', defaultAlg: 'ES256', keys: [] },
    policy: { hostedAuth },
    hostedAuthOrigin: 'https://xid.dev',
    resolution: { kind: 'tenant', primaryDomain: 'xid.dev' },
  }
}

function makeConnection(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'conn-1',
    orgId: 'org-1',
    protocol: 'oidc',
    status: 'active',
    oidcDiscoveryUrl: 'https://idp.example.com/.well-known/openid-configuration',
    oidcClientId: 'client-abc',
    jitEnabled: true,
    roleMapping: {},
    ...overrides,
  }
}

// DO store backed env。
function makeDoStore() {
  const store = new Map<string, unknown>()
  const doFetch = vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(url)
    if (u.pathname === '/store') {
      const body = JSON.parse((init?.body as string) ?? '{}') as Record<string, unknown>
      store.set(body['state'] as string, body)
      return new Response(null, { status: 201 })
    }
    if (u.pathname === '/consume') {
      const body = JSON.parse((init?.body as string) ?? '{}') as Record<string, unknown>
      const key = body['state'] as string
      const record = store.get(key)
      if (!record) return new Response('{}', { status: 404 })
      store.delete(key)
      return new Response(JSON.stringify({ record }), { status: 200 })
    }
    return new Response('Not Found', { status: 404 })
  })
  const ns = {
    idFromName: vi.fn().mockReturnValue('do-id'),
    get: vi.fn().mockReturnValue({ fetch: doFetch }),
  }
  return { store, ns }
}

function makeBaseEnv(ns?: unknown): Env {
  return {
    DB: {} as D1Database,
    OAUTH_STATE: (ns ?? {}) as DurableObjectNamespace,
    AUDIT_QUEUE: { send: vi.fn() },
  } as unknown as Env
}

function seedState(
  store: Map<string, unknown>,
  state: string,
  overrides: Record<string, unknown> = {},
) {
  store.set(state, {
    state,
    tenantId: 'tenant-1',
    connectionId: 'conn-1',
    codeVerifier: 'verifier-xyz',
    nonce: 'nonce-123',
    redirectAfterLogin: '/console',
    returnToOrigin: 'https://tenant-1.xid.dev',
    createdAt: Date.now(),
    ...overrides,
  })
}

function mockIdpEndpoints() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    const u = url.toString()
    if (u.includes('openid-configuration')) {
      return new Response(
        JSON.stringify({
          authorization_endpoint: 'https://idp.example.com/authorize',
          token_endpoint: 'https://idp.example.com/token',
          jwks_uri: 'https://idp.example.com/jwks',
          issuer: 'https://idp.example.com',
        }),
      )
    }
    if (u.includes('/jwks'))
      return new Response(
        JSON.stringify({
          keys: [{ kty: 'RSA', kid: 'k1', alg: 'RS256', use: 'sig', n: 'x', e: 'AQAB' }],
        }),
      )
    if (u.includes('/token'))
      return new Response(
        JSON.stringify({ id_token: 'tok.pay.sig', access_token: 'at', token_type: 'Bearer' }),
      )
    return new Response('{}')
  })
}

const baseApp = buildApp()

describe('OIDC RP -- authorize', () => {
  beforeEach(() => vi.clearAllMocks())

  it('connection 不存在 -> connection_not_found', async () => {
    mockSsoConnectionsFindOne.mockResolvedValue(undefined)
    const env = makeBaseEnv()
    const res = await baseApp.request('/sso/oidc/conn-x/authorize', {}, env)
    expect(((await res.json()) as Record<string, unknown>)['code']).toBe('connection_not_found')
  })

  it('connection protocol 非 oidc -> invalid_request', async () => {
    mockSsoConnectionsFindOne.mockResolvedValue(makeConnection({ protocol: 'saml' }))
    const env = makeBaseEnv()
    const res = await baseApp.request('/sso/oidc/conn-1/authorize', {}, env)
    expect(((await res.json()) as Record<string, unknown>)['code']).toBe('invalid_request')
  })

  it('enterprise SSO 未启用时 direct authorize 拒绝且不拉 discovery', async () => {
    mockSsoConnectionsFindOne.mockResolvedValue(makeConnection())
    const gFetch = mockIdpEndpoints()
    const app = buildApp('tenant-1', DEFAULT_HOSTED_AUTH_POLICY)
    const env = makeBaseEnv()
    const res = await app.request('/sso/oidc/conn-1/authorize', {}, env)

    expect(res.status).toBe(401)
    expect(((await res.json()) as Record<string, unknown>)['code']).toBe('invalid_credentials')
    expect(gFetch).not.toHaveBeenCalled()
    gFetch.mockRestore()
  })

  it('root authorize 按 connectionId 切到最终 tenant 并存入 state', async () => {
    const { store, ns } = makeDoStore()
    vi.mocked(resolveTenantContextBySsoConnection).mockResolvedValue({
      ok: true,
      value: { status: 'resolved', tenant: resolvedTenant() },
    })
    mockSsoConnectionsFindOne.mockResolvedValue(makeConnection())
    const gFetch = mockIdpEndpoints()
    const env = makeBaseEnv(ns)
    const res = await rootApp().request(
      'https://xid.dev/sso/oidc/conn-1/authorize?continue=/account',
      {},
      env,
    )

    expect(res.status).toBe(302)
    const location = new URL(res.headers.get('location') ?? '')
    const state = location.searchParams.get('state') ?? ''
    expect(store.get(state)).toEqual(expect.objectContaining({ tenantId: 'tenant-resolved' }))
    expect(location.searchParams.get('redirect_uri')).toBe(
      'https://xid.dev/sso/oidc/conn-1/callback',
    )
    expect(store.get(state)).toEqual(expect.objectContaining({ returnToOrigin: 'https://xid.dev' }))
    expect(resolveTenantContextBySsoConnection).toHaveBeenCalledWith(
      expect.any(Request),
      expect.anything(),
      'conn-1',
    )
    expect(createTenantDb).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        tenantId: 'tenant-resolved',
      }),
    )
    gFetch.mockRestore()
  })

  it('authorize 未传 continue 时默认保存 console 回跳', async () => {
    const { store, ns } = makeDoStore()
    mockSsoConnectionsFindOne.mockResolvedValue(makeConnection())
    const gFetch = mockIdpEndpoints()
    const env = makeBaseEnv(ns)
    const res = await buildApp().request('/sso/oidc/conn-1/authorize', {}, env)

    expect(res.status).toBe(302)
    const location = new URL(res.headers.get('location') ?? '')
    const state = location.searchParams.get('state') ?? ''
    expect(store.get(state)).toEqual(expect.objectContaining({ redirectAfterLogin: '/console' }))
    gFetch.mockRestore()
  })
})

describe('OIDC RP -- callback 基础校验', () => {
  beforeEach(() => vi.clearAllMocks())

  it('state 缺失 -> invalid_request', async () => {
    const env = makeBaseEnv()
    const res = await baseApp.request('/sso/oidc/conn-1/callback?code=abc', {}, env)
    expect(((await res.json()) as Record<string, unknown>)['code']).toBe('invalid_request')
  })

  it('code 缺失 -> invalid_request', async () => {
    const env = makeBaseEnv()
    const res = await baseApp.request('/sso/oidc/conn-1/callback?state=xyz', {}, env)
    expect(((await res.json()) as Record<string, unknown>)['code']).toBe('invalid_request')
  })

  it('跨租户 state -> cross_tenant_access_denied', async () => {
    const { store, ns } = makeDoStore()
    seedState(store, 'state-cross', { tenantId: 'tenant-OTHER' })
    const env = makeBaseEnv(ns)
    const res = await baseApp.request(
      '/sso/oidc/conn-1/callback?code=abc&state=state-cross',
      {},
      env,
    )
    expect(((await res.json()) as Record<string, unknown>)['code']).toBe(
      'cross_tenant_access_denied',
    )
  })

  it('root callback 按 state tenantId 切到最终 tenant 后换码签 session', async () => {
    const { store, ns } = makeDoStore()
    seedState(store, 'state-root', {
      tenantId: 'tenant-resolved',
      returnToOrigin: 'http://localhost:5174',
    })
    vi.mocked(resolveTenantContextById).mockResolvedValue({
      ok: true,
      value: { status: 'resolved', tenant: resolvedTenant() },
    })
    mockSsoConnectionsFindOne.mockResolvedValue(makeConnection())
    const gFetch = mockIdpEndpoints()
    vi.mocked(verifyJwt).mockResolvedValue({
      ok: true,
      value: {
        header: { alg: 'RS256', kid: 'k1' },
        payload: {
          sub: 'idp-user-1',
          iss: 'https://idp.example.com',
          aud: 'client-abc',
          nonce: 'nonce-123',
        },
      },
    })
    vi.mocked(issueSession).mockImplementationOnce(async (c) => {
      c.header('set-cookie', '__Host-xid.rt.sso=rt; Path=/; HttpOnly; Secure; SameSite=Lax')
      return { session: {}, refreshToken: 'rt' } as Awaited<ReturnType<typeof issueSession>>
    })
    const env = makeBaseEnv(ns)
    const res = await rootApp().request(
      'http://localhost:5174/sso/oidc/conn-1/callback?code=auth-code&state=state-root',
      {},
      env,
    )

    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('http://localhost:5174/console')
    expect(res.headers.get('set-cookie')).toContain('__Host-xid.rt.')
    expect(resolveTenantContextById).toHaveBeenCalledWith(
      expect.any(Request),
      expect.anything(),
      'tenant-resolved',
    )
    expect(createTenantDb).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        tenantId: 'tenant-resolved',
      }),
    )
    gFetch.mockRestore()
  })

  it('enterprise SSO 未启用时 callback 拒绝且不换码', async () => {
    const { store, ns } = makeDoStore()
    seedState(store, 'state-disabled')
    mockSsoConnectionsFindOne.mockResolvedValue(makeConnection())
    const gFetch = mockIdpEndpoints()
    const app = buildApp('tenant-1', DEFAULT_HOSTED_AUTH_POLICY)
    const env = makeBaseEnv(ns)
    const res = await app.request(
      '/sso/oidc/conn-1/callback?code=auth-code&state=state-disabled',
      {},
      env,
    )

    expect(res.status).toBe(401)
    expect(((await res.json()) as Record<string, unknown>)['code']).toBe('invalid_credentials')
    expect(gFetch).not.toHaveBeenCalled()
    expect(verifyJwt).not.toHaveBeenCalled()
    gFetch.mockRestore()
  })
})

describe('OIDC RP -- callback state 一次性消费', () => {
  beforeEach(() => vi.clearAllMocks())

  it('二次请求同 state -> invalid_request', async () => {
    const { store, ns } = makeDoStore()
    seedState(store, 'state-abc')
    mockSsoConnectionsFindOne.mockResolvedValue(makeConnection())
    const gFetch = mockIdpEndpoints()
    vi.mocked(verifyJwt).mockResolvedValue({
      ok: true,
      value: {
        header: { alg: 'RS256', kid: 'k1' },
        payload: {
          sub: 'idp-user-1',
          iss: 'https://idp.example.com',
          aud: 'client-abc',
          nonce: 'nonce-123',
        },
      },
    })
    const env = makeBaseEnv(ns)
    const res1 = await baseApp.request(
      '/sso/oidc/conn-1/callback?code=auth-code&state=state-abc',
      {},
      env,
    )
    expect(res1.status).toBe(302)
    const res2 = await baseApp.request(
      '/sso/oidc/conn-1/callback?code=auth-code&state=state-abc',
      {},
      env,
    )
    expect(((await res2.json()) as Record<string, unknown>)['code']).toBe('invalid_request')
    gFetch.mockRestore()
  })
})

describe('OIDC RP -- callback nonce 校验', () => {
  beforeEach(() => vi.clearAllMocks())

  it('nonce 不匹配 -> signature_invalid', async () => {
    const { store, ns } = makeDoStore()
    seedState(store, 'state-nonce', { nonce: 'expected-nonce' })
    mockSsoConnectionsFindOne.mockResolvedValue(makeConnection())
    const gFetch = mockIdpEndpoints()
    vi.mocked(verifyJwt).mockResolvedValue({
      ok: true,
      value: {
        header: { alg: 'RS256', kid: 'k1' },
        payload: {
          sub: 'idp-user-1',
          nonce: 'WRONG-nonce',
          iss: 'https://idp.example.com',
          aud: 'client-abc',
        },
      },
    })
    const env = makeBaseEnv(ns)
    const res = await baseApp.request(
      '/sso/oidc/conn-1/callback?code=abc&state=state-nonce',
      {},
      env,
    )
    expect(((await res.json()) as Record<string, unknown>)['code']).toBe('signature_invalid')
    gFetch.mockRestore()
  })
})
