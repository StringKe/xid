// passkey handler 单元测试。
// 验证:注册选项生成 / 注册验证(四验证通过 + 拒绝路径) / 登录验证(枚举防护)。
// challenge DO 用 stub mock,@xid-kit/webauthn verifyRegistration/verifyAuthentication mock。
// 枚举防护:凭证不存在与验签失败均抛 invalid_credentials。

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@xid-kit/webauthn', () => ({
  verifyRegistration: vi.fn(),
  verifyAuthentication: vi.fn(),
}))

vi.mock('@xid-kit/db', () => ({
  createTenantDb: vi.fn(),
  schema: {
    passkeyCredentials: {
      credentialId: 'credentialId',
      userId: 'userId',
      tenantId: 'tenantId',
      signCount: 'signCount',
      revokedAt: 'revokedAt',
    },
  },
}))

vi.mock('@xid-kit/crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xid-kit/crypto')>()
  return {
    ...actual,
    base64UrlDecode: (s: string) => {
      if (s === 'bad-base64url') throw new Error('bad base64url')
      return new TextEncoder().encode(s)
    },
    base64UrlEncode: (b: Uint8Array) => Buffer.from(b).toString('base64url'),
  }
})

import { verifyRegistration, verifyAuthentication } from '@xid-kit/webauthn'
import { createTenantDb } from '@xid-kit/db'
import { Hono } from 'hono'
import type { TenantVar, XidHonoEnv } from '../../lib/types'
import type { ErrorHandler } from 'hono'
import { isAppError } from '../../lib/errors'
import { PASSKEY_LIMIT, persistNewCredential, persistSignCount } from '../passkey-helpers'

// 测试内联 errorHandler:把 AppError 映射为对应 HTTP status + code JSON,绕过 @xid-kit/i18n 依赖。
const testErrorHandler: ErrorHandler<XidHonoEnv> = (err, c) => {
  if (isAppError(err)) {
    return c.json(
      { code: err.code, message: err.code },
      err.httpStatus as Parameters<typeof c.json>[1],
    )
  }
  return c.json({ code: 'server_error', message: 'server_error' }, 500)
}

function makeTenant() {
  return {
    tenantId: 'tenant-1',
    issuer: 'https://test.xid.dev',
    rpId: 'test.xid.dev',
    signingKeys: { activeKid: 'k1', defaultAlg: 'ES256', keys: [] },
    policy: {
      hostedAuth: {
        identifierMode: 'email',
        requireVerifiedEmail: true,
        allowedEmailDomains: [],
        blockedEmailDomains: [],
        forceSso: false,
        allowUserCreation: true,
        allowExistingUserLogin: true,
        password: { enabled: false, allowLogin: false, allowUserCreation: false },
        magicLink: { enabled: false, allowLogin: false, allowUserCreation: false },
        emailOtp: { enabled: false, allowLogin: false, allowUserCreation: false },
        smsOtp: { enabled: false, allowLogin: false, allowUserCreation: false },
        passkey: { enabled: true, allowLogin: true, allowUserCreation: false },
        enterpriseSso: {
          enabled: false,
          allowLogin: false,
          allowJitUserCreation: false,
          domainDiscovery: false,
        },
      },
    },
  }
}

function makeRootEntryTenant() {
  return {
    ...makeTenant(),
    tenantId: 'tenant-root',
    issuer: 'https://xid.dev',
    rpId: 'xid.dev',
    resolution: { kind: 'instance_entry', primaryDomain: 'xid.dev', unresolvedRoot: true },
  }
}

function makeDoNamespace(handler: (req: Request) => Promise<Response>): DurableObjectNamespace {
  return {
    idFromName: (_name: string) => ({ toString: () => 'do-id' }) as DurableObjectId,
    get: () =>
      ({
        fetch: (input: RequestInfo, init?: RequestInit) => {
          const req = typeof input === 'string' ? new Request(input, init) : input
          return handler(req)
        },
      }) as unknown as DurableObjectStub,
  } as unknown as DurableObjectNamespace
}

