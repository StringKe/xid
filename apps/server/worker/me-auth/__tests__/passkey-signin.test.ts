// POST /auth/passkey/challenge + /verify 单测:
// challenge -> { challenge, sessionId };verify happy -> 200 + 签发 session;
// challenge 缺失/无效 -> challenge_invalid;凭证不存在 -> invalid_credentials(枚举防护);
// 跨租户:B 上下文按 credentialId 查不到 A 凭证 -> invalid_credentials 不泄露存在性。

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@xid-kit/i18n', () => ({ renderScopeDescription: (s: string) => s }))

vi.mock('@xid-kit/db', () => ({
  createTenantDb: vi.fn(),
  resolveInstanceLoginCandidates: vi.fn(),
  resolveTenantContextById: vi.fn(),
  schema: {
    passkeyCredentials: { credentialId: 'credentialId', userId: 'userId' },
    users: { id: 'id', status: 'status', deletedAt: 'deletedAt' },
    sessions: { id: 'id' },
    memberships: { userId: 'userId', status: 'status', orgId: 'orgId' },
    organizations: { id: 'id', status: 'status', deletedAt: 'deletedAt' },
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

vi.mock('@xid-kit/webauthn', () => ({ verifyAuthentication: vi.fn() }))

vi.mock('../../lib/mfa-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/mfa-session')>()
  return { ...actual, resolvePostAuthMfaGate: vi.fn().mockResolvedValue({}) }
})

vi.mock('../../auth/passkey-helpers', () => ({
  createChallenge: vi.fn().mockResolvedValue('chal-abc'),
  consumeChallenge: vi.fn(),
  buildStoredCredential: vi.fn().mockReturnValue({}),
  persistSignCount: vi.fn().mockResolvedValue(undefined),
}))

import {
  createTenantDb,
  resolveInstanceLoginCandidates,
  resolveTenantContextById,
} from '@xid-kit/db'
import { verifyAuthentication } from '@xid-kit/webauthn'
import { consumeChallenge, createChallenge } from '../../auth/passkey-helpers'
import { registerSessionAuthRoutes } from '../index'
import { execCtx, makeApp, makeEnv, makeTenant } from './helpers'

const VERIFY_BODY = {
  sessionId: 'handle-1',
  id: 'cred-1',
  rawId: 'cred-1',
  response: {
    clientDataJSON: 'cdj',
    authenticatorData: 'ad',
    signature: 'sig',
    userHandle: null,
  },
  type: 'public-key',
}

function dbWithCred(cred: { userId: string; signCount: number; credentialId: string } | null) {
  return {
    passkeyCredentials: { findOne: vi.fn().mockResolvedValue(cred ?? undefined) },
    users: {
      findOne: vi
        .fn()
        .mockResolvedValue(
          cred ? { id: cred.userId, status: 'active', deletedAt: null } : undefined,
        ),
    },
    memberships: {
      findMany: vi
        .fn()
        .mockResolvedValue(
          cred ? [{ id: 'mem-1', userId: cred.userId, orgId: 'tenant-1', status: 'active' }] : [],
        ),
    },
    organizations: {
      findOne: vi
        .fn()
        .mockResolvedValue(
          cred ? { id: 'tenant-1', status: 'active', deletedAt: null } : undefined,
        ),
      findMany: vi
        .fn()
        .mockResolvedValue(cred ? [{ id: 'tenant-1', status: 'active', deletedAt: null }] : []),
    },
    sessions: {
      insert: vi.fn().mockResolvedValue({
        id: 'sess-1',
        userId: cred?.userId ?? 'user-1',
        activeOrgId: cred ? 'tenant-1' : null,
        authenticatedAt: new Date(),
        expiresAt: new Date(Date.now() + 86400000),
        rememberMe: true,
        isImpersonation: false,
        impersonatorUserId: null,
      }),
    },
  } as unknown as ReturnType<typeof createTenantDb>
}

function makeRootEntryTenant() {
  return {
    ...makeTenant('tenant-root', 'https://xid.dev'),
    issuer: 'https://xid.dev',
    rpId: 'xid.dev',
    resolution: { kind: 'instance_entry', primaryDomain: 'xid.dev', unresolvedRoot: true },
  }
}

function makeResolvedTenant() {
  return {
    ...makeTenant('tenant-resolved', 'https://xid.dev'),
    issuer: 'https://xid.dev',
    rpId: 'tenant-resolved.xid.dev',
    resolution: { kind: 'tenant', primaryDomain: 'xid.dev' },
  }
}

describe('POST /auth/passkey/challenge', () => {
  beforeEach(() => vi.clearAllMocks())

  it('返回 { challenge, sessionId }', async () => {
    const app = makeApp(registerSessionAuthRoutes)
    const res = await app.request('/auth/passkey/challenge', { method: 'POST' }, makeEnv(), execCtx)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { challenge: string; sessionId: string }
    expect(body.challenge).toBe('chal-abc')
    expect(typeof body.sessionId).toBe('string')
    expect(body.sessionId.length).toBeGreaterThan(0)
  })

  it('root entry 未解析 tenant 时拒绝 challenge 并写审计', async () => {
    const auditSend = vi.fn()
    const app = makeApp(registerSessionAuthRoutes, {
      tenant: makeRootEntryTenant() as never,
    })
    const res = await app.request(
      '/auth/passkey/challenge',
      { method: 'POST' },
      makeEnv({ auditSend }),
      execCtx,
    )
    expect(res.status).toBe(400)
    expect(createChallenge).not.toHaveBeenCalled()
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

  it('forceSso 拒绝 challenge 且不创建 WebAuthn challenge', async () => {
    const auditSend = vi.fn()
    const tenant = makeTenant()
    tenant.policy.hostedAuth.forceSso = true
    const app = makeApp(registerSessionAuthRoutes, { tenant: tenant as never })
    const res = await app.request(
      '/auth/passkey/challenge',
      { method: 'POST' },
      makeEnv({ auditSend }),
      execCtx,
    )

    expect(res.status).toBe(401)
    expect(((await res.json()) as { code: string }).code).toBe('invalid_credentials')
    expect(createChallenge).not.toHaveBeenCalled()
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

  it('root entry 带 identifier 时按 resolver 切到最终 tenant 生成 challenge', async () => {
    vi.mocked(resolveInstanceLoginCandidates).mockResolvedValue({
      ok: true,
      value: { status: 'resolved', tenant: makeResolvedTenant(), matchedBy: 'email' },
    } as never)
    const app = makeApp(registerSessionAuthRoutes, {
      tenant: makeRootEntryTenant() as never,
    })
    const res = await app.request(
      '/auth/passkey/challenge',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: 'user@example.com' }),
      },
      makeEnv(),
      execCtx,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(
      expect.objectContaining({ challenge: 'chal-abc', organizationId: 'tenant-resolved' }),
    )
    expect(resolveInstanceLoginCandidates).toHaveBeenCalledWith(
      expect.any(Request),
      expect.anything(),
      [{ kind: 'email', value: 'user@example.com' }],
    )
    expect(createChallenge).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('tenant-resolved'),
    )
  })

  it('root entry 带 organizationId 时按选中 organization 生成 challenge', async () => {
    vi.mocked(resolveTenantContextById).mockResolvedValue({
      ok: true,
      value: { status: 'resolved', tenant: makeResolvedTenant() },
    } as never)
    const app = makeApp(registerSessionAuthRoutes, {
      tenant: makeRootEntryTenant() as never,
    })

    const res = await app.request(
      '/auth/passkey/challenge',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identifier: 'new@example.com',
          organizationId: 'tenant-resolved',
        }),
      },
      makeEnv(),
      execCtx,
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(
      expect.objectContaining({ challenge: 'chal-abc', organizationId: 'tenant-resolved' }),
    )
    expect(resolveTenantContextById).toHaveBeenCalledWith(
      expect.any(Request),
      expect.anything(),
      'tenant-resolved',
    )
    expect(resolveInstanceLoginCandidates).not.toHaveBeenCalled()
    expect(createChallenge).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('tenant-resolved'),
    )
  })
})

