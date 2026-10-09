// Header SSO authenticate: RateLimitStore throttling (fail closed) and the uniform 401.

import { DEFAULT_HOSTED_AUTH_POLICY } from '@xid-kit/types'
import { Hono } from 'hono'
import type { ErrorHandler } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AppError, isAppError } from '../../lib/errors'
import type { XidHonoEnv } from '../../lib/types'
import { requireApiKeyOrOrgManager } from '../../v1/shared'
import { registerDirectoryConnectorRoutes } from '../directory-connector'
import { digestTrustedProxySecret } from '../legacy-shared'

const mockFindOne = vi.fn()

vi.mock('@xid-kit/db', () => ({
  createTenantDb: vi.fn(() => ({
    ssoConnections: { findOne: mockFindOne, update: vi.fn() },
  })),
  resolveTenantContextBySsoConnection: vi.fn(),
  schema: { ssoConnections: { id: 'id' } },
}))
vi.mock('../jit', () => ({
  jitProvision: vi.fn(async () => ({ userId: 'user-header', provisioned: false })),
}))
vi.mock('../../lib/session', () => ({ issueSession: vi.fn(async () => ({})) }))
vi.mock('../../lib/mfa-session', () => ({ resolvePostAuthMfaGate: vi.fn(async () => ({})) }))
vi.mock('../../v1/shared', () => ({ requireApiKeyOrOrgManager: vi.fn() }))

const PROXY_SECRET = 'p'.repeat(40)

type RateLimitCall = { action: string; key: string }

function rateLimiter(options: { allowed?: boolean; status?: number }): {
  namespace: DurableObjectNamespace
  calls: RateLimitCall[]
} {
  const calls: RateLimitCall[] = []
  const namespace = {
    idFromName: (name: string) => name as unknown as DurableObjectId,
    get: () => ({
      fetch: async (url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as { key?: string }
        calls.push({ action: new URL(url).pathname.slice(1), key: body.key ?? '' })
        if (options.status && options.status !== 200)
          return new Response('down', { status: options.status })
        return Response.json({ allowed: options.allowed ?? true, retryAfter: 0, count: 1 })
      },
    }),
  } as unknown as DurableObjectNamespace
  return { namespace, calls }
}

const errorHandler: ErrorHandler<XidHonoEnv> = (err, c) =>
  isAppError(err)
    ? c.json({ code: err.code }, err.httpStatus as Parameters<typeof c.json>[1])
    : c.json({ code: 'server_error' }, 500)

function buildApp(): Hono<XidHonoEnv> {
  const app = new Hono<XidHonoEnv>()
  app.onError(errorHandler)
  app.use('*', async (c, next) => {
    c.set('tenant', {
      tenantId: 'tenant-1',
      issuer: 'https://tenant-1.xid.dev',
      rpId: 'tenant-1.xid.dev',
      signingKeys: { activeKid: 'k1', defaultAlg: 'ES256', keys: [] },
      policy: {
        hostedAuth: {
          ...DEFAULT_HOSTED_AUTH_POLICY,
          enterpriseSso: {
            enabled: true,
            allowLogin: true,
            allowJitUserCreation: true,
            domainDiscovery: true,
            allowedEmailDomains: [],
            blockedEmailDomains: [],
          },
        },
      },
    } as never)
    await next()
  })
  registerDirectoryConnectorRoutes(app)
  return app
}

function authenticate(app: Hono<XidHonoEnv>, env: Env, secret: string): Promise<Response> {
  return Promise.resolve(
    app.request(
      '/sso/header/conn-1/authenticate',
      {
        method: 'POST',
        headers: {
          'CF-Connecting-IP': '203.0.113.7',
          'X-Remote-User': 'alice@acme-corp.net',
          'X-Remote-Email': 'alice@acme-corp.net',
          'X-Trusted-Proxy-Secret': secret,
        },
      },
      env,
    ),
  )
}

