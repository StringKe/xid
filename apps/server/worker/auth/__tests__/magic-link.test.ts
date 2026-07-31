// magic-link 单元测试:jti 哈希入库(非 token 明文)、旧 token 轮换、枚举防护、
// continue 路径净化、一次性消费防重放。对齐 password-auth 01 章 4 与 anti-abuse rule。

import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { sha256Hex, signJwt, verifyJwt } from '@xid-kit/crypto'
import { createTenantDb } from '@xid-kit/db'
import type { TenantVar, XidHonoEnv } from '../../lib/types'
import { handleMagicLinkVerify, sendMagicLink } from '../magic-link'
import { execCtx, makeEnv, makeTenant, testErrorHandler } from '../../me-auth/__tests__/helpers'
import { resolveTokenTenant } from '../../me-auth/token-tenant'
import { loadActiveSigner } from '../../oidc/shared'
import { createPasswordlessEmailUser } from '../../me-auth/passwordless-users'

const LOGIN_FLOW_CONTEXT = JSON.stringify({
  version: 1,
  intent: null,
  continuePath: '/console',
  applicationClientId: null,
  invitationId: null,
})

vi.mock('@xid-kit/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xid-kit/db')>()
  return { ...actual, createTenantDb: vi.fn() }
})

vi.mock('@xid-kit/crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xid-kit/crypto')>()
  return {
    ...actual,
    signJwt: vi.fn().mockResolvedValue('header.payload.signature'),
    verifyJwt: vi.fn(),
  }
})

vi.mock('../../oidc/shared', () => ({
  buildVerifyKeySet: vi.fn().mockResolvedValue({ keys: [] }),
  loadActiveSigner: vi.fn().mockResolvedValue({ kid: 'k1', alg: 'ES256', privateKey: {} }),
}))

vi.mock('../../me-auth/passwordless-users', () => ({
  createPasswordlessEmailUser: vi.fn().mockResolvedValue('user-new'),
  markPrimaryEmailVerified: vi.fn().mockResolvedValue(undefined),
  shouldSkipDefaultMembership: vi.fn().mockReturnValue(false),
}))

vi.mock('../../me-auth/token-tenant', () => ({
  resolveTokenTenant: vi.fn(),
}))

vi.mock('../../lib/mfa-session', () => ({
  resolvePostAuthMfaGate: vi.fn().mockResolvedValue({}),
}))

vi.mock('../../lib/session', () => ({
  issueSession: vi.fn().mockResolvedValue({
    session: { sessionId: 'sess-1' },
    setCookie: () => {},
  }),
}))

vi.mock('../../lib/verify-rate-limit', () => ({
  enforceVerifyRateLimit: vi.fn().mockResolvedValue(undefined),
}))

function magicLinkDb(overrides: Record<string, unknown> = {}) {
  const hardDelete = vi.fn().mockResolvedValue(undefined)
  const insert = vi.fn().mockResolvedValue(undefined)
  return {
    userEmails: {
      findOne: vi.fn().mockResolvedValue({ userId: 'user-existing' }),
      update: vi.fn().mockResolvedValue([]),
    },
    verificationTokens: { hardDelete, insert, findOne: vi.fn(), update: vi.fn() },
    users: { findOne: vi.fn().mockResolvedValue({ id: 'user-existing', primaryEmailId: null }) },
    sessions: { update: vi.fn().mockResolvedValue([]) },
    organizations: { findOne: vi.fn() },
    memberships: { findMany: vi.fn().mockResolvedValue([]) },
    ...overrides,
  } as unknown as ReturnType<typeof createTenantDb>
}

function sendContext(tenant: TenantVar): Hono<XidHonoEnv> {
  const app = new Hono<XidHonoEnv>()
  app.onError(testErrorHandler)
  app.use('*', async (c, next) => {
    c.set('tenant', tenant)
    await next()
  })
  app.post('/send', async (c) => {
    await sendMagicLink(c, 'user@example.com')
    return c.json({ ok: true })
  })
  return app
}

async function postSend(app: Hono<XidHonoEnv>, env: Env): Promise<Response> {
  return app.request('https://tenant-1.xid.dev/send', { method: 'POST' }, env, execCtx)
}