function makeRateLimiter(allowed = true): DurableObjectNamespace {
  return makeDoNamespace(
    async () => new Response(JSON.stringify({ allowed, retryAfter: allowed ? 0 : 60, count: 1 })),
  )
}

function makeEnv(challengeHandler: (req: Request) => Promise<Response>, rlAllowed = true) {
  return {
    WEBAUTHN_CHALLENGE: makeDoNamespace(challengeHandler),
    DB: {} as D1Database,
    CACHE: {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
    } as unknown as KVNamespace,
    AUDIT_QUEUE: { send: vi.fn() },
    RATE_LIMITER: makeRateLimiter(rlAllowed),
    SESSION_REVOCATION: makeDoNamespace(async () => new Response(JSON.stringify({ active: true }))),
  } as unknown as Env
}

function makeTenantDb(overrides: Record<string, unknown> = {}) {
  return {
    passkeyCredentials: {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      findOne: vi.fn().mockResolvedValue(undefined),
      insert: vi.fn().mockResolvedValue({ id: 'cred-1' }),
      update: vi.fn().mockResolvedValue([]),
    },
    mfaFactors: {
      insert: vi.fn().mockResolvedValue({ id: 'mf_1' }),
    },
    sessions: {
      insert: vi.fn().mockResolvedValue({
        id: 'sess-1',
        userId: 'user-1',
        activeOrgId: null,
        authenticatedAt: new Date(),
        expiresAt: new Date(Date.now() + 86400000),
        rememberMe: true,
        isImpersonation: false,
        impersonatorUserId: null,
        refreshTokenHash: 'hash',
        status: 'active',
        acr: null,
        amr: null,
        aal: null,
      }),
    },
    ...overrides,
  }
}

async function makeApp(
  sessionUserId: string | null = 'user-1',
  tenant: TenantVar = makeTenant() as unknown as TenantVar,
) {
  const { registerPasskeyRoutes } = await import('../passkey')
  const app = new Hono<XidHonoEnv>()
  app.onError(testErrorHandler)
  app.use('*', async (c, next) => {
    c.set('tenant', tenant)
    if (sessionUserId) {
      c.set('session', {
        sessionId: 'sess-prev',
        userId: sessionUserId,
        status: 'active',
        activeOrgId: null,
        authenticatedAt: new Date(),
        expiresAt: new Date(Date.now() + 86400000),
        rememberMe: false,
        isImpersonation: false,
        impersonatorUserId: null,
        acr: null,
        amr: null,
        aal: null,
      })
    } else {
      c.set('session', null)
    }
    await next()
  })
  registerPasskeyRoutes(app)
  return app
}