function verifyReq(app: ReturnType<typeof makeApp>, env: Env, body: unknown) {
  return app.request(
    '/auth/passkey/verify',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    env,
    execCtx,
  )
}

describe('POST /auth/passkey/verify', () => {
  beforeEach(() => vi.clearAllMocks())

  it('requires Turnstile before consuming the WebAuthn challenge when configured', async () => {
    const app = makeApp(registerSessionAuthRoutes)
    const env = {
      ...makeEnv(),
      TURNSTILE_SITE_KEY: 'site-key',
      TURNSTILE_SECRET: 'secret',
    } as unknown as Env

    const res = await verifyReq(app, env, VERIFY_BODY)

    expect(res.status).toBe(401)
    expect(((await res.json()) as { code: string }).code).toBe('captcha_required')
    expect(consumeChallenge).not.toHaveBeenCalled()
  })

  it('root entry 未解析 tenant 时拒绝 verify 且不消费 challenge', async () => {
    const auditSend = vi.fn()
    const app = makeApp(registerSessionAuthRoutes, {
      tenant: makeRootEntryTenant() as never,
    })
    const res = await verifyReq(app, makeEnv({ auditSend }), VERIFY_BODY)
    expect(res.status).toBe(400)
    expect(consumeChallenge).not.toHaveBeenCalled()
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

  it('forceSso 拒绝 verify 且不消费 challenge 不签发 session', async () => {
    const auditSend = vi.fn()
    const db = dbWithCred({ userId: 'user-1', signCount: 4, credentialId: 'cred-1' })
    vi.mocked(createTenantDb).mockReturnValue(db)
    const tenant = makeTenant()
    tenant.policy.hostedAuth.forceSso = true
    const app = makeApp(registerSessionAuthRoutes, { tenant: tenant as never })
    const res = await verifyReq(app, makeEnv({ auditSend }), VERIFY_BODY)

    expect(res.status).toBe(401)
    expect(((await res.json()) as { code: string }).code).toBe('invalid_credentials')
    expect(consumeChallenge).not.toHaveBeenCalled()
    expect(db.sessions.insert).not.toHaveBeenCalled()
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

  it('root entry verify 按 body organizationId 还原最终 tenant 后验签', async () => {
    vi.mocked(resolveTenantContextById).mockResolvedValue({
      ok: true,
      value: { status: 'resolved', tenant: makeResolvedTenant() },
    } as never)
    vi.mocked(consumeChallenge).mockResolvedValue('chal-abc')
    vi.mocked(verifyAuthentication).mockResolvedValue({
      ok: true,
      value: { signCount: 5, signCountAnomaly: false },
    } as never)
    vi.mocked(createTenantDb).mockReturnValue(
      dbWithCred({ userId: 'user-1', signCount: 4, credentialId: 'cred-1' }),
    )
    const app = makeApp(registerSessionAuthRoutes, {
      tenant: makeRootEntryTenant() as never,
    })
    const res = await verifyReq(app, makeEnv(), {
      ...VERIFY_BODY,
      organizationId: 'tenant-resolved',
    })
    expect(res.status).toBe(200)
    expect(resolveTenantContextById).toHaveBeenCalledWith(
      expect.any(Request),
      expect.anything(),
      'tenant-resolved',
    )
    expect(consumeChallenge).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('tenant-resolved'),
    )
    expect(verifyAuthentication).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedOrigins: expect.arrayContaining(['http://localhost']),
      }),
    )
  })

  it('四验证通过 -> 200 + 签发 session', async () => {
    vi.mocked(consumeChallenge).mockResolvedValue('chal-abc')
    vi.mocked(verifyAuthentication).mockResolvedValue({
      ok: true,
      value: { signCount: 5, signCountAnomaly: false },
    } as never)
    vi.mocked(createTenantDb).mockReturnValue(
      dbWithCred({ userId: 'user-1', signCount: 4, credentialId: 'cred-1' }),
    )
    const app = makeApp(registerSessionAuthRoutes)
    const res = await verifyReq(app, makeEnv(), VERIFY_BODY)
    expect(res.status).toBe(200)
  })

  it('challenge 已消费/不存在 -> challenge_invalid', async () => {
    vi.mocked(consumeChallenge).mockResolvedValue(null)
    vi.mocked(createTenantDb).mockReturnValue(dbWithCred(null))
    const app = makeApp(registerSessionAuthRoutes)
    const res = await verifyReq(app, makeEnv(), VERIFY_BODY)
    expect(((await res.json()) as { code: string }).code).toBe('challenge_invalid')
  })

  it('凭证不存在 -> invalid_credentials(枚举防护)', async () => {
    vi.mocked(consumeChallenge).mockResolvedValue('chal-abc')
    vi.mocked(verifyAuthentication).mockResolvedValue({ ok: false } as never)
    vi.mocked(createTenantDb).mockReturnValue(dbWithCred(null))
    const app = makeApp(registerSessionAuthRoutes)
    const res = await verifyReq(app, makeEnv(), VERIFY_BODY)
    expect(((await res.json()) as { code: string }).code).toBe('invalid_credentials')
  })

  it('malformed assertion bytes -> invalid_credentials', async () => {
    vi.mocked(consumeChallenge).mockResolvedValue('chal-abc')
    vi.mocked(createTenantDb).mockReturnValue(
      dbWithCred({ userId: 'user-1', signCount: 4, credentialId: 'cred-1' }),
    )
    const app = makeApp(registerSessionAuthRoutes)
    const res = await verifyReq(app, makeEnv(), {
      ...VERIFY_BODY,
      response: {
        ...VERIFY_BODY.response,
        clientDataJSON: 'bad-base64url',
      },
    })
    expect(((await res.json()) as { code: string }).code).toBe('invalid_credentials')
    expect(verifyAuthentication).not.toHaveBeenCalled()
  })

  it('限流 -> 429', async () => {
    vi.mocked(createTenantDb).mockReturnValue(dbWithCred(null))
    const app = makeApp(registerSessionAuthRoutes)
    const res = await verifyReq(app, makeEnv({ rateLimitAllowed: false }), VERIFY_BODY)
    expect(res.status).toBe(429)
  })

  it('跨租户:B 上下文查不到 A credentialId -> invalid_credentials 不泄露存在性', async () => {
    vi.mocked(consumeChallenge).mockResolvedValue('chal-abc')
    vi.mocked(verifyAuthentication).mockResolvedValue({ ok: false } as never)
    vi.mocked(createTenantDb).mockReturnValue(dbWithCred(null))
    const app = makeApp(registerSessionAuthRoutes, {
      tenant: { tenantId: 'tenant-B', issuer: 'https://b.xid.dev', rpId: 'b.xid.dev' } as never,
    })
    const res = await verifyReq(app, makeEnv(), VERIFY_BODY)
    expect(((await res.json()) as { code: string }).code).toBe('invalid_credentials')
  })
})