describe('sendMagicLink', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(createTenantDb).mockReturnValue(magicLinkDb())
  })

  it('stores jti SHA-256 hash and queues email for existing user login', async () => {
    const emailSend = vi.fn()
    const env = makeEnv({ emailSend })
    const tenant = makeTenant() as unknown as TenantVar
    const app = sendContext(tenant)

    const res = await postSend(app, env)
    expect(res.status).toBe(200)
    expect(loadActiveSigner).toHaveBeenCalledWith(tenant, env.KEK)

    const signCall = vi.mocked(signJwt).mock.calls[0]?.[0] as { payload: { jti: string } }
    const jti = signCall.payload.jti
    expect(jti).toBeTruthy()

    const db = vi.mocked(createTenantDb).mock.results[0]?.value as ReturnType<typeof magicLinkDb>
    expect(db.verificationTokens.update).toHaveBeenCalledWith(
      expect.objectContaining({ consumedAt: expect.any(Date) }),
      expect.anything(),
    )
    expect(db.verificationTokens.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-existing',
        purpose: 'magic_link',
        tokenHash: await sha256Hex(jti),
      }),
    )
    expect(emailSend).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'magic_link',
        recipient: 'user@example.com',
        payload: expect.objectContaining({
          token: 'header.payload.signature',
          link: expect.stringContaining('/auth/magic-link/verify?token='),
        }),
      }),
    )
    const queued = emailSend.mock.calls[0]?.[0] as { payload: { link: string } }
    expect(queued.payload.link).toContain('token=header.payload.signature')
  })

  it('uses one combined rate-limit reservation for magic-link delivery', async () => {
    const requests: Request[] = []
    const env = makeEnv({ emailSend: vi.fn() })
    env.RATE_LIMITER = {
      idFromName: vi.fn(() => ({ toString: () => 'rl-id' }) as DurableObjectId),
      get: vi.fn(() => ({
        fetch: async (input: RequestInfo, init?: RequestInit) => {
          const request = typeof input === 'string' ? new Request(input, init) : input
          requests.push(request)
          return new Response(JSON.stringify({ allowed: true, retryAfter: 0, counts: [1, 1] }))
        },
      })),
    } as unknown as DurableObjectNamespace
    const app = sendContext(makeTenant() as unknown as TenantVar)

    const res = await postSend(app, env)

    expect(res.status).toBe(200)
    expect(requests).toHaveLength(1)
    expect(new URL(requests[0]?.url ?? '').pathname).toBe('/reserve')
    await expect(requests[0]?.json()).resolves.toMatchObject({
      windows: [
        { key: 'ml:min:tenant-1:user@example.com' },
        { key: 'ml:hour:tenant-1:user@example.com' },
      ],
    })
  })

  it('concurrent resend leaves one active magic-link credential', async () => {
    let activeTokenHash: string | null = 'old'
    const update = vi.fn(async () => {
      activeTokenHash = null
      return []
    })
    const insert = vi.fn(async (values: { tokenHash: string }) => {
      if (activeTokenHash !== null) throw new Error('UNIQUE constraint failed')
      activeTokenHash = values.tokenHash
      return { id: values.tokenHash }
    })
    vi.mocked(createTenantDb).mockReturnValue(
      magicLinkDb({ verificationTokens: { update, insert, findOne: vi.fn() } }),
    )
    const emailSend = vi.fn()
    const env = makeEnv({ emailSend })
    const app = sendContext(makeTenant() as unknown as TenantVar)

    const responses = await Promise.all([postSend(app, env), postSend(app, env)])

    expect(responses.map((response) => response.status)).toEqual([200, 200])
    expect(activeTokenHash).toBeTruthy()
    expect(emailSend).toHaveBeenCalledTimes(2)
  })

  it('enumeration-safe: disabled magic link returns without queueing email', async () => {
    const emailSend = vi.fn()
    const auditSend = vi.fn()
    const env = makeEnv({ emailSend, auditSend })
    const tenant = makeTenant() as unknown as TenantVar
    tenant.policy.hostedAuth.magicLink = {
      enabled: false,
      allowLogin: true,
      allowUserCreation: true,
    }
    const app = sendContext(tenant)

    const res = await postSend(app, env)
    expect(res.status).toBe(200)
    expect(emailSend).not.toHaveBeenCalled()
    expect(auditSend).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.policy_denied',
        payload: expect.objectContaining({ method: 'magicLink', reason: 'method_disabled' }),
      }),
    )
  })

  it('creates passwordless user when email is unknown and user_creation allowed', async () => {
    vi.mocked(createTenantDb).mockReturnValue(
      magicLinkDb({
        userEmails: { findOne: vi.fn().mockResolvedValue(null) },
      }),
    )
    const tenant = makeTenant() as unknown as TenantVar
    tenant.policy.hostedAuth.magicLink = {
      enabled: true,
      allowLogin: true,
      allowUserCreation: true,
    }
    const emailSend = vi.fn()
    const env = makeEnv({ emailSend })
    const app = sendContext(tenant)

    await postSend(app, env)
    expect(createPasswordlessEmailUser).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'user@example.com', tenantId: 'tenant-1' }),
    )
    expect(emailSend).toHaveBeenCalled()
  })
})