describe('POST /auth/passkey/register/options', () => {
  beforeEach(() => {
    vi.mocked(createTenantDb).mockReturnValue(
      makeTenantDb() as unknown as ReturnType<typeof createTenantDb>,
    )
  })

  it('returns challenge when session is active', async () => {
    const env = makeEnv(async (req) => {
      const url = new URL(req.url)
      if (url.pathname === '/create') return new Response(null, { status: 201 })
      return new Response('not found', { status: 404 })
    })

    const app = await makeApp()
    const res = await app.request('/auth/passkey/register/options', { method: 'POST' }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(typeof body['challenge']).toBe('string')
    expect(body['rp']).toBeDefined()
    expect(body['authenticatorSelection']).toMatchObject({
      residentKey: 'required',
      userVerification: 'required',
    })
    expect(body['pubKeyCredParams']).toEqual([
      { type: 'public-key', alg: -7 },
      { type: 'public-key', alg: -257 },
      { type: 'public-key', alg: -8 },
    ])
    expect(body['attestation']).toBe('none')
  })

  it('returns 401 when no session', async () => {
    const env = makeEnv(async () => new Response(null, { status: 201 }))
    const app = await makeApp(null)
    const res = await app.request('/auth/passkey/register/options', { method: 'POST' }, env)
    expect(res.status).toBe(401)
  })

  it('root entry 未解析 tenant 时拒绝注册 challenge 并写审计', async () => {
    const auditSend = vi.fn()
    const challengeHandler = vi.fn(async () => new Response(null, { status: 201 }))
    const env = {
      ...makeEnv(challengeHandler),
      AUDIT_QUEUE: { send: auditSend } as unknown as Queue,
    } as unknown as Env
    const app = await makeApp('user-1', makeRootEntryTenant() as unknown as TenantVar)
    const res = await app.request('/auth/passkey/register/options', { method: 'POST' }, env)
    expect(res.status).toBe(400)
    expect(challengeHandler).not.toHaveBeenCalled()
    expect(auditSend).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-root',
        action: 'auth.policy_denied',
        payload: expect.objectContaining({
          method: 'passkey',
          action: 'login',
          reason: 'instance_tenant_unresolved',
        }),
      }),
    )
  })

  it('forceSso 拒绝注册 challenge 且不创建 challenge', async () => {
    const auditSend = vi.fn()
    const challengeHandler = vi.fn(async () => new Response(null, { status: 201 }))
    const env = {
      ...makeEnv(challengeHandler),
      AUDIT_QUEUE: { send: auditSend } as unknown as Queue,
    } as unknown as Env
    const tenant = makeTenant()
    tenant.policy.hostedAuth.forceSso = true
    const app = await makeApp('user-1', tenant as unknown as TenantVar)
    const res = await app.request('/auth/passkey/register/options', { method: 'POST' }, env)

    expect(res.status).toBe(401)
    expect(challengeHandler).not.toHaveBeenCalled()
    expect(auditSend).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        action: 'auth.policy_denied',
        payload: expect.objectContaining({
          method: 'passkey',
          action: 'login',
          reason: 'force_sso',
        }),
      }),
    )
  })

  it('returns 422 when passkey limit reached', async () => {
    const db = makeTenantDb({
      passkeyCredentials: {
        count: vi.fn().mockResolvedValue(PASSKEY_LIMIT),
        findOne: vi.fn(),
        insert: vi.fn(),
        update: vi.fn(),
      },
    })
    vi.mocked(createTenantDb).mockReturnValue(db as unknown as ReturnType<typeof createTenantDb>)
    const env = makeEnv(async () => new Response(null, { status: 201 }))
    const app = await makeApp()
    const res = await app.request('/auth/passkey/register/options', { method: 'POST' }, env)
    expect(res.status).toBe(422)
  })
})

