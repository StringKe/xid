// social.ts handler 单元测试。
// 验证:account linking state 防重放 / 枚举防护 / 跨租户 state 拒绝。

import { describe, it, expect, vi } from 'vitest'

vi.mock('@xid-kit/db', () => ({
  createTenantDb: vi.fn(),
  resolveTenantContextByApplicationClientId: vi.fn(),
  resolveTenantContextById: vi.fn(),
  USER_PROVISIONED_BY_ANONYMOUS: 'anonymous',
  schema: {
    userIdentities: {
      provider: 'provider',
      providerUserId: 'providerUserId',
      id: 'id',
      userId: 'userId',
    },
    userEmails: { email: 'email', userId: 'userId' },
    users: { id: 'id', status: 'status', deletedAt: 'deletedAt' },
    sessions: { id: 'id', userId: 'userId' },
    memberships: { userId: 'userId', status: 'status', orgId: 'orgId' },
    organizations: { id: 'id', status: 'status', deletedAt: 'deletedAt' },
  },
}))

vi.mock('@xid-kit/crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xid-kit/crypto')>()
  return {
    ...actual,
    envelopeEncrypt: vi.fn().mockResolvedValue({
      iv: new Uint8Array(12),
      ciphertext: new Uint8Array(8),
      tag: new Uint8Array(16),
      kekVersion: 1,
    }),
    base64UrlDecode: (s: string) => new TextEncoder().encode(s),
    base64UrlEncode: (b: Uint8Array) => Buffer.from(b).toString('base64url'),
  }
})

vi.mock('../../lib/mfa-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/mfa-session')>()
  return { ...actual, resolvePostAuthMfaGate: vi.fn().mockResolvedValue({}) }
})

vi.mock('../invitations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../invitations')>()
  return {
    ...actual,
    requirePendingInvitationByToken: vi.fn(),
    resolveInvitationTenant: vi.fn(),
  }
})

vi.mock('../account-provisioning', () => ({
  provisionAccountAtomically: vi.fn(async (input: { user: { id: string } }) => input.user.id),
}))

vi.mock('../social-providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../social-providers')>()
  return {
    ...actual,
    exchangeCode: vi.fn().mockResolvedValue({
      accessToken: 'access-token',
      refreshToken: null,
      idToken: 'id-token',
    }),
    resolveProfile: vi.fn().mockResolvedValue({
      idpUserId: 'github-123',
      email: 'new@example.com',
      emailVerified: true,
      name: 'New User',
      profileRaw: {},
    }),
  }
})

import {
  createTenantDb,
  resolveTenantContextByApplicationClientId,
  resolveTenantContextById,
} from '@xid-kit/db'
import { Hono } from 'hono'
import type { ErrorHandler } from 'hono'
import type { TenantVar, XidHonoEnv } from '../../lib/types'
import { isAppError } from '../../lib/errors'
import { exchangeCode, resolveProfile } from '../social-providers'
import { provisionAccountAtomically } from '../account-provisioning'
import { requirePendingInvitationByToken, resolveInvitationTenant } from '../invitations'

const testErrorHandler: ErrorHandler<XidHonoEnv> = (err, c) => {
  if (isAppError(err)) {
    return c.json(
      {
        code: err.code,
        message: err.code,
        ...(err.longMessage ? { longMessage: err.longMessage } : {}),
      },
      err.httpStatus as Parameters<typeof c.json>[1],
    )
  }
  return c.json({ code: 'server_error', message: 'server_error' }, 500)
}

function makeTenant(tenantId = 'tenant-1') {
  return {
    tenantId,
    issuer: 'https://test.xid.dev',
    rpId: 'test.xid.dev',
    signingKeys: { activeKid: 'k1', defaultAlg: 'ES256', keys: [] },
    policy: {},
  }
}

function makeRootTenant() {
  return {
    ...makeTenant('org_app'),
    issuer: 'https://xid.dev',
    rpId: 'xid.dev',
    resolution: { kind: 'instance_entry', primaryDomain: 'xid.dev', unresolvedRoot: true },
  }
}

function makeAdminTenant() {
  return {
    ...makeTenant('org_admin'),
    issuer: 'https://xid.dev',
    rpId: 'xid.dev',
    hostedAuthOrigin: 'https://xid.dev',
    policy: {
      socialProviders: {
        github: makeGithubPolicy({ allowUserCreation: true }),
      },
    },
  }
}

function makeOAuthFlowDoNamespace(
  handler: (req: Request) => Promise<Response>,
): DurableObjectNamespace {
  return {
    idFromName: () => ({ toString: () => 'do-id' }) as DurableObjectId,
    get: () =>
      ({
        fetch: (input: RequestInfo, init?: RequestInit) => {
          const req = typeof input === 'string' ? new Request(input, init) : input
          return handler(req)
        },
      }) as unknown as DurableObjectStub,
  } as unknown as DurableObjectNamespace
}

// generation / add 必须回真实契约形状(session.ts 对坏形状 fail closed),其余 action 回 active:true。
function makeSessionRevocationNs(): DurableObjectNamespace {
  return {
    idFromName: () => ({ toString: () => 'sess-id' }) as DurableObjectId,
    get: () =>
      ({
        fetch: async (url: string) => {
          const action = new URL(url).pathname.replace(/^\//, '')
          if (action === 'generation') return Response.json({ generation: 0 })
          if (action === 'add') return Response.json({ ok: true, value: { accepted: true } })
          return Response.json({ active: true })
        },
      }) as unknown as DurableObjectStub,
  } as unknown as DurableObjectNamespace
}

function makeEnv(oauthHandler: (req: Request) => Promise<Response>, auditSend = vi.fn()) {
  return {
    DB: {} as D1Database,
    OAUTH_STATE: makeOAuthFlowDoNamespace(oauthHandler),
    SESSION_REVOCATION: makeSessionRevocationNs(),
    AUDIT_QUEUE: { send: auditSend },
    KEK: btoa('A'.repeat(32)),
    GITHUB_CLIENT_SECRET: 'secret-1',
  } as unknown as Env
}

function makeGithubPolicy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    authorizationEndpoint: 'https://github.com/login/oauth/authorize',
    tokenEndpoint: 'https://github.com/login/oauth/access_token',
    clientId: 'github-client',
    clientSecretRef: 'GITHUB_CLIENT_SECRET',
    scopes: ['read:user', 'user:email'],
    usesPkce: true,
    redirectUris: ['/account'],
    enabled: true,
    allowLogin: true,
    allowUserCreation: true,
    requireVerifiedEmail: true,
    allowedEmailDomains: [],
    blockedEmailDomains: [],
    ...overrides,
  }
}

function makeHostedAuthPolicy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    identifierMode: 'email',
    requireVerifiedEmail: true,
    allowedEmailDomains: [],
    blockedEmailDomains: [],
    forceSso: false,
    allowUserCreation: true,
    allowExistingUserLogin: true,
    password: { enabled: false, allowLogin: false, allowUserCreation: false },
    magicLink: { enabled: true, allowLogin: true, allowUserCreation: true },
    emailOtp: { enabled: true, allowLogin: true, allowUserCreation: true },
    smsOtp: { enabled: false, allowLogin: false, allowUserCreation: false },
    passkey: { enabled: false, allowLogin: false, allowUserCreation: false },
    enterpriseSso: {
      enabled: false,
      allowLogin: false,
      allowJitUserCreation: false,
      domainDiscovery: false,
      allowedEmailDomains: [],
      blockedEmailDomains: [],
    },
    ...overrides,
  }
}

function githubCallbackEnv(auditSend = vi.fn()): Env {
  return makeEnv(async (req) => {
    const url = new URL(req.url)
    if (url.pathname === '/consume') {
      return new Response(
        JSON.stringify({
          record: {
            tenantId: 'tenant-1',
            provider: 'github',
            codeVerifier: 'cv',
            nonce: 'nonce',
            redirectAfterLogin: '/account',
            returnToOrigin: 'https://test.xid.dev',
            createdAt: Date.now(),
          },
        }),
        { status: 200 },
      )
    }
    return new Response(null, { status: 201 })
  }, auditSend)
}

async function makeGithubPolicyApp(input: {
  hostedAuth?: Record<string, unknown>
  provider?: Record<string, unknown>
}): Promise<Hono<XidHonoEnv>> {
  const { registerSocialRoutes } = await import('../social')
  const app = new Hono<XidHonoEnv>()
  app.onError(testErrorHandler)
  app.use('*', async (c, next) => {
    c.set('tenant', {
      ...makeTenant(),
      policy: {
        hostedAuth: makeHostedAuthPolicy(input.hostedAuth),
        socialProviders: {
          github: makeGithubPolicy(input.provider),
        },
      },
    } as unknown as TenantVar)
    c.set('session', null)
    await next()
  })
  registerSocialRoutes(app)
  return app
}