describe('handleMagicLinkVerify', () => {
  const verifyJti = 'jti-verify-1'

  beforeEach(async () => {
    vi.clearAllMocks()
    const tokenHash = await sha256Hex(verifyJti)
    vi.mocked(resolveTokenTenant).mockImplementation(
      async (_c, _token) => makeTenant() as TenantVar,
    )
    vi.mocked(createTenantDb).mockReturnValue(
      magicLinkDb({
        verificationTokens: {
          findOne: vi.fn().mockResolvedValue({
            tokenHash,
            userId: 'user-1',
            purpose: 'magic_link',
            flowContext: LOGIN_FLOW_CONTEXT,
            consumedAt: null,
            expiresAt: new Date(Date.now() + 600_000),
          }),
          update: vi.fn().mockResolvedValue([]),
          hardDelete: vi.fn(),
          insert: vi.fn(),
        },
        memberships: {
          findMany: vi
            .fn()
            .mockResolvedValue([{ orgId: 'tenant-1', userId: 'user-1', status: 'active' }]),
        },
      }),
    )
    vi.mocked(verifyJwt).mockResolvedValue({
      ok: true,
      value: {
        header: {},
        payload: {
          sub: 'user-1',
          jti: verifyJti,
          purpose: 'magic_link',
          action: 'login',
          flow_context: LOGIN_FLOW_CONTEXT,
        },
      },
    } as never)
  })

  function verifyApp(tenant: TenantVar): Hono<XidHonoEnv> {
    const app = new Hono<XidHonoEnv>()
    app.onError(testErrorHandler)
    app.use('*', async (c, next) => {
      c.set('tenant', tenant)
      await next()
    })
    app.get('/auth/magic-link/verify', handleMagicLinkVerify)
    return app
  }

  it('rejects replay when verification token already consumed', async () => {
    const tokenHash = await sha256Hex(verifyJti)
    vi.mocked(createTenantDb).mockReturnValue(
      magicLinkDb({
        verificationTokens: {
          findOne: vi.fn().mockResolvedValue({
            tokenHash,
            userId: 'user-1',
            purpose: 'magic_link',
            flowContext: LOGIN_FLOW_CONTEXT,
            consumedAt: new Date(),
            expiresAt: new Date(Date.now() + 600_000),
          }),
          update: vi.fn(),
          hardDelete: vi.fn(),
          insert: vi.fn(),
        },
      }),
    )
    const tenant = makeTenant('tenant-1', 'https://tenant-1.xid.dev') as unknown as TenantVar
    const app = verifyApp(tenant)
    const res = await app.request(
      'https://tenant-1.xid.dev/auth/magic-link/verify?token=valid.jwt.sig',
      {},
      makeEnv(),
      execCtx,
    )
    expect(res.status).toBe(400)
    expect(((await res.json()) as { code: string }).code).toBe('magic_link_invalid')
  })

  it('ignores a rewritten continue query and follows the signed server flow', async () => {
    const tenant = makeTenant('tenant-1', 'https://tenant-1.xid.dev') as unknown as TenantVar
    const app = verifyApp(tenant)
    const res = await app.request(
      'https://tenant-1.xid.dev/auth/magic-link/verify?token=valid.jwt.sig&continue=//evil.test/phish',
      {},
      makeEnv(),
      execCtx,
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe('/console')
    expect(res.headers.get('Cache-Control')).toBe('no-store')
  })

  it('rejects JWT with non-magic_link purpose', async () => {
    vi.mocked(verifyJwt).mockResolvedValue({
      ok: true,
      value: {
        header: {},
        payload: { sub: 'user-1', jti: 'jti-1', purpose: 'email_verify', action: 'login' },
      },
    } as never)
    const tenant = makeTenant('tenant-1', 'https://tenant-1.xid.dev') as unknown as TenantVar
    const app = verifyApp(tenant)
    const res = await app.request(
      'https://tenant-1.xid.dev/auth/magic-link/verify?token=valid.jwt.sig',
      {},
      makeEnv(),
      execCtx,
    )
    expect(((await res.json()) as { code: string }).code).toBe('magic_link_invalid')
  })
})