describe('POST /auth/passkey/register/verify', () => {
  beforeEach(() => {
    vi.mocked(createTenantDb).mockReturnValue(
      makeTenantDb() as unknown as ReturnType<typeof createTenantDb>,
    )
  })

  it('returns 200 on successful registration', async () => {
    vi.mocked(verifyRegistration).mockResolvedValue({
      ok: true,
      value: {
        credentialId: new Uint8Array([1, 2, 3]),
        publicKey: new Uint8Array([4, 5, 6]),
        coseAlg: -7,
        aaguid: new Uint8Array(16),
        signCount: 0,
        userVerified: true,
        transports: [],
        credentialDeviceType: 'singleDevice',
        credentialBackedUp: false,
        signCountAnomaly: false,
      },
    })

    const env = makeEnv(async (req) => {
      const url = new URL(req.url)
      if (url.pathname === '/consume') {
        return new Response(JSON.stringify({ value: 'test-challenge' }), { status: 200 })
      }
      return new Response(null, { status: 201 })
    })

    const app = await makeApp()
    const res = await app.request(
      '/auth/passkey/register/verify',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'cred-id',
          rawId: 'Y3JlZC1pZA',
          response: {
            clientDataJSON: 'Y2xpZW50RGF0YQ',
            attestationObject: 'YXR0ZXN0YXRpb25PYmplY3Q',
          },
          transports: ['internal'],
          deviceName: 'My Phone',
        }),
      },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean }
    expect(body.ok).toBe(true)
    expect(verifyRegistration).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedOrigins: expect.arrayContaining(['http://localhost']),
      }),
      expect.objectContaining({ attestationPolicy: 'none' }),
    )
  })

  it('returns 400 when challenge is missing', async () => {
    const env = makeEnv(async (req) => {
      const url = new URL(req.url)
      if (url.pathname === '/consume') {
        return new Response(JSON.stringify({ code: 'challenge_invalid' }), { status: 404 })
      }
      return new Response(null, { status: 201 })
    })

    const app = await makeApp()
    const res = await app.request(
      '/auth/passkey/register/verify',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'cred-id',
          rawId: 'Y3JlZC1pZA',
          response: {
            clientDataJSON: 'Y2xpZW50RGF0YQ',
            attestationObject: 'YXR0ZXN0YXRpb25PYmplY3Q',
          },
        }),
      },
      env,
    )
    expect(res.status).toBe(400)
  })

  it('root entry 未解析 tenant 时拒绝注册 verify 且不消费 challenge', async () => {
    const auditSend = vi.fn()
    const challengeHandler = vi.fn(async () => {
      return new Response(JSON.stringify({ value: 'test-challenge' }), { status: 200 })
    })
    const env = {
      ...makeEnv(challengeHandler),
      AUDIT_QUEUE: { send: auditSend } as unknown as Queue,
    } as unknown as Env

    const app = await makeApp('user-1', makeRootEntryTenant() as unknown as TenantVar)
    const res = await app.request(
      '/auth/passkey/register/verify',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'cred-id',
          rawId: 'Y3JlZC1pZA',
          response: {
            clientDataJSON: 'Y2xpZW50RGF0YQ',
            attestationObject: 'YXR0ZXN0YXRpb25PYmplY3Q',
          },
        }),
      },
      env,
    )

    expect(res.status).toBe(400)
    expect(challengeHandler).not.toHaveBeenCalled()
    expect(auditSend).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-root',
        action: 'auth.policy_denied',
        payload: expect.objectContaining({
          method: 'passkey',
          action: 'login',
          reason: 'instance_tenant_unresolved',
        }),
      }),
    )
  })

  it('forceSso 拒绝注册 verify 且不消费 challenge', async () => {
    vi.mocked(verifyRegistration).mockClear()
    const auditSend = vi.fn()
    const challengeHandler = vi.fn(async () => {
      return new Response(JSON.stringify({ value: 'test-challenge' }), { status: 200 })
    })
    const env = {
      ...makeEnv(challengeHandler),
      AUDIT_QUEUE: { send: auditSend } as unknown as Queue,
    } as unknown as Env
    const tenant = makeTenant()
    tenant.policy.hostedAuth.forceSso = true
    const app = await makeApp('user-1', tenant as unknown as TenantVar)
    const res = await app.request(
      '/auth/passkey/register/verify',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'cred-id',
          rawId: 'Y3JlZC1pZA',
          response: {
            clientDataJSON: 'Y2xpZW50RGF0YQ',
            attestationObject: 'YXR0ZXN0YXRpb25PYmplY3Q',
          },
        }),
      },
      env,
    )

    expect(res.status).toBe(401)
    expect(challengeHandler).not.toHaveBeenCalled()
    expect(verifyRegistration).not.toHaveBeenCalled()
    expect(auditSend).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        action: 'auth.policy_denied',
        payload: expect.objectContaining({
          method: 'passkey',
          action: 'login',
          reason: 'force_sso',
        }),
      }),
    )
  })

  it('returns 401 on verifyRegistration failure', async () => {
    vi.mocked(verifyRegistration).mockResolvedValue({
      ok: false,
      error: { code: 'invalid_credentials', message: 'fail', httpStatus: 401 },
    })

    const env = makeEnv(async (req) => {
      const url = new URL(req.url)
      if (url.pathname === '/consume') {
        return new Response(JSON.stringify({ value: 'test-challenge' }), { status: 200 })
      }
      return new Response(null, { status: 201 })
    })

    const app = await makeApp()
    const res = await app.request(
      '/auth/passkey/register/verify',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'cred-id',
          rawId: 'Y3JlZC1pZA',
          response: {
            clientDataJSON: 'Y2xpZW50RGF0YQ',
            attestationObject: 'YXR0ZXN0YXRpb25PYmplY3Q',
          },
        }),
      },
      env,
    )
    expect(res.status).toBe(401)
  })

  it('malformed register response bytes -> invalid_credentials', async () => {
    vi.mocked(verifyRegistration).mockClear()
    const env = makeEnv(async (req) => {
      const url = new URL(req.url)
      if (url.pathname === '/consume') {
        return new Response(JSON.stringify({ value: 'test-challenge' }), { status: 200 })
      }
      return new Response(null, { status: 201 })
    })

    const app = await makeApp()
    const res = await app.request(
      '/auth/passkey/register/verify',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'cred-id',
          rawId: 'Y3JlZC1pZA',
          response: {
            clientDataJSON: 'bad-base64url',
            attestationObject: 'YXR0ZXN0YXRpb25PYmplY3Q',
          },
        }),
      },
      env,
    )
    expect(res.status).toBe(401)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('invalid_credentials')
    expect(verifyRegistration).not.toHaveBeenCalled()
  })
})