async function makeApp(tenantId = 'tenant-1') {
  const { registerSocialRoutes } = await import('../social')
  const app = new Hono<XidHonoEnv>()
  app.onError(testErrorHandler)
  app.use('*', async (c, next) => {
    c.set('tenant', makeTenant(tenantId) as unknown as TenantVar)
    c.set('session', null)
    await next()
  })
  registerSocialRoutes(app)
  return app
}

describe('GET /auth/google/callback -- state 防重放', () => {
  it('state 不存在时返回 400 invalid_request', async () => {
    const env = makeEnv(async (req) => {
      const url = new URL(req.url)
      if (url.pathname === '/consume') {
        return new Response(JSON.stringify({ code: 'invalid_request' }), { status: 404 })
      }
      return new Response(null, { status: 201 })
    })
    vi.mocked(createTenantDb).mockReturnValue({} as unknown as ReturnType<typeof createTenantDb>)

    const app = await makeApp()
    const res = await app.request(
      '/auth/google/callback?code=authcode&state=bad-state',
      { method: 'GET' },
      env,
    )
    expect(res.status).toBe(400)
  })

  it('state consume DO 故障返回 500 server_error', async () => {
    vi.mocked(exchangeCode).mockClear()
    const env = makeEnv(async (req) => {
      const url = new URL(req.url)
      if (url.pathname === '/consume') {
        return new Response(JSON.stringify({ code: 'server_error' }), { status: 500 })
      }
      return new Response(null, { status: 201 })
    })
    vi.mocked(createTenantDb).mockReturnValue({} as unknown as ReturnType<typeof createTenantDb>)

    const app = await makeApp()
    const res = await app.request(
      '/auth/google/callback?code=authcode&state=bad-state',
      { method: 'GET' },
      env,
    )

    expect(res.status).toBe(500)
    expect(((await res.json()) as Record<string, unknown>)['code']).toBe('server_error')
    expect(exchangeCode).not.toHaveBeenCalled()
  })

  it('state consume DO 返回 malformed body 返回 500 server_error', async () => {
    vi.mocked(exchangeCode).mockClear()
    const env = makeEnv(async (req) => {
      const url = new URL(req.url)
      if (url.pathname === '/consume') {
        return new Response(JSON.stringify({ record: null }), { status: 200 })
      }
      return new Response(null, { status: 201 })
    })
    vi.mocked(createTenantDb).mockReturnValue({} as unknown as ReturnType<typeof createTenantDb>)

    const app = await makeApp()
    const res = await app.request(
      '/auth/google/callback?code=authcode&state=bad-state',
      { method: 'GET' },
      env,
    )

    expect(res.status).toBe(500)
    expect(((await res.json()) as Record<string, unknown>)['code']).toBe('server_error')
    expect(exchangeCode).not.toHaveBeenCalled()
  })

  it('state consume record 缺 codeVerifier 时返回 500 且不换码', async () => {
    vi.mocked(exchangeCode).mockClear()
    const env = makeEnv(async (req) => {
      const url = new URL(req.url)
      if (url.pathname === '/consume') {
        return new Response(
          JSON.stringify({
            record: {
              tenantId: 'tenant-1',
              provider: 'google',
              nonce: 'nonce',
              redirectAfterLogin: '/console',
              returnToOrigin: 'https://test.xid.dev',
              createdAt: Date.now(),
            },
          }),
          { status: 200 },
        )
      }
      return new Response(null, { status: 201 })
    })
    vi.mocked(createTenantDb).mockReturnValue({} as unknown as ReturnType<typeof createTenantDb>)

    const app = await makeApp()
    const res = await app.request(
      '/auth/google/callback?code=authcode&state=valid-state',
      { method: 'GET' },
      env,
    )

    expect(res.status).toBe(500)
    expect(((await res.json()) as Record<string, unknown>)['code']).toBe('server_error')
    expect(exchangeCode).not.toHaveBeenCalled()
  })

  it('state consume DO 返回 410 过期时仍是 400 invalid_request', async () => {
    vi.mocked(exchangeCode).mockClear()
    const env = makeEnv(async (req) => {
      const url = new URL(req.url)
      if (url.pathname === '/consume') {
        return new Response(JSON.stringify({ code: 'invalid_request' }), { status: 410 })
      }
      return new Response(null, { status: 201 })
    })
    vi.mocked(createTenantDb).mockReturnValue({} as unknown as ReturnType<typeof createTenantDb>)

    const app = await makeApp()
    const res = await app.request(
      '/auth/google/callback?code=authcode&state=expired-state',
      { method: 'GET' },
      env,
    )

    expect(res.status).toBe(400)
    expect(((await res.json()) as Record<string, unknown>)['code']).toBe('invalid_request')
    expect(exchangeCode).not.toHaveBeenCalled()
  })

  it('provider error param 重定向到取消页', async () => {
    const env = makeEnv(async () => new Response(null, { status: 201 }))
    vi.mocked(createTenantDb).mockReturnValue({} as unknown as ReturnType<typeof createTenantDb>)

    const app = await makeApp()
    const res = await app.request(
      '/auth/google/callback?error=access_denied&state=st',
      { method: 'GET' },
      env,
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toContain('cancelled')
  })

  it('跨租户 state 拒绝(state tenant_id != 当前 tenant)', async () => {
    const env = makeEnv(async (req) => {
      const url = new URL(req.url)
      if (url.pathname === '/consume') {
        return new Response(
          JSON.stringify({
            record: {
              tenantId: 'other-tenant',
              provider: 'google',
              codeVerifier: 'cv',
              nonce: 'nonce',
              redirectAfterLogin: '/console',
              returnToOrigin: 'https://test.xid.dev',
              createdAt: Date.now(),
            },
          }),
          { status: 200 },
        )
      }
      return new Response(null, { status: 201 })
    })
    vi.mocked(createTenantDb).mockReturnValue({} as unknown as ReturnType<typeof createTenantDb>)
    vi.mocked(resolveTenantContextById).mockResolvedValueOnce({
      ok: false,
      error: { code: 'tenant_not_found', message: 'tenant_not_found' },
    })

    const app = await makeApp('tenant-1')
    const res = await app.request(
      '/auth/google/callback?code=authcode&state=valid-state',
      { method: 'GET' },
      env,
    )
    expect(res.status).toBe(404)
  })
})

describe('GET /auth/github/authorize', () => {
  it('requires a Turnstile token before provider or state processing when configured', async () => {
    const stateFetch = vi.fn(async () => new Response(null, { status: 201 }))
    const env = {
      ...makeEnv(stateFetch),
      TURNSTILE_SITE_KEY: 'site-key',
      TURNSTILE_SECRET: 'secret',
    } as unknown as Env
    const app = await makeApp()

    const res = await app.request('/auth/github/authorize', { method: 'GET' }, env)

    expect(res.status).toBe(401)
    expect(((await res.json()) as { code: string }).code).toBe('captcha_required')
    expect(stateFetch).not.toHaveBeenCalled()
  })

  it('未配置 provider 返回 400', async () => {
    const env = makeEnv(async () => new Response(null, { status: 201 }))
    vi.mocked(createTenantDb).mockReturnValue({} as unknown as ReturnType<typeof createTenantDb>)

    const app = await makeApp()
    const res = await app.request('/auth/github/authorize', { method: 'GET' }, env)
    expect(res.status).toBe(400)
  })

  it('旧 /auth/social/:provider alias 不再注册', async () => {
    const env = makeEnv(async () => new Response(null, { status: 201 }))
    vi.mocked(createTenantDb).mockReturnValue({} as unknown as ReturnType<typeof createTenantDb>)

    const app = await makeApp()
    const res = await app.request('/auth/social/github', { method: 'GET' }, env)
    expect(res.status).toBe(404)
  })
})

describe('GET /auth/:provider/authorize', () => {
  it('正式 authorize 入口未配置 provider 返回 400', async () => {
    const env = makeEnv(async () => new Response(null, { status: 201 }))
    vi.mocked(createTenantDb).mockReturnValue({} as unknown as ReturnType<typeof createTenantDb>)

    const app = await makeApp()
    const res = await app.request(
      '/auth/github/authorize?continue=/account',
      { method: 'GET' },
      env,
    )
    expect(res.status).toBe(400)
  })

  it('从 TenantContext 读取 provider 配置并保存 continue 回跳', async () => {
    let stored: Record<string, unknown> | null = null
    const env = makeEnv(async (req) => {
      const url = new URL(req.url)
      if (url.pathname === '/store') {
        stored = (await req.json()) as Record<string, unknown>
        return new Response(null, { status: 201 })
      }
      return new Response(null, { status: 404 })
    })
    vi.mocked(createTenantDb).mockReturnValue({} as unknown as ReturnType<typeof createTenantDb>)

    const { registerSocialRoutes } = await import('../social')
    const app = new Hono<XidHonoEnv>()
    app.onError(testErrorHandler)
    app.use('*', async (c, next) => {
      c.set('tenant', {
        ...makeTenant(),
        policy: {
          socialProviders: {
            github: {
              authorizationEndpoint: 'https://github.com/login/oauth/authorize',
              tokenEndpoint: 'https://github.com/login/oauth/access_token',
              clientId: 'github-client',
              clientSecretRef: 'GITHUB_CLIENT_SECRET',
              scopes: ['read:user', 'user:email'],
              usesPkce: true,
              redirectUris: ['/account'],
              enabled: true,
              allowLogin: true,
              allowUserCreation: false,
              requireVerifiedEmail: true,
              allowedEmailDomains: [],
            },
          },
        },
      } as unknown as TenantVar)
      c.set('session', null)
      await next()
    })
    registerSocialRoutes(app)

    const res = await app.request(
      '/auth/github/authorize?continue=/account',
      { method: 'GET' },
      env,
    )

    expect(res.status).toBe(302)
    const location = new URL(res.headers.get('location') ?? '')
    expect(location.origin).toBe('https://github.com')
    expect(location.pathname).toBe('/login/oauth/authorize')
    expect(location.searchParams.get('client_id')).toBe('github-client')
    expect(stored?.['redirectAfterLogin']).toBe('/account')
  })

  it('Apple authorize 使用 form_post response mode', async () => {
    let stored: Record<string, unknown> | null = null
    const env = {
      ...makeEnv(async (req) => {
        const url = new URL(req.url)
        if (url.pathname === '/store') {
          stored = (await req.json()) as Record<string, unknown>
          return new Response(null, { status: 201 })
        }
        return new Response(null, { status: 404 })
      }),
      APPLE_CLIENT_SECRET: 'apple-secret',
    } as unknown as Env
    vi.mocked(createTenantDb).mockReturnValue({} as unknown as ReturnType<typeof createTenantDb>)

    const { registerSocialRoutes } = await import('../social')
    const app = new Hono<XidHonoEnv>()
    app.onError(testErrorHandler)
    app.use('*', async (c, next) => {
      c.set('tenant', {
        ...makeTenant(),
        policy: {
          socialProviders: {
            apple: {
              authorizationEndpoint: 'https://appleid.apple.com/auth/authorize',
              tokenEndpoint: 'https://appleid.apple.com/auth/token',
              clientId: 'apple-client',
              clientSecretRef: 'APPLE_CLIENT_SECRET',
              scopes: ['openid', 'email', 'name'],
              usesPkce: true,
              issuer: 'https://appleid.apple.com',
              jwksUri: 'https://appleid.apple.com/auth/keys',
              redirectUris: ['/account'],
              enabled: true,
              allowLogin: true,
              allowUserCreation: true,
              requireVerifiedEmail: true,
              allowedEmailDomains: [],
              blockedEmailDomains: [],
            },
          },
        },
      } as unknown as TenantVar)
      c.set('session', null)
      await next()
    })
    registerSocialRoutes(app)

    const res = await app.request('/auth/apple/authorize?continue=/account', { method: 'GET' }, env)

    expect(res.status).toBe(302)
    const location = new URL(res.headers.get('location') ?? '')
    expect(location.origin).toBe('https://appleid.apple.com')
    expect(location.pathname).toBe('/auth/authorize')
    expect(location.searchParams.get('client_id')).toBe('apple-client')
    expect(location.searchParams.get('response_mode')).toBe('form_post')
    expect(location.searchParams.get('redirect_uri')).toBe('http://localhost/auth/apple/callback')
    expect(stored?.['provider']).toBe('apple')
  })

  it('Microsoft authorize 使用配置的 OIDC endpoint', async () => {
    let stored: Record<string, unknown> | null = null
    const env = {
      ...makeEnv(async (req) => {
        const url = new URL(req.url)
        if (url.pathname === '/store') {
          stored = (await req.json()) as Record<string, unknown>
          return new Response(null, { status: 201 })
        }
        return new Response(null, { status: 404 })
      }),
      MICROSOFT_CLIENT_SECRET: 'microsoft-secret',
    } as unknown as Env
    vi.mocked(createTenantDb).mockReturnValue({} as unknown as ReturnType<typeof createTenantDb>)

    const { registerSocialRoutes } = await import('../social')
    const app = new Hono<XidHonoEnv>()
    app.onError(testErrorHandler)
    app.use('*', async (c, next) => {
      c.set('tenant', {
        ...makeTenant(),
        policy: {
          socialProviders: {
            microsoft: {
              authorizationEndpoint:
                'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize',
              tokenEndpoint: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token',
              clientId: 'microsoft-client',
              clientSecretRef: 'MICROSOFT_CLIENT_SECRET',
              scopes: ['openid', 'profile', 'email'],
              usesPkce: true,
              issuer: 'https://login.microsoftonline.com/consumers/v2.0',
              jwksUri: 'https://login.microsoftonline.com/consumers/discovery/v2.0/keys',
              redirectUris: ['/account'],
              enabled: true,
              allowLogin: true,
              allowUserCreation: true,
              requireVerifiedEmail: true,
              allowedEmailDomains: [],
              blockedEmailDomains: [],
            },
          },
        },
      } as unknown as TenantVar)
      c.set('session', null)
      await next()
    })
    registerSocialRoutes(app)

    const res = await app.request(
      '/auth/microsoft/authorize?continue=/account',
      { method: 'GET' },
      env,
    )

    expect(res.status).toBe(302)
    const location = new URL(res.headers.get('location') ?? '')
    expect(location.origin).toBe('https://login.microsoftonline.com')
    expect(location.pathname).toBe('/consumers/oauth2/v2.0/authorize')
    expect(location.searchParams.get('client_id')).toBe('microsoft-client')
    expect(location.searchParams.get('response_mode')).toBeNull()
    expect(stored?.['provider']).toBe('microsoft')
  })

  it('forceSso 时 authorize 拒绝 social provider 且不保存 state', async () => {
    const auditSend = vi.fn()
    let stored = false
    const env = makeEnv(async (req) => {
      const url = new URL(req.url)
      if (url.pathname === '/store') stored = true
      return new Response(null, { status: 201 })
    }, auditSend)
    vi.mocked(createTenantDb).mockReturnValue({} as unknown as ReturnType<typeof createTenantDb>)

    const app = await makeGithubPolicyApp({ hostedAuth: { forceSso: true } })
    const res = await app.request(
      '/auth/github/authorize?continue=/account',
      { method: 'GET' },
      env,
    )

    expect(res.status).toBe(401)
    expect(stored).toBe(false)
    expect(auditSend).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        action: 'auth.policy_denied',
        payload: expect.objectContaining({
          method: 'social',
          action: 'login',
          provider: 'github',
          reason: 'force_sso',
        }),
      }),
    )
  })

  it('未传 continue 时默认保存 console 回跳', async () => {
    let stored: Record<string, unknown> | null = null
    const env = makeEnv(async (req) => {
      const url = new URL(req.url)
      if (url.pathname === '/store') {
        stored = (await req.json()) as Record<string, unknown>
        return new Response(null, { status: 201 })
      }
      return new Response(null, { status: 404 })
    })
    vi.mocked(createTenantDb).mockReturnValue({} as unknown as ReturnType<typeof createTenantDb>)

    const { registerSocialRoutes } = await import('../social')
    const app = new Hono<XidHonoEnv>()
    app.onError(testErrorHandler)
    app.use('*', async (c, next) => {
      c.set('tenant', {
        ...makeTenant(),
        policy: {
          socialProviders: {
            github: makeGithubPolicy({ redirectUris: ['/console'] }),
          },
        },
      } as unknown as TenantVar)
      c.set('session', null)
      await next()
    })
    registerSocialRoutes(app)

    const res = await app.request('/auth/github/authorize', { method: 'GET' }, env)

    expect(res.status).toBe(302)
    expect(stored?.['redirectAfterLogin']).toBe('/console')
  })

  it('root authorize with organization_id stores selected tenant in OAuth state', async () => {
    let stored: Record<string, unknown> | null = null
    const env = makeEnv(async (req) => {
      const url = new URL(req.url)
      if (url.pathname === '/store') {
        stored = (await req.json()) as Record<string, unknown>
        return new Response(null, { status: 201 })
      }
      return new Response(null, { status: 404 })
    })
    vi.mocked(resolveTenantContextById).mockResolvedValueOnce({
      ok: true,
      value: { status: 'resolved', tenant: makeAdminTenant() as unknown as TenantVar },
    })
    vi.mocked(createTenantDb).mockReturnValue({} as unknown as ReturnType<typeof createTenantDb>)

    const { registerSocialRoutes } = await import('../social')
    const app = new Hono<XidHonoEnv>()
    app.onError(testErrorHandler)
    app.use('*', async (c, next) => {
      c.set('tenant', makeRootTenant() as unknown as TenantVar)
      c.set('session', null)
      await next()
    })
    registerSocialRoutes(app)

    const res = await app.request(
      'https://xid.dev/auth/github/authorize?organization_id=org_admin&continue=/account',
      { method: 'GET' },
      env,
    )

    expect(res.status).toBe(302)
    expect(stored?.['tenantId']).toBe('org_admin')
    expect(stored?.['returnToOrigin']).toBe('https://xid.dev')
    expect(res.headers.get('location')).toContain('client_id=github-client')
  })

  it('root sign-up ignores organization candidates and stores the default staging Tenant', async () => {
    let stored: Record<string, unknown> | null = null
    const env = makeEnv(async (req) => {
      const url = new URL(req.url)
      if (url.pathname === '/store') {
        stored = (await req.json()) as Record<string, unknown>
        return new Response(null, { status: 201 })
      }
      return new Response(null, { status: 404 })
    })
    const rootTenant = {
      ...makeAdminTenant(),
      tenantId: 'org_app',
      resolution: {
        kind: 'instance_entry' as const,
        primaryDomain: 'xid.dev',
        unresolvedRoot: true,
      },
    }
    vi.mocked(resolveTenantContextById).mockClear()
    vi.mocked(createTenantDb).mockReturnValue({} as unknown as ReturnType<typeof createTenantDb>)
    const { registerSocialRoutes } = await import('../social')
    const app = new Hono<XidHonoEnv>()
    app.onError(testErrorHandler)
    app.use('*', async (c, next) => {
      c.set('tenant', rootTenant as unknown as TenantVar)
      c.set('session', null)
      await next()
    })
    registerSocialRoutes(app)

    const res = await app.request(
      'https://xid.dev/auth/github/authorize?organization_id=org_admin&login_hint=owner%40verified.example&intent=sign-up&continue=/create-organization',
      { method: 'GET' },
      env,
    )

    expect(res.status).toBe(302)
    expect(stored?.['tenantId']).toBe('org_app')
    expect(stored?.['intent']).toBe('sign-up')
    expect(stored?.['skipDefaultMembership']).toBe(true)
    expect(resolveTenantContextById).not.toHaveBeenCalled()
  })

  it.each([
    {
      name: 'client-bound product sign-up',
      query:
        'intent=sign-up&client_id=application_client&continue=%2Fauthorize%3Fauthz_request_id%3Dreq_1%26client_id%3Dapplication_client',
    },
    {
      name: 'Application sign-up without client binding',
      query: 'intent=application-sign-up&continue=%2Fauthorize%3Fauthz_request_id%3Dreq_1',
    },
    {
      name: 'authorize continuation without client binding',
      query: 'intent=sign-in&continue=%2Fauthorize%3Fauthz_request_id%3Dreq_1',
    },
  ])('rejects $name before OAuth state is stored', async ({ query }) => {
    let stored = false
    const env = makeEnv(async (req) => {
      if (new URL(req.url).pathname === '/store') stored = true
      return new Response(null, { status: 201 })
    })
    vi.mocked(createTenantDb).mockReturnValue({} as unknown as ReturnType<typeof createTenantDb>)
    const app = await makeGithubPolicyApp({})

    const res = await app.request(
      `https://test.xid.dev/auth/github/authorize?${query}`,
      { method: 'GET' },
      env,
    )

    expect(res.status).toBe(400)
    expect(stored).toBe(false)
  })

  it.each([
    {
      name: 'invitation_token parameter',
      query: 'invitation_token=raw-secret',
    },
    {
      name: 'raw token continue path',
      query: 'continue=%2Faccept-invitation%3Ftoken%3Draw-secret',
    },
    {
      name: 'invitation path with a fragment secret',
      query: 'continue=%2Faccept-invitation%23claim_token%3Draw-secret',
    },
    {
      name: 'invitation path with a parameter alias',
      query: 'continue=%2Faccept-invitation%3Fclaim_token%3Draw-secret',
    },
  ])('rejects $name before tenant lookup or OAuth state storage', async ({ query }) => {
    const stateFetch = vi.fn(async () => new Response(null, { status: 201 }))
    const env = makeEnv(stateFetch)
    const app = await makeGithubPolicyApp({})
    vi.mocked(resolveInvitationTenant).mockClear()
    vi.mocked(requirePendingInvitationByToken).mockClear()

    const res = await app.request(
      `https://test.xid.dev/auth/github/authorize?${query}`,
      { method: 'GET' },
      env,
    )

    expect(res.status).toBe(400)
    expect((await res.json())['code']).toBe('invalid_request')
    expect(resolveInvitationTenant).not.toHaveBeenCalled()
    expect(requirePendingInvitationByToken).not.toHaveBeenCalled()
    expect(stateFetch).not.toHaveBeenCalled()
  })

  it('root callback restores tenant from OAuth state before issuing session', async () => {
    const env = makeEnv(async (req) => {
      const url = new URL(req.url)
      if (url.pathname === '/consume') {
        return new Response(
          JSON.stringify({
            record: {
              tenantId: 'org_admin',
              provider: 'github',
              codeVerifier: 'cv',
              nonce: 'nonce',
              redirectAfterLogin: '/account',
              returnToOrigin: 'https://xid.dev',
              createdAt: Date.now(),
            },
          }),
          { status: 200 },
        )
      }
      return new Response(null, { status: 201 })
    })
    vi.mocked(resolveTenantContextById).mockResolvedValueOnce({
      ok: true,
      value: { status: 'resolved', tenant: makeAdminTenant() as unknown as TenantVar },
    })
    const db = {
      userIdentities: {
        findOne: vi.fn().mockResolvedValue({ id: 'ident_1', userId: 'user_admin' }),
        update: vi.fn().mockResolvedValue(undefined),
      },
      users: {
        findOne: vi.fn().mockResolvedValue({ id: 'user_admin', status: 'active', deletedAt: null }),
      },
      memberships: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { id: 'mem_1', userId: 'user_admin', orgId: 'org_admin', status: 'active' },
          ]),
      },
      organizations: {
        findOne: vi.fn().mockResolvedValue({ id: 'org_admin', status: 'active', deletedAt: null }),
        findMany: vi
          .fn()
          .mockResolvedValue([{ id: 'org_admin', status: 'active', deletedAt: null }]),
      },
      sessions: {
        insert: vi.fn().mockImplementation((row: Record<string, unknown>) =>
          Promise.resolve({
            ...row,
            activeOrgId: row['activeOrgId'] ?? null,
            isImpersonation: false,
            impersonatorUserId: null,
          }),
        ),
      },
    }
    vi.mocked(createTenantDb).mockReturnValue(db as unknown as ReturnType<typeof createTenantDb>)

    const { registerSocialRoutes } = await import('../social')
    const app = new Hono<XidHonoEnv>()
    app.onError(testErrorHandler)
    app.use('*', async (c, next) => {
      c.set('tenant', makeRootTenant() as unknown as TenantVar)
      c.set('session', null)
      await next()
    })
    registerSocialRoutes(app)

    const res = await app.request(
      'https://xid.dev/auth/github/callback?code=authcode&state=valid-state',
      { method: 'GET' },
      env,
    )

    expect(res.status).toBe(302)
    expect(db.sessions.insert).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'org_admin', userId: 'user_admin' }),
    )
  })

  it.each(['https://xid.dev', 'https://tenant-1.xid.dev'])(
    'callback default Console fallback redirects to original hosted origin：%s',
    async (returnToOrigin) => {
      const env = makeEnv(async (req) => {
        const url = new URL(req.url)
        if (url.pathname === '/consume') {
          return new Response(
            JSON.stringify({
              record: {
                tenantId: 'tenant-1',
                provider: 'github',
                codeVerifier: 'cv',
                nonce: 'nonce',
                redirectAfterLogin: '/console',
                returnToOrigin,
                createdAt: Date.now(),
              },
            }),
            { status: 200 },
          )
        }
        return new Response(null, { status: 201 })
      })
      const db = {
        userIdentities: {
          findOne: vi.fn().mockResolvedValue({ id: 'ident_1', userId: 'user-1' }),
          update: vi.fn().mockResolvedValue(undefined),
        },
        users: {
          findOne: vi.fn().mockResolvedValue({ id: 'user-1', status: 'active', deletedAt: null }),
        },
        memberships: {
          findMany: vi
            .fn()
            .mockResolvedValue([
              { id: 'mem_1', userId: 'user-1', orgId: 'tenant-1', status: 'active' },
            ]),
        },
        organizations: {
          findOne: vi.fn().mockResolvedValue({ id: 'tenant-1', status: 'active', deletedAt: null }),
          findMany: vi
            .fn()
            .mockResolvedValue([{ id: 'tenant-1', status: 'active', deletedAt: null }]),
        },
        sessions: {
          insert: vi.fn().mockImplementation((row: Record<string, unknown>) =>
            Promise.resolve({
              ...row,
              activeOrgId: row['activeOrgId'] ?? null,
              isImpersonation: false,
              impersonatorUserId: null,
            }),
          ),
        },
      }
      vi.mocked(createTenantDb).mockReturnValue(db as unknown as ReturnType<typeof createTenantDb>)
      const app = await makeGithubPolicyApp({ provider: { redirectUris: ['/account'] } })

      const res = await app.request(
        `${returnToOrigin}/auth/github/callback?code=authcode&state=valid-state`,
        { method: 'GET' },
        env,
      )

      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toBe(`${returnToOrigin}/console`)
      expect(res.headers.get('set-cookie')).toContain('__Host-xid.rt.')
    },
  )

  it('sign-up callback redirects to fixed create organization path', async () => {
    const env = makeEnv(async (req) => {
      const url = new URL(req.url)
      if (url.pathname === '/consume') {
        return new Response(
          JSON.stringify({
            record: {
              tenantId: 'tenant-1',
              provider: 'github',
              codeVerifier: 'cv',
              nonce: 'nonce',
              redirectAfterLogin: '/create-organization',
              returnToOrigin: 'https://test.xid.dev',
              createdAt: Date.now(),
              intent: 'sign-up',
              skipDefaultMembership: true,
            },
          }),
          { status: 200 },
        )
      }
      return new Response(null, { status: 201 })
    })
    const db = {
      userIdentities: {
        findOne: vi.fn().mockResolvedValue({ id: 'ident_1', userId: 'user-1' }),
        update: vi.fn().mockResolvedValue(undefined),
      },
      users: {
        findOne: vi.fn().mockResolvedValue({ id: 'user-1', status: 'active', deletedAt: null }),
      },
      memberships: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      organizations: {
        findOne: vi.fn().mockResolvedValue(undefined),
        findMany: vi.fn().mockResolvedValue([]),
      },
      sessions: {
        insert: vi.fn().mockImplementation((row: Record<string, unknown>) =>
          Promise.resolve({
            ...row,
            activeOrgId: row['activeOrgId'] ?? null,
            isImpersonation: false,
            impersonatorUserId: null,
          }),
        ),
      },
    }
    vi.mocked(createTenantDb).mockReturnValue(db as unknown as ReturnType<typeof createTenantDb>)
    const app = await makeGithubPolicyApp({ provider: { redirectUris: ['/account'] } })

    const res = await app.request(
      'https://test.xid.dev/auth/github/callback?code=authcode&state=valid-state',
      { method: 'GET' },
      env,
    )

    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('https://test.xid.dev/create-organization')
    expect(db.sessions.insert).toHaveBeenCalledWith(expect.objectContaining({ activeOrgId: null }))
  })

  it.each([
    {
      name: 'legacy raw token',
      overrides: { invitationToken: 'raw-secret' },
    },
    {
      name: 'legacy frozen invitation id',
      overrides: { invitationId: 'invitation_1' },
    },
    {
      name: 'legacy raw token continuation',
      overrides: { redirectAfterLogin: '/accept-invitation?token=raw-secret' },
    },
    {
      name: 'legacy invitation fragment secret',
      overrides: { redirectAfterLogin: '/accept-invitation#claim_token=raw-secret' },
    },
    {
      name: 'legacy invitation parameter alias',
      overrides: { redirectAfterLogin: '/accept-invitation?claim_token=raw-secret' },
    },
  ])(
    'rejects $name state before provider exchange, profile resolution, or writes',
    async ({ overrides }) => {
      const env = makeEnv(async (req) => {
        if (new URL(req.url).pathname !== '/consume') {
          return new Response(null, { status: 201 })
        }
        return Response.json({
          record: {
            tenantId: 'tenant-1',
            provider: 'github',
            codeVerifier: 'cv',
            nonce: 'nonce',
            redirectAfterLogin: '/console',
            returnToOrigin: 'https://test.xid.dev',
            createdAt: Date.now(),
            ...overrides,
          },
        })
      })
      vi.mocked(exchangeCode).mockClear()
      vi.mocked(resolveProfile).mockClear()
      vi.mocked(createTenantDb).mockClear()
      vi.mocked(provisionAccountAtomically).mockClear()
      const app = await makeGithubPolicyApp({})

      const res = await app.request(
        'https://test.xid.dev/auth/github/callback?code=authcode&state=valid-state',
        { method: 'GET' },
        env,
      )

      expect(res.status).toBe(400)
      expect((await res.json())['code']).toBe('invalid_request')
      expect(exchangeCode).not.toHaveBeenCalled()
      expect(resolveProfile).not.toHaveBeenCalled()
      expect(createTenantDb).not.toHaveBeenCalled()
      expect(provisionAccountAtomically).not.toHaveBeenCalled()
    },
  )

  it('guest 转正:分支 D 持有效 guest session -> identity 挂到 guest user,不新建 user', async () => {
    const auditSend = vi.fn().mockResolvedValue(undefined)
    const guestStoreCalls: string[] = []
    const env = {
      ...githubCallbackEnv(auditSend),
      GUEST_STORE: makeOAuthFlowDoNamespace(async (req) => {
        guestStoreCalls.push(new URL(req.url).pathname.replace(/^\//, ''))
        return new Response(null, { status: 204 })
      }),
    } as unknown as Env
    const db = {
      userIdentities: {
        findOne: vi.fn().mockResolvedValue(undefined),
        insert: vi.fn().mockResolvedValue({ id: 'ident-new' }),
        update: vi.fn().mockResolvedValue(undefined),
      },
      userEmails: { findOne: vi.fn().mockResolvedValue(undefined) },
      users: {
        findOne: vi.fn().mockResolvedValue({
          id: 'user-guest',
          status: 'active',
          deletedAt: null,
          provisionedBy: 'anonymous',
        }),
        insert: vi.fn(),
        update: vi.fn().mockResolvedValue([]),
      },
      memberships: { findMany: vi.fn().mockResolvedValue([]) },
      organizations: { findMany: vi.fn().mockResolvedValue([]) },
      sessions: {
        insert: vi.fn().mockImplementation((row: Record<string, unknown>) =>
          Promise.resolve({
            ...row,
            activeOrgId: row['activeOrgId'] ?? null,
            isImpersonation: false,
            impersonatorUserId: null,
          }),
        ),
        update: vi.fn().mockResolvedValue([]),
      },
    }
    vi.mocked(createTenantDb).mockReturnValue(db as unknown as ReturnType<typeof createTenantDb>)
    const { registerSocialRoutes } = await import('../social')
    const app = new Hono<XidHonoEnv>()
    app.onError(testErrorHandler)
    app.use('*', async (c, next) => {
      c.set('tenant', {
        ...makeTenant(),
        policy: {
          hostedAuth: makeHostedAuthPolicy(),
          socialProviders: { github: makeGithubPolicy() },
        },
      } as unknown as TenantVar)
      // live guest session:amr 含 guest,转正后由 MFA gate + issueSession 轮换。
      c.set('session', {
        sessionId: 'sess-guest',
        userId: 'user-guest',
        status: 'active',
        activeOrgId: null,
        authenticatedAt: new Date(),
        lastActiveAt: new Date(),
        expiresAt: new Date(Date.now() + 86400000),
        rememberMe: false,
        isImpersonation: false,
        impersonatorUserId: null,
        acr: 'urn:xid:aal1',
        amr: ['guest'],
        aal: 1,
      } as never)
      await next()
    })
    registerSocialRoutes(app)

    const res = await app.request(
      '/auth/github/callback?code=authcode&state=valid-state',
      { method: 'GET', headers: { cookie: '__Host-xid.anon=anon-x' } },
      env,
    )

    expect(res.status).toBe(302)
    // identity 挂到 guest user;social 建号不写 provisionedBy,转正同样置 null。
    expect(db.userIdentities.insert).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-guest', provider: 'github' }),
    )
    expect(db.users.insert).not.toHaveBeenCalled()
    expect(db.users.update).toHaveBeenCalledWith({ provisionedBy: null }, expect.anything())
    // session 轮换:旧 guest session 吊销。
    expect(db.sessions.update).toHaveBeenCalledWith({ status: 'revoked' }, expect.anything())
    expect(auditSend).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'guest.converted', actorId: 'user-guest' }),
    )
    expect(guestStoreCalls).toContain('unbind')
  })

  it('forceSso 时 callback 不交换 code 不创建用户不签发 session', async () => {
    vi.mocked(exchangeCode).mockClear()
    const auditSend = vi.fn()
    const env = githubCallbackEnv(auditSend)
    const db = {
      userIdentities: { findOne: vi.fn().mockResolvedValue(undefined) },
      userEmails: { findOne: vi.fn().mockResolvedValue(undefined) },
      users: { insert: vi.fn() },
      sessions: { insert: vi.fn() },
    }
    vi.mocked(createTenantDb).mockReturnValue(db as unknown as ReturnType<typeof createTenantDb>)
    const app = await makeGithubPolicyApp({ hostedAuth: { forceSso: true } })

    const res = await app.request(
      '/auth/github/callback?code=authcode&state=valid-state',
      { method: 'GET' },
      env,
    )

    expect(res.status).toBe(401)
    expect(exchangeCode).not.toHaveBeenCalled()
    expect(db.users.insert).not.toHaveBeenCalled()
    expect(db.sessions.insert).not.toHaveBeenCalled()
    expect(auditSend).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        action: 'auth.policy_denied',
        payload: expect.objectContaining({
          method: 'social',
          action: 'login',
          provider: 'github',
          reason: 'force_sso',
        }),
      }),
    )
  })

  it('provider 缺少 Workers Secret 时 direct authorize 不可用且不保存 state', async () => {
    let stored = false
    const env = {
      ...makeEnv(async (req) => {
        const url = new URL(req.url)
        if (url.pathname === '/store') stored = true
        return new Response(null, { status: 201 })
      }),
      GITHUB_CLIENT_SECRET: undefined,
    } as unknown as Env
    vi.mocked(createTenantDb).mockReturnValue({} as unknown as ReturnType<typeof createTenantDb>)

    const { registerSocialRoutes } = await import('../social')
    const app = new Hono<XidHonoEnv>()
    app.onError(testErrorHandler)
    app.use('*', async (c, next) => {
      c.set('tenant', {
        ...makeTenant(),
        policy: {
          socialProviders: {
            github: {
              authorizationEndpoint: 'https://github.com/login/oauth/authorize',
              tokenEndpoint: 'https://github.com/login/oauth/access_token',
              clientId: 'github-client',
              clientSecretRef: 'GITHUB_CLIENT_SECRET',
              scopes: ['read:user', 'user:email'],
              usesPkce: true,
              redirectUris: ['/account'],
              enabled: true,
              allowLogin: true,
              allowUserCreation: true,
              requireVerifiedEmail: true,
              allowedEmailDomains: [],
            },
          },
        },
      } as unknown as TenantVar)
      c.set('session', null)
      await next()
    })
    registerSocialRoutes(app)

    const res = await app.request(
      '/auth/github/authorize?continue=/account',
      { method: 'GET' },
      env,
    )

    expect(res.status).toBe(400)
    expect(stored).toBe(false)
  })

  it('provider 缺少 Workers Secret 时 callback 不交换 code 且不创建用户', async () => {
    const auditSend = vi.fn()
    const env = {
      ...makeEnv(async (req) => {
        const url = new URL(req.url)
        if (url.pathname === '/consume') {
          return new Response(
            JSON.stringify({
              record: {
                tenantId: 'tenant-1',
                provider: 'github',
                codeVerifier: 'cv',
                nonce: 'nonce',
                redirectAfterLogin: '/account',
                returnToOrigin: 'https://test.xid.dev',
                createdAt: Date.now(),
              },
            }),
            { status: 200 },
          )
        }
        return new Response(null, { status: 201 })
      }, auditSend),
      GITHUB_CLIENT_SECRET: undefined,
    } as unknown as Env
    const db = {
      userIdentities: { findOne: vi.fn().mockResolvedValue(undefined) },
      userEmails: { findOne: vi.fn().mockResolvedValue(undefined) },
      users: { insert: vi.fn() },
    }
    vi.mocked(createTenantDb).mockReturnValue(db as unknown as ReturnType<typeof createTenantDb>)

    const { registerSocialRoutes } = await import('../social')
    const app = new Hono<XidHonoEnv>()
    app.onError(testErrorHandler)
    app.use('*', async (c, next) => {
      c.set('tenant', {
        ...makeTenant(),
        policy: {
          socialProviders: {
            github: {
              authorizationEndpoint: 'https://github.com/login/oauth/authorize',
              tokenEndpoint: 'https://github.com/login/oauth/access_token',
              clientId: 'github-client',
              clientSecretRef: 'GITHUB_CLIENT_SECRET',
              scopes: ['read:user', 'user:email'],
              usesPkce: true,
              redirectUris: ['/account'],
              enabled: true,
              allowLogin: true,
              allowUserCreation: true,
              requireVerifiedEmail: true,
              allowedEmailDomains: [],
            },
          },
        },
      } as unknown as TenantVar)
      c.set('session', null)
      await next()
    })
    registerSocialRoutes(app)

    const res = await app.request(
      '/auth/github/callback?code=authcode&state=valid-state',
      { method: 'GET' },
      env,
    )

    expect(res.status).toBe(400)
    expect(db.users.insert).not.toHaveBeenCalled()
    expect(auditSend).not.toHaveBeenCalled()
  })

  it('provider 禁用时 callback 不交换 code 且不创建用户', async () => {
    vi.mocked(exchangeCode).mockClear()
    const auditSend = vi.fn()
    const env = makeEnv(async (req) => {
      const url = new URL(req.url)
      if (url.pathname === '/consume') {
        return new Response(
          JSON.stringify({
            record: {
              tenantId: 'tenant-1',
              provider: 'github',
              codeVerifier: 'cv',
              nonce: 'nonce',
              redirectAfterLogin: '/account',
              returnToOrigin: 'https://test.xid.dev',
              createdAt: Date.now(),
            },
          }),
          { status: 200 },
        )
      }
      return new Response(null, { status: 201 })
    }, auditSend)
    const db = {
      userIdentities: { findOne: vi.fn().mockResolvedValue(undefined) },
      userEmails: { findOne: vi.fn().mockResolvedValue(undefined) },
      users: { insert: vi.fn() },
    }
    vi.mocked(createTenantDb).mockReturnValue(db as unknown as ReturnType<typeof createTenantDb>)

    const { registerSocialRoutes } = await import('../social')
    const app = new Hono<XidHonoEnv>()
    app.onError(testErrorHandler)
    app.use('*', async (c, next) => {
      c.set('tenant', {
        ...makeTenant(),
        policy: {
          socialProviders: {
            github: {
              authorizationEndpoint: 'https://github.com/login/oauth/authorize',
              tokenEndpoint: 'https://github.com/login/oauth/access_token',
              clientId: 'github-client',
              clientSecretRef: 'GITHUB_CLIENT_SECRET',
              scopes: ['read:user', 'user:email'],
              usesPkce: true,
              redirectUris: ['/account'],
              enabled: false,
              allowLogin: true,
              allowUserCreation: true,
              requireVerifiedEmail: true,
              allowedEmailDomains: [],
            },
          },
        },
      } as unknown as TenantVar)
      c.set('session', null)
      await next()
    })
    registerSocialRoutes(app)

    const res = await app.request(
      '/auth/github/callback?code=authcode&state=valid-state',
      { method: 'GET' },
      env,
    )

    expect(res.status).toBe(400)
    expect(exchangeCode).not.toHaveBeenCalled()
    expect(db.users.insert).not.toHaveBeenCalled()
    expect(auditSend).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        action: 'auth.policy_denied',
        payload: expect.objectContaining({
          method: 'social',
          action: 'login',
          provider: 'github',
          reason: 'provider_not_configured',
        }),
      }),
    )
  })

  it('provider 不允许创建用户时 callback 不自动创建新账号', async () => {
    const auditSend = vi.fn()
    const env = makeEnv(async (req) => {
      const url = new URL(req.url)
      if (url.pathname === '/consume') {
        return new Response(
          JSON.stringify({
            record: {
              tenantId: 'tenant-1',
              provider: 'github',
              codeVerifier: 'cv',
              nonce: 'nonce',
              redirectAfterLogin: '/account',
              returnToOrigin: 'https://test.xid.dev',
              createdAt: Date.now(),
            },
          }),
          { status: 200 },
        )
      }
      return new Response(null, { status: 201 })
    }, auditSend)
    const db = {
      userIdentities: { findOne: vi.fn().mockResolvedValue(undefined) },
      userEmails: { findOne: vi.fn().mockResolvedValue(undefined) },
      users: { insert: vi.fn() },
    }
    vi.mocked(createTenantDb).mockReturnValue(db as unknown as ReturnType<typeof createTenantDb>)

    const { registerSocialRoutes } = await import('../social')
    const app = new Hono<XidHonoEnv>()
    app.onError(testErrorHandler)
    app.use('*', async (c, next) => {
      c.set('tenant', {
        ...makeTenant(),
        policy: {
          socialProviders: {
            github: {
              authorizationEndpoint: 'https://github.com/login/oauth/authorize',
              tokenEndpoint: 'https://github.com/login/oauth/access_token',
              clientId: 'github-client',
              clientSecretRef: 'GITHUB_CLIENT_SECRET',
              scopes: ['read:user', 'user:email'],
              usesPkce: true,
              redirectUris: ['/account'],
              enabled: true,
              allowLogin: true,
              allowUserCreation: false,
              requireVerifiedEmail: true,
              allowedEmailDomains: [],
            },
          },
        },
      } as unknown as TenantVar)
      c.set('session', null)
      await next()
    })
    registerSocialRoutes(app)

    const res = await app.request(
      '/auth/github/callback?code=authcode&state=valid-state',
      { method: 'GET' },
      env,
    )

    expect(res.status).toBe(401)
    expect(db.users.insert).not.toHaveBeenCalled()
    expect(auditSend).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        action: 'auth.policy_denied',
        payload: expect.objectContaining({
          method: 'social',
          action: 'user_creation',
          provider: 'github',
          reason: 'provider_user_creation_disabled',
          identifierType: 'email',
          emailDomain: 'example.com',
        }),
      }),
    )
    expect(JSON.stringify(auditSend.mock.calls[0])).not.toContain('new@example.com')
  })

  it('provider 要求 verified email 时 callback 不创建未验证邮箱用户', async () => {
    vi.mocked(resolveProfile).mockResolvedValueOnce({
      idpUserId: 'github-123',
      email: 'new@example.com',
      emailVerified: false,
      name: 'New User',
      profileRaw: {},
    })
    const auditSend = vi.fn()
    const env = githubCallbackEnv(auditSend)
    const db = {
      userIdentities: { findOne: vi.fn().mockResolvedValue(undefined) },
      userEmails: { findOne: vi.fn().mockResolvedValue(undefined) },
      users: { insert: vi.fn() },
    }
    vi.mocked(createTenantDb).mockReturnValue(db as unknown as ReturnType<typeof createTenantDb>)
    const app = await makeGithubPolicyApp({})

    const res = await app.request(
      '/auth/github/callback?code=authcode&state=valid-state',
      { method: 'GET' },
      env,
    )

    expect(res.status).toBe(401)
    expect(db.users.insert).not.toHaveBeenCalled()
    expect(auditSend).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.policy_denied',
        payload: expect.objectContaining({
          method: 'social',
          action: 'user_creation',
          provider: 'github',
          reason: 'provider_email_unverified',
          identifierType: 'email',
          emailDomain: 'example.com',
        }),
      }),
    )
  })

  it('已有邮箱但 provider email 未验证时不暴露账号存在性', async () => {
    vi.mocked(resolveProfile).mockResolvedValueOnce({
      idpUserId: 'github-123',
      email: 'existing@example.com',
      emailVerified: false,
      name: 'Existing User',
      profileRaw: {},
    })
    const auditSend = vi.fn()
    const env = githubCallbackEnv(auditSend)
    const db = {
      userIdentities: { findOne: vi.fn().mockResolvedValue(undefined) },
      userEmails: {
        findOne: vi.fn().mockResolvedValue({ id: 'email-1', userId: 'user-existing' }),
      },
      users: { insert: vi.fn() },
    }
    vi.mocked(createTenantDb).mockReturnValue(db as unknown as ReturnType<typeof createTenantDb>)
    const app = await makeGithubPolicyApp({
      provider: { requireVerifiedEmail: false },
      hostedAuth: { requireVerifiedEmail: false },
    })

    const res = await app.request(
      '/auth/github/callback?code=authcode&state=valid-state',
      { method: 'GET' },
      env,
    )
    const bodyText = await res.text()

    expect(res.status).toBe(401)
    expect(db.users.insert).not.toHaveBeenCalled()
    expect(bodyText).toContain('invalid_credentials')
    expect(bodyText).not.toContain('longMessage')
    expect(bodyText).not.toContain('manual')
    expect(bodyText).not.toContain('linking')
    expect(bodyText).not.toContain('existing@example.com')
    expect(bodyText).not.toContain('not verified')
    expect(auditSend).not.toHaveBeenCalled()
  })

  it.each([
    { verified: false, verificationStatus: 'verified' },
    { verified: true, verificationStatus: 'unverified' },
  ])(
    'provider email 已验证但本地 email 状态为 $verified/$verificationStatus 时拒绝自动绑定',
    async ({ verified, verificationStatus }) => {
      vi.mocked(resolveProfile).mockResolvedValueOnce({
        idpUserId: 'github-123',
        email: 'existing@example.com',
        emailVerified: true,
        name: 'Existing User',
        profileRaw: {},
      })
      const auditSend = vi.fn()
      const env = githubCallbackEnv(auditSend)
      const identityInsert = vi.fn()
      const userUpdate = vi.fn()
      const userInsert = vi.fn()
      const sessionInsert = vi.fn()
      const db = {
        userIdentities: {
          findOne: vi.fn().mockResolvedValue(undefined),
          insert: identityInsert,
        },
        userEmails: {
          findOne: vi.fn().mockResolvedValue({
            id: 'email-1',
            userId: 'user-existing',
            verified,
            verificationStatus,
          }),
        },
        users: {
          findOne: vi.fn(),
          insert: userInsert,
          update: userUpdate,
        },
        sessions: { insert: sessionInsert },
      }
      vi.mocked(createTenantDb).mockReturnValue(db as unknown as ReturnType<typeof createTenantDb>)
      vi.mocked(provisionAccountAtomically).mockClear()
      const app = await makeGithubPolicyApp({})

      const res = await app.request(
        '/auth/github/callback?code=authcode&state=valid-state',
        { method: 'GET' },
        env,
      )

      expect(res.status).toBe(401)
      expect((await res.json())['code']).toBe('invalid_credentials')
      expect(identityInsert).not.toHaveBeenCalled()
      expect(userUpdate).not.toHaveBeenCalled()
      expect(userInsert).not.toHaveBeenCalled()
      expect(sessionInsert).not.toHaveBeenCalled()
      expect(provisionAccountAtomically).not.toHaveBeenCalled()
      expect(auditSend).not.toHaveBeenCalled()
    },
  )

  it('tenant blocked email domain applies to social callback user creation', async () => {
    vi.mocked(resolveProfile).mockResolvedValueOnce({
      idpUserId: 'github-123',
      email: 'new@blocked.example',
      emailVerified: true,
      name: 'New User',
      profileRaw: {},
    })
    const auditSend = vi.fn()
    const env = githubCallbackEnv(auditSend)
    const db = {
      userIdentities: { findOne: vi.fn().mockResolvedValue(undefined) },
      userEmails: { findOne: vi.fn().mockResolvedValue(undefined) },
      users: { insert: vi.fn() },
    }
    vi.mocked(createTenantDb).mockReturnValue(db as unknown as ReturnType<typeof createTenantDb>)
    const app = await makeGithubPolicyApp({
      hostedAuth: {
        blockedEmailDomains: ['blocked.example'],
      },
    })

    const res = await app.request(
      '/auth/github/callback?code=authcode&state=valid-state',
      { method: 'GET' },
      env,
    )

    expect(res.status).toBe(401)
    expect(db.users.insert).not.toHaveBeenCalled()
    expect(auditSend).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.policy_denied',
        payload: expect.objectContaining({
          method: 'social',
          action: 'user_creation',
          provider: 'github',
          reason: 'email_domain_blocked',
          identifierType: 'email',
          emailDomain: 'blocked.example',
        }),
      }),
    )
  })

  it('tenant allowed email domains apply to social callback user creation', async () => {
    vi.mocked(resolveProfile).mockResolvedValueOnce({
      idpUserId: 'github-123',
      email: 'new@outside.example',
      emailVerified: true,
      name: 'New User',
      profileRaw: {},
    })
    const auditSend = vi.fn()
    const env = githubCallbackEnv(auditSend)
    const db = {
      userIdentities: { findOne: vi.fn().mockResolvedValue(undefined) },
      userEmails: { findOne: vi.fn().mockResolvedValue(undefined) },
      users: { insert: vi.fn() },
    }
    vi.mocked(createTenantDb).mockReturnValue(db as unknown as ReturnType<typeof createTenantDb>)
    const app = await makeGithubPolicyApp({
      hostedAuth: {
        allowedEmailDomains: ['example.com'],
      },
    })

    const res = await app.request(
      '/auth/github/callback?code=authcode&state=valid-state',
      { method: 'GET' },
      env,
    )

    expect(res.status).toBe(401)
    expect(db.users.insert).not.toHaveBeenCalled()
    expect(auditSend).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.policy_denied',
        payload: expect.objectContaining({
          method: 'social',
          action: 'user_creation',
          provider: 'github',
          reason: 'email_domain_not_allowed',
          identifierType: 'email',
          emailDomain: 'outside.example',
        }),
      }),
    )
  })

  it('provider allowed email domains apply to social callback user creation', async () => {
    vi.mocked(resolveProfile).mockResolvedValueOnce({
      idpUserId: 'github-123',
      email: 'new@outside.example',
      emailVerified: true,
      name: 'New User',
      profileRaw: {},
    })
    const auditSend = vi.fn()
    const env = githubCallbackEnv(auditSend)
    const db = {
      userIdentities: { findOne: vi.fn().mockResolvedValue(undefined) },
      userEmails: { findOne: vi.fn().mockResolvedValue(undefined) },
      users: { insert: vi.fn() },
    }
    vi.mocked(createTenantDb).mockReturnValue(db as unknown as ReturnType<typeof createTenantDb>)
    const app = await makeGithubPolicyApp({
      provider: {
        allowedEmailDomains: ['example.com'],
      },
    })

    const res = await app.request(
      '/auth/github/callback?code=authcode&state=valid-state',
      { method: 'GET' },
      env,
    )

    expect(res.status).toBe(401)
    expect(db.users.insert).not.toHaveBeenCalled()
    expect(auditSend).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.policy_denied',
        payload: expect.objectContaining({
          method: 'social',
          action: 'user_creation',
          provider: 'github',
          reason: 'provider_email_domain_not_allowed',
          identifierType: 'email',
          emailDomain: 'outside.example',
        }),
      }),
    )
  })
  it('Application sign-up resume creates default tenant membership and preserves authorize state', async () => {
    const membershipsInsert = vi.fn().mockResolvedValue(undefined)
    const auditSend = vi.fn()
    const env = makeEnv(async (req) => {
      const url = new URL(req.url)
      if (url.pathname === '/consume') {
        return new Response(
          JSON.stringify({
            record: {
              tenantId: 'tenant-1',
              provider: 'github',
              codeVerifier: 'cv',
              nonce: 'nonce',
              redirectAfterLogin:
                '/authorize?authz_request_id=authz_1&client_id=application_client',
              returnToOrigin: 'https://test.xid.dev',
              createdAt: Date.now(),
              intent: 'application-sign-up',
              applicationClientId: 'application_client',
              skipDefaultMembership: false,
            },
          }),
          { status: 200 },
        )
      }
      return new Response(null, { status: 201 })
    }, auditSend)
    const db = {
      userIdentities: {
        findOne: vi.fn().mockResolvedValue(undefined),
        insert: vi.fn().mockResolvedValue(undefined),
      },
      userEmails: {
        findOne: vi.fn().mockResolvedValue(undefined),
        insert: vi.fn().mockResolvedValue(undefined),
      },
      users: {
        insert: vi.fn().mockResolvedValue(undefined),
        update: vi.fn().mockResolvedValue(undefined),
        findOne: vi.fn().mockResolvedValue({ id: 'user-new', status: 'active', deletedAt: null }),
      },
      memberships: {
        insert: membershipsInsert,
        findMany: vi.fn().mockResolvedValue([]),
      },
      organizations: {
        findOne: vi.fn().mockResolvedValue(undefined),
        findMany: vi.fn().mockResolvedValue([]),
      },
      sessions: {
        insert: vi.fn().mockImplementation((row: Record<string, unknown>) =>
          Promise.resolve({
            ...row,
            activeOrgId: row['activeOrgId'] ?? null,
            isImpersonation: false,
            impersonatorUserId: null,
          }),
        ),
      },
    }
    vi.mocked(createTenantDb).mockReturnValue(db as unknown as ReturnType<typeof createTenantDb>)
    vi.mocked(resolveTenantContextByApplicationClientId).mockResolvedValueOnce({
      ok: true,
      value: {
        ...makeTenant(),
        policy: {
          hostedAuth: makeHostedAuthPolicy({ requireVerifiedEmail: true }),
          socialProviders: { github: makeGithubPolicy() },
        },
      } as unknown as TenantVar,
    })
    const app = await makeGithubPolicyApp({})

    const res = await app.request(
      '/auth/github/callback?code=authcode&state=valid-state',
      { method: 'GET' },
      env,
    )

    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(
      'https://test.xid.dev/authorize?authz_request_id=authz_1&client_id=application_client',
    )
    expect(provisionAccountAtomically).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        primaryEmail: expect.objectContaining({
          email: 'new@example.com',
          verified: true,
        }),
        socialIdentity: expect.objectContaining({
          provider: 'github',
          providerUserId: 'github-123',
        }),
        defaultMembership: expect.objectContaining({
          id: expect.stringMatching(/^mem_[A-Za-z0-9]{21}$/),
          orgId: 'tenant-1',
        }),
      }),
    )
    expect(db.sessions.insert).toHaveBeenCalledWith(expect.objectContaining({ activeOrgId: null }))
  })
})