describe('header SSO authenticate', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    mockFindOne.mockResolvedValue({
      id: 'conn-1',
      orgId: 'org-1',
      protocol: 'header',
      status: 'active',
      idpSsoUrl: null,
      attributeMapping: {
        _legacy: { trustedProxySecretDigest: await digestTrustedProxySecret(PROXY_SECRET) },
      },
    })
  })

  it('counts attempts per connection and source IP and resets the counter after a login', async () => {
    const limiter = rateLimiter({})
    const env = { DB: {}, ENVIRONMENT: 'test', RATE_LIMITER: limiter.namespace } as unknown as Env

    const res = await authenticate(buildApp(), env, PROXY_SECRET)

    expect(res.status).toBe(302)
    expect(limiter.calls).toEqual([
      { action: 'check', key: 'verify:acct:tenant-1:sso_header:conn-1:203.0.113.7' },
      { action: 'reset', key: 'verify:acct:tenant-1:sso_header:conn-1:203.0.113.7' },
    ])
  })

  it('does not reset the counter when the proxy secret is wrong', async () => {
    const limiter = rateLimiter({})
    const env = { DB: {}, ENVIRONMENT: 'test', RATE_LIMITER: limiter.namespace } as unknown as Env

    const res = await authenticate(buildApp(), env, 'q'.repeat(40))

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ code: 'invalid_credentials' })
    expect(limiter.calls.map((call) => call.action)).toEqual(['check'])
  })

  it('returns 429 without checking the secret once the limit is reached', async () => {
    const limiter = rateLimiter({ allowed: false })
    const env = { DB: {}, ENVIRONMENT: 'test', RATE_LIMITER: limiter.namespace } as unknown as Env

    const res = await authenticate(buildApp(), env, PROXY_SECRET)

    expect(res.status).toBe(429)
    expect(mockFindOne).not.toHaveBeenCalled()
  })

  it('fails closed when the rate limiter is unavailable', async () => {
    const limiter = rateLimiter({ status: 503 })
    const env = { DB: {}, ENVIRONMENT: 'test', RATE_LIMITER: limiter.namespace } as unknown as Env

    const res = await authenticate(buildApp(), env, PROXY_SECRET)

    expect(res.status).toBe(500)
    expect(mockFindOne).not.toHaveBeenCalled()
  })

  it('answers a missing identity header with the same 401 as a wrong secret', async () => {
    const limiter = rateLimiter({})
    const env = { DB: {}, ENVIRONMENT: 'test', RATE_LIMITER: limiter.namespace } as unknown as Env

    const res = await buildApp().request(
      '/sso/header/conn-1/authenticate',
      { method: 'POST', headers: { 'X-Trusted-Proxy-Secret': PROXY_SECRET } },
      env,
    )

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ code: 'invalid_credentials' })
  })

  it('answers a connection of another protocol with the same 401', async () => {
    mockFindOne.mockResolvedValue({
      id: 'conn-1',
      orgId: 'org-1',
      protocol: 'ldap',
      status: 'active',
      idpSsoUrl: null,
      attributeMapping: {},
    })
    const limiter = rateLimiter({})
    const env = { DB: {}, ENVIRONMENT: 'test', RATE_LIMITER: limiter.namespace } as unknown as Env

    const res = await authenticate(buildApp(), env, PROXY_SECRET)

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ code: 'invalid_credentials' })
  })
})

describe('directory connector validate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFindOne.mockResolvedValue({
      id: 'conn-1',
      orgId: 'org-1',
      protocol: 'header',
      status: 'active',
      idpSsoUrl: null,
      attributeMapping: { _legacy: {} },
    })
  })

  it('requires an org manager or API key before reporting connection configuration', async () => {
    vi.mocked(requireApiKeyOrOrgManager).mockRejectedValueOnce(
      new AppError('unauthorized', { httpStatus: 401 }),
    )
    const env = { DB: {}, ENVIRONMENT: 'test' } as unknown as Env

    const res = await buildApp().request(
      '/sso/directory-connectors/conn-1/validate',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectorKey: 'header_sso' }),
      },
      env,
    )

    expect(res.status).toBe(401)
    expect(requireApiKeyOrOrgManager).toHaveBeenCalledWith(
      expect.anything(),
      'org-1',
      'connections:read',
    )
  })
})