describe('POST /auth/passkey/login/verify -- 枚举防护', () => {
  it('root entry 未解析 tenant 时拒绝登录 options 并写审计', async () => {
    const auditSend = vi.fn()
    const challengeHandler = vi.fn(async () => new Response(null, { status: 201 }))
    const env = {
      ...makeEnv(challengeHandler),
      AUDIT_QUEUE: { send: auditSend } as unknown as Queue,
    } as unknown as Env
    const app = await makeApp(null, makeRootEntryTenant() as unknown as TenantVar)
    const res = await app.request('/auth/passkey/login/options', { method: 'POST' }, env)
    expect(res.status).toBe(400)
    expect(challengeHandler).not.toHaveBeenCalled()
    expect(auditSend).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-root',
        action: 'auth.policy_denied',
        payload: expect.objectContaining({
          method: 'passkey',
          action: 'login',
          reason: 'instance_tenant_unresolved',
        }),
      }),
    )
  })

  it('forceSso 拒绝登录 options 且不创建 challenge', async () => {
    const auditSend = vi.fn()
    const challengeHandler = vi.fn(async () => new Response(null, { status: 201 }))
    const env = {
      ...makeEnv(challengeHandler),
      AUDIT_QUEUE: { send: auditSend } as unknown as Queue,
    } as unknown as Env
    const tenant = makeTenant()
    tenant.policy.hostedAuth.forceSso = true
    const app = await makeApp(null, tenant as unknown as TenantVar)
    const res = await app.request('/auth/passkey/login/options', { method: 'POST' }, env)

    expect(res.status).toBe(401)
    expect(challengeHandler).not.toHaveBeenCalled()
    expect(auditSend).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        action: 'auth.policy_denied',
        payload: expect.objectContaining({
          method: 'passkey',
          action: 'login',
          reason: 'force_sso',
        }),
      }),
    )
  })

  it('凭证不存在与验签失败均返回 401 invalid_credentials', async () => {
    const db = makeTenantDb({
      passkeyCredentials: {
        findMany: vi.fn().mockResolvedValue([]),
        findOne: vi.fn().mockResolvedValue(undefined),
        insert: vi.fn(),
        update: vi.fn(),
      },
    })
    vi.mocked(createTenantDb).mockReturnValue(db as unknown as ReturnType<typeof createTenantDb>)
    vi.mocked(verifyAuthentication).mockResolvedValue({
      ok: false,
      error: { code: 'invalid_credentials', message: 'fail', httpStatus: 401 },
    })

    const env = makeEnv(async (req) => {
      const url = new URL(req.url)
      if (url.pathname === '/consume') {
        return new Response(JSON.stringify({ value: 'test-challenge' }), { status: 200 })
      }
      return new Response(null, { status: 201 })
    })

    const app = await makeApp(null)
    const res = await app.request(
      '/auth/passkey/login/verify',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rawId: 'Y3JlZC1pZA',
          anonKey: 'anon-key-123',
          response: {
            clientDataJSON: 'Y2xpZW50RGF0YQ',
            authenticatorData: 'YXV0aERhdGE',
            signature: 'c2ln',
          },
        }),
      },
      env,
    )
    expect(res.status).toBe(401)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('invalid_credentials')
  })

  it('malformed login assertion bytes -> invalid_credentials', async () => {
    vi.mocked(verifyAuthentication).mockClear()
    const db = makeTenantDb({
      passkeyCredentials: {
        findMany: vi.fn().mockResolvedValue([]),
        findOne: vi.fn().mockResolvedValue({
          credentialId: 'Y3JlZC1pZA',
          userId: 'user-1',
          signCount: 0,
          publicKey: new Uint8Array([1]),
          coseAlg: -7,
          aaguid: new Uint8Array(16),
          transports: [],
          revokedAt: null,
        }),
        insert: vi.fn(),
        update: vi.fn(),
      },
    })
    vi.mocked(createTenantDb).mockReturnValue(db as unknown as ReturnType<typeof createTenantDb>)

    const env = makeEnv(async (req) => {
      const url = new URL(req.url)
      if (url.pathname === '/consume') {
        return new Response(JSON.stringify({ value: 'test-challenge' }), { status: 200 })
      }
      return new Response(null, { status: 201 })
    })

    const app = await makeApp(null)
    const res = await app.request(
      '/auth/passkey/login/verify',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rawId: 'Y3JlZC1pZA',
          anonKey: 'anon-key-123',
          response: {
            clientDataJSON: 'bad-base64url',
            authenticatorData: 'YXV0aERhdGE',
            signature: 'c2ln',
          },
        }),
      },
      env,
    )
    expect(res.status).toBe(401)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('invalid_credentials')
    expect(verifyAuthentication).not.toHaveBeenCalled()
  })
})