describe('POST /auth/apple/callback -- Apple form_post', () => {
  it('state 不存在时返回 400', async () => {
    const env = makeEnv(async (req) => {
      const url = new URL(req.url)
      if (url.pathname === '/consume') {
        return new Response(JSON.stringify({ code: 'invalid_request' }), { status: 404 })
      }
      return new Response(null, { status: 201 })
    })
    vi.mocked(createTenantDb).mockReturnValue({} as unknown as ReturnType<typeof createTenantDb>)

    const app = await makeApp()
    const form = new FormData()
    form.append('code', 'apple-code')
    form.append('state', 'bad-state')
    const res = await app.request('/auth/apple/callback', { method: 'POST', body: form }, env)
    expect(res.status).toBe(400)
  })
})

describe('resolveRedirect -- open redirect 阻断(Fix 4)', () => {
  it('未注册的 redirect 回退到默认(阻断 open redirect)', async () => {
    const { resolveRedirect } = await import('../social')
    const out = resolveRedirect('https://evil.example/steal', { redirectUris: [] }, 'https://app/')
    expect(out).toBe('https://app/')
  })

  it('注册白名单内精确匹配则放行', async () => {
    const { resolveRedirect } = await import('../social')
    const out = resolveRedirect(
      'https://app/dashboard',
      { redirectUris: ['https://app/dashboard'] },
      'https://app/',
    )
    expect(out).toBe('https://app/dashboard')
  })

  it('前缀相同但非精确匹配仍回退(防 open redirect 绕过)', async () => {
    const { resolveRedirect } = await import('../social')
    const out = resolveRedirect(
      'https://app.evil.example/',
      { redirectUris: ['https://app/'] },
      'https://app/',
    )
    expect(out).toBe('https://app/')
  })
})