describe('persistSignCount concurrent transition', () => {
  it('keeps the highest count when concurrent assertions race', async () => {
    let signCount = 10
    const update = vi.fn(async (values: { signCount: number }) => {
      if (signCount > values.signCount) return []
      signCount = values.signCount
      return [{ id: 'credential-1' }]
    })
    const db = {
      passkeyCredentials: {
        update,
        findOne: vi.fn(async () => ({ signCount })),
      },
    }
    const env = { AUDIT_QUEUE: { send: vi.fn() } } as unknown as Env
    const credential = { userId: 'user-1', credentialId: 'credential-1', signCount: 10 }

    await Promise.all([
      persistSignCount({
        env,
        tenantId: 'tenant-1',
        cred: credential,
        newSignCount: 12,
        signCountAnomaly: false,
        db: db as never,
      }),
      persistSignCount({
        env,
        tenantId: 'tenant-1',
        cred: credential,
        newSignCount: 11,
        signCountAnomaly: false,
        db: db as never,
      }),
    ])

    expect(signCount).toBe(12)
    expect(update).toHaveBeenCalledTimes(2)
  })
})

describe('persistNewCredential concurrent passkey limit', () => {
  it('permits one of three registrations when all observe nine active credentials', async () => {
    let activeCount = PASSKEY_LIMIT - 1
    let observedCount = 0
    let releaseReads: (() => void) | undefined
    const allReadsStarted = new Promise<void>((resolve) => {
      releaseReads = resolve
    })
    const db = {
      passkeyCredentials: {
        findOne: vi.fn().mockResolvedValue(undefined),
        count: vi.fn(async () => {
          observedCount += 1
          if (observedCount === 3) releaseReads?.()
          await allReadsStarted
          return PASSKEY_LIMIT - 1
        }),
        insert: vi.fn(async () => {
          if (activeCount >= PASSKEY_LIMIT) throw new Error('passkey_limit_exceeded')
          activeCount += 1
          return { id: crypto.randomUUID() }
        }),
      },
      mfaFactors: { insert: vi.fn() },
    }
    const verified = {
      publicKey: new Uint8Array([1]),
      coseAlg: -7,
      aaguid: new Uint8Array(16),
      signCount: 0,
      credentialDeviceType: 'singleDevice',
      credentialBackedUp: false,
      attestationFmt: 'none',
    }

    const outcomes = await Promise.allSettled(
      ['credential-a', 'credential-b', 'credential-c'].map((credentialIdBase64) =>
        persistNewCredential({
          db: db as never,
          tenantId: 'tenant-1',
          userId: 'user-1',
          credentialIdBase64,
          verified: verified as never,
          transports: [],
          deviceName: null,
        }),
      ),
    )

    expect(activeCount).toBe(PASSKEY_LIMIT)
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(2)
  })
})
