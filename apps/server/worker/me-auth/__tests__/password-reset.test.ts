// POST /auth/forgot-password + /auth/reset-password 单测:
// forgot:email 不存在 -> 200(枚举防护)/ 限流 -> rate_limited(429)/ email 存在 -> 200 + 发邮件。
// reset:token 过期 -> token_expired / token 无效 -> token_invalid / HIBP -> password_breached /
//   happy -> 200 + 签发 session / 跨租户 token 消费按 userId 校验。

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@xid-kit/i18n', () => ({ renderScopeDescription: (s: string) => s }))

vi.mock('@xid-kit/crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xid-kit/crypto')>()
  return { ...actual, sha256Hex: vi.fn().mockResolvedValue('hash-of-token') }
})

vi.mock('@xid-kit/db', () => ({
  createTenantDb: vi.fn(),
  resolveInstanceLogin: vi.fn(),
  resolveTenantContextById: vi.fn(),
  resolveTenantContextByIssuer: vi.fn(),
  schema: {
    userEmails: { email: 'email', userId: 'userId' },
    users: { id: 'id', status: 'status', deletedAt: 'deletedAt' },
    passwordResetTokens: { userId: 'userId', purpose: 'purpose', tokenHash: 'tokenHash' },
    passwords: { userId: 'userId' },
    passwordHistory: { userId: 'userId' },
    sessions: { id: 'id' },
    memberships: { userId: 'userId', status: 'status', orgId: 'orgId' },
    organizations: { id: 'id', status: 'status', deletedAt: 'deletedAt' },
  },
}))

vi.mock('../../lib/mfa-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/mfa-session')>()
  return { ...actual, resolvePostAuthMfaGate: vi.fn().mockResolvedValue({}) }
})

vi.mock('../../auth/password', () => ({
  createResetToken: vi.fn().mockResolvedValue({
    token: 'reset.token.sig',
    tokenHash: 'hash-of-token',
    expiresAt: new Date(Date.now() + 900000),
    jti: 'jti-1',
  }),
  verifyResetToken: vi.fn(),
  validatePasswordLength: vi.fn().mockReturnValue({ ok: true, value: true }),
  checkHibpBreached: vi.fn().mockResolvedValue(false),
  isPasswordReused: vi.fn().mockResolvedValue(false),
  passwordReuseTag: vi.fn().mockResolvedValue('pwd-reuse:v1:test'),
  hashPassword: vi
    .fn()
    .mockResolvedValue({ hash: '$argon2id$h', algo: 'argon2id', pepperVersion: 1 }),
}))

vi.mock('../../oidc/shared', () => ({
  buildVerifyKeySet: vi.fn().mockResolvedValue({ keys: [] }),
  loadActiveSigner: vi.fn().mockResolvedValue({ kid: 'k1', alg: 'ES256', privateKey: {} }),
}))

import {
  createTenantDb,
  resolveInstanceLogin,
  resolveTenantContextById,
  resolveTenantContextByIssuer,
} from '@xid-kit/db'
import {
  checkHibpBreached,
  createResetToken,
  isPasswordReused,
  validatePasswordLength,
  verifyResetToken,
} from '../../auth/password'
import { buildVerifyKeySet, loadActiveSigner } from '../../oidc/shared'
import { registerSessionAuthRoutes } from '../index'
import { execCtx, makeApp, makeEnv, makeTenant } from './helpers'

function post(app: ReturnType<typeof makeApp>, env: Env, path: string, body: unknown) {
  return app.request(
    path,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    env,
    execCtx,
  )
}

function unsignedResetTokenPayload(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `header.${body}.signature`
}

describe('POST /auth/forgot-password', () => {
  beforeEach(() => vi.clearAllMocks())

  it('email 不存在 -> 200(枚举防护)', async () => {
    vi.mocked(createTenantDb).mockReturnValue({
      userEmails: { findOne: vi.fn().mockResolvedValue(undefined) },
      passwordResetTokens: { hardDelete: vi.fn(), insert: vi.fn() },
    } as unknown as ReturnType<typeof createTenantDb>)
    const app = makeApp(registerSessionAuthRoutes)
    const res = await post(app, makeEnv(), '/auth/forgot-password', { email: 'nobody@example.com' })
    expect(res.status).toBe(200)
  })

  it('限流 -> 429 rate_limited', async () => {
    vi.mocked(createTenantDb).mockReturnValue({
      userEmails: { findOne: vi.fn() },
      passwordResetTokens: { hardDelete: vi.fn(), insert: vi.fn() },
    } as unknown as ReturnType<typeof createTenantDb>)
    const app = makeApp(registerSessionAuthRoutes)
    const res = await post(app, makeEnv({ rateLimitAllowed: false }), '/auth/forgot-password', {
      email: 'user@example.com',
    })
    expect(res.status).toBe(429)
  })

  it('配置 TURNSTILE_SECRET 但缺 turnstileToken -> 401 captcha_required(不签发重置 token)', async () => {
    const app = makeApp(registerSessionAuthRoutes)
    const env = { ...makeEnv(), TURNSTILE_SECRET: 'turnstile-secret' } as unknown as Env
    const res = await post(app, env, '/auth/forgot-password', { email: 'user@example.com' })
    expect(res.status).toBe(401)
    expect(((await res.json()) as { code: string }).code).toBe('captcha_required')
    expect(createResetToken).not.toHaveBeenCalled()
  })

  it('email 存在 -> 200 + 发 password_reset 邮件', async () => {
    const emailSend = vi.fn()
    const auditSend = vi.fn()
    vi.mocked(createTenantDb).mockReturnValue({
      userEmails: { findOne: vi.fn().mockResolvedValue({ userId: 'user-1' }) },
      passwordResetTokens: {
        hardDelete: vi.fn().mockResolvedValue(undefined),
        insert: vi.fn().mockResolvedValue({ id: 't-1' }),
      },
    } as unknown as ReturnType<typeof createTenantDb>)
    const app = makeApp(registerSessionAuthRoutes)
    const res = await post(app, makeEnv({ emailSend, auditSend }), '/auth/forgot-password', {
      email: 'user@example.com',
    })
    expect(res.status).toBe(200)
    expect(loadActiveSigner).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-1' }),
      expect.any(String),
    )
    expect(createResetToken).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ kid: 'k1' }),
      {
        issuer: 'https://tenant-1.xid.dev',
        tenantId: 'tenant-1',
      },
    )
    expect(auditSend).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.token_issued',
        tenantId: 'tenant-1',
        payload: expect.objectContaining({
          purpose: 'password_reset',
          issuer: 'https://tenant-1.xid.dev',
          kid: 'k1',
        }),
      }),
    )
    const auditPayload = JSON.stringify(auditSend.mock.calls[0]?.[0]?.payload)
    expect(auditPayload).not.toContain('reset.token.sig')
    expect(auditPayload).not.toContain('jti-1')
    expect(auditPayload).not.toContain('https://tenant-1.xid.dev/reset-password')
    expect(emailSend).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'password_reset',
        payload: expect.objectContaining({
          link: expect.stringContaining('/reset-password?token='),
        }),
      }),
    )
  })

  it('root Hosted UI 请求使用 hostedAuthOrigin 生成 reset 链接', async () => {
    const emailSend = vi.fn()
    vi.mocked(createTenantDb).mockReturnValue({
      userEmails: { findOne: vi.fn().mockResolvedValue({ userId: 'user-1' }) },
      passwordResetTokens: {
        hardDelete: vi.fn().mockResolvedValue(undefined),
        insert: vi.fn().mockResolvedValue({ id: 't-1' }),
      },
    } as unknown as ReturnType<typeof createTenantDb>)
    const app = makeApp(registerSessionAuthRoutes, {
      tenant: {
        ...makeTenant('default', 'https://xid.dev'),
        issuer: 'https://xid.dev',
      } as never,
    })
    const res = await post(app, makeEnv({ emailSend }), 'https://xid.dev/auth/forgot-password', {
      email: 'user@example.com',
    })
    expect(res.status).toBe(200)
    expect(createResetToken).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ kid: 'k1' }),
      {
        issuer: 'https://xid.dev',
        tenantId: 'default',
      },
    )
    expect(emailSend).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'password_reset',
        payload: expect.objectContaining({
          link: 'https://xid.dev/reset-password?token=reset.token.sig',
        }),
      }),
    )
  })

  it('root Hosted UI forgot-password 先按 email resolver 切到 default organization', async () => {
    const emailSend = vi.fn()
    const auditSend = vi.fn()
    const defaultTenant = {
      ...makeTenant('default', 'https://xid.dev'),
      issuer: 'https://xid.dev',
    }
    vi.mocked(resolveInstanceLogin).mockResolvedValue({
      ok: true,
      value: { status: 'ready', tenant: defaultTenant },
    } as never)
    vi.mocked(createTenantDb).mockReturnValue({
      userEmails: { findOne: vi.fn().mockResolvedValue({ userId: 'admin-user' }) },
      passwordResetTokens: {
        hardDelete: vi.fn().mockResolvedValue(undefined),
        insert: vi.fn().mockResolvedValue({ id: 't-1' }),
      },
    } as unknown as ReturnType<typeof createTenantDb>)
    const app = makeApp(registerSessionAuthRoutes, {
      tenant: {
        ...makeTenant('root', 'https://xid.dev'),
        issuer: 'https://xid.dev',
        resolution: { unresolvedRoot: true },
      } as never,
    })
    const res = await post(
      app,
      makeEnv({ emailSend, auditSend }),
      'https://xid.dev/auth/forgot-password',
      {
        email: 'admin@example.test',
      },
    )
    expect(res.status).toBe(200)
    expect(resolveInstanceLogin).toHaveBeenCalledWith(expect.any(Request), expect.anything(), {
      kind: 'email',
      value: 'admin@example.test',
    })
    expect(createResetToken).toHaveBeenCalledWith(
      'admin-user',
      expect.objectContaining({ kid: 'k1' }),
      {
        issuer: 'https://xid.dev',
        tenantId: 'default',
      },
    )
    expect(auditSend).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.token_issued',
        tenantId: 'default',
        payload: expect.objectContaining({
          purpose: 'password_reset',
          issuer: 'https://xid.dev',
          kid: 'k1',
        }),
      }),
    )
    expect(emailSend).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'password_reset',
        payload: expect.objectContaining({
          link: 'https://xid.dev/reset-password?token=reset.token.sig',
        }),
      }),
    )
  })

  it('root Hosted UI forgot-password 带 organizationId 时按选中 organization 签发 reset token', async () => {
    const emailSend = vi.fn()
    const auditSend = vi.fn()
    const selectedTenant = {
      ...makeTenant('selected', 'https://xid.dev'),
      tenantId: 'org-selected',
      issuer: 'https://xid.dev',
    }
    vi.mocked(resolveTenantContextById).mockResolvedValue({
      ok: true,
      value: { status: 'resolved', tenant: selectedTenant },
    } as never)
    vi.mocked(createTenantDb).mockReturnValue({
      userEmails: { findOne: vi.fn().mockResolvedValue({ userId: 'selected-user' }) },
      passwordResetTokens: {
        hardDelete: vi.fn().mockResolvedValue(undefined),
        insert: vi.fn().mockResolvedValue({ id: 't-1' }),
      },
    } as unknown as ReturnType<typeof createTenantDb>)
    const app = makeApp(registerSessionAuthRoutes, {
      tenant: {
        ...makeTenant('root', 'https://xid.dev'),
        issuer: 'https://xid.dev',
        resolution: { unresolvedRoot: true },
      } as never,
    })
    const res = await post(
      app,
      makeEnv({ emailSend, auditSend }),
      'https://xid.dev/auth/forgot-password',
      {
        email: 'user@example.com',
        organizationId: 'org-selected',
      },
    )
    expect(res.status).toBe(200)
    expect(resolveTenantContextById).toHaveBeenCalledWith(
      expect.any(Request),
      expect.anything(),
      'org-selected',
    )
    expect(resolveInstanceLogin).not.toHaveBeenCalled()
    expect(createResetToken).toHaveBeenCalledWith(
      'selected-user',
      expect.objectContaining({ kid: 'k1' }),
      {
        issuer: 'https://xid.dev',
        tenantId: 'org-selected',
      },
    )
    expect(auditSend).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.token_issued',
        tenantId: 'org-selected',
        payload: expect.objectContaining({
          purpose: 'password_reset',
          issuer: 'https://xid.dev',
          kid: 'k1',
        }),
      }),
    )
    expect(emailSend).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'password_reset',
        payload: expect.objectContaining({
          tenantId: 'org-selected',
          link: 'https://xid.dev/reset-password?token=reset.token.sig',
        }),
      }),
    )
  })

  it('password disabled -> 200 枚举防护 + 策略拒绝审计 + 不签发 reset token', async () => {
    const emailSend = vi.fn()
    const auditSend = vi.fn()
    vi.mocked(createTenantDb).mockReturnValue({
      userEmails: { findOne: vi.fn().mockResolvedValue({ userId: 'user-1' }) },
      passwordResetTokens: {
        hardDelete: vi.fn().mockResolvedValue(undefined),
        insert: vi.fn().mockResolvedValue({ id: 't-1' }),
      },
    } as unknown as ReturnType<typeof createTenantDb>)
    const tenant = makeTenant()
    tenant.policy.hostedAuth.password = {
      enabled: false,
      allowLogin: false,
      allowUserCreation: false,
      requireEmailVerification: true,
    }
    const app = makeApp(registerSessionAuthRoutes, { tenant: tenant as never })
    const res = await post(app, makeEnv({ emailSend, auditSend }), '/auth/forgot-password', {
      email: 'user@example.com',
    })
    expect(res.status).toBe(200)
    expect(createResetToken).not.toHaveBeenCalled()
    expect(emailSend).not.toHaveBeenCalled()
    expect(auditSend).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.policy_denied',
        tenantId: 'tenant-1',
        payload: expect.objectContaining({
          method: 'password',
          action: 'login',
          reason: 'method_disabled',
          identifierType: 'email',
          emailDomain: 'example.com',
          path: '/auth/forgot-password',
        }),
      }),
    )
  })

  it('forceSso -> 200 枚举防护 + 策略拒绝审计 + 不签发 reset token', async () => {
    const emailSend = vi.fn()
    const auditSend = vi.fn()
    vi.mocked(createTenantDb).mockReturnValue({
      userEmails: { findOne: vi.fn().mockResolvedValue({ userId: 'user-1' }) },
      passwordResetTokens: {
        hardDelete: vi.fn().mockResolvedValue(undefined),
        insert: vi.fn().mockResolvedValue({ id: 't-1' }),
      },
    } as unknown as ReturnType<typeof createTenantDb>)
    const tenant = makeTenant()
    tenant.policy.hostedAuth.forceSso = true
    const app = makeApp(registerSessionAuthRoutes, { tenant: tenant as never })
    const res = await post(app, makeEnv({ emailSend, auditSend }), '/auth/forgot-password', {
      email: 'user@example.com',
    })
    expect(res.status).toBe(200)
    expect(createResetToken).not.toHaveBeenCalled()
    expect(emailSend).not.toHaveBeenCalled()
    expect(auditSend).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.policy_denied',
        tenantId: 'tenant-1',
        payload: expect.objectContaining({
          method: 'password',
          action: 'login',
          reason: 'force_sso',
          identifierType: 'email',
          emailDomain: 'example.com',
          path: '/auth/forgot-password',
        }),
      }),
    )
  })
})

function resetDb(tokenRow: { userId: string; consumedAt: Date | null; expiresAt: Date } | null) {
  return {
    passwordResetTokens: {
      findOne: vi.fn().mockResolvedValue(tokenRow ?? undefined),
      update: vi.fn().mockResolvedValue([]),
    },
    users: {
      findOne: vi.fn().mockResolvedValue({ id: 'user-1', status: 'active', deletedAt: null }),
    },
    passwords: {
      findOne: vi.fn().mockResolvedValue({ hash: '$argon2id$old' }),
      update: vi.fn().mockResolvedValue([]),
      insert: vi.fn().mockResolvedValue({ id: 'pw-1' }),
    },
    passwordHistory: { insert: vi.fn().mockResolvedValue({ id: 'h-1' }) },
    memberships: {
      findMany: vi
        .fn()
        .mockResolvedValue([
          { id: 'mem-1', userId: 'user-1', orgId: 'tenant-1', status: 'active' },
        ]),
    },
    organizations: {
      findOne: vi.fn().mockResolvedValue({ id: 'tenant-1', status: 'active', deletedAt: null }),
      findMany: vi.fn().mockResolvedValue([{ id: 'tenant-1', status: 'active', deletedAt: null }]),
    },
    sessions: {
      insert: vi.fn().mockResolvedValue({
        id: 'sess-1',
        userId: 'user-1',
        activeOrgId: 'tenant-1',
        authenticatedAt: new Date(),
        expiresAt: new Date(Date.now() + 86400000),
        rememberMe: false,
        isImpersonation: false,
        impersonatorUserId: null,
      }),
    },
  } as unknown as ReturnType<typeof createTenantDb>
}

describe('POST /auth/reset-password', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(validatePasswordLength).mockReturnValue({ ok: true, value: true })
    vi.mocked(checkHibpBreached).mockResolvedValue(false)
    vi.mocked(isPasswordReused).mockResolvedValue(false)
  })

  it('token 过期 -> token_expired', async () => {
    vi.mocked(verifyResetToken).mockResolvedValue({ ok: false, reason: 'expired' })
    const app = makeApp(registerSessionAuthRoutes)
    const res = await post(app, makeEnv(), '/auth/reset-password', {
      token: 'expired.token',
      password: 'NewStrongPass1',
    })
    expect(((await res.json()) as { code: string }).code).toBe('token_expired')
    expect(buildVerifyKeySet).toHaveBeenCalled()
  })

  it('token 无效(签名错误) -> token_invalid', async () => {
    vi.mocked(verifyResetToken).mockResolvedValue({ ok: false, reason: 'invalid' })
    const app = makeApp(registerSessionAuthRoutes)
    const res = await post(app, makeEnv(), '/auth/reset-password', {
      token: 'forged.token',
      password: 'NewStrongPass1',
    })
    expect(((await res.json()) as { code: string }).code).toBe('token_invalid')
  })

  it('HIBP 命中 -> password_breached', async () => {
    vi.mocked(verifyResetToken).mockResolvedValue({ ok: true, userId: 'user-1', jti: 'jti-1' })
    vi.mocked(checkHibpBreached).mockResolvedValue(true)
    vi.mocked(createTenantDb).mockReturnValue(
      resetDb({ userId: 'user-1', consumedAt: null, expiresAt: new Date(Date.now() + 900000) }),
    )
    const app = makeApp(registerSessionAuthRoutes)
    const res = await post(app, makeEnv(), '/auth/reset-password', {
      token: 'valid.token',
      password: 'Password12345',
    })
    expect(((await res.json()) as { code: string }).code).toBe('password_breached')
  })

  it('happy -> 200 + 签发 session', async () => {
    vi.mocked(verifyResetToken).mockResolvedValue({ ok: true, userId: 'user-1', jti: 'jti-1' })
    vi.mocked(createTenantDb).mockReturnValue(
      resetDb({ userId: 'user-1', consumedAt: null, expiresAt: new Date(Date.now() + 900000) }),
    )
    const app = makeApp(registerSessionAuthRoutes)
    const res = await post(app, makeEnv(), '/auth/reset-password', {
      token: 'valid.token',
      password: 'NewStrongPass1',
    })
    expect(res.status).toBe(200)
  })

  it('forceSso valid token -> invalid_credentials 且不消费 token 不改密码不签发 session', async () => {
    const auditSend = vi.fn()
    vi.mocked(verifyResetToken).mockResolvedValue({ ok: true, userId: 'user-1', jti: 'jti-1' })
    const db = resetDb({
      userId: 'user-1',
      consumedAt: null,
      expiresAt: new Date(Date.now() + 900000),
    })
    vi.mocked(createTenantDb).mockReturnValue(db)
    const tenant = makeTenant()
    tenant.policy.hostedAuth.forceSso = true
    const app = makeApp(registerSessionAuthRoutes, { tenant: tenant as never })
    const res = await post(app, makeEnv({ auditSend }), '/auth/reset-password', {
      token: 'valid.token',
      password: 'NewStrongPass1',
    })

    expect(res.status).toBe(401)
    expect(((await res.json()) as { code: string }).code).toBe('invalid_credentials')
    expect(db.passwordResetTokens.update).not.toHaveBeenCalled()
    expect(db.passwords.update).not.toHaveBeenCalled()
    expect(db.passwords.insert).not.toHaveBeenCalled()
    expect(db.sessions.insert).not.toHaveBeenCalled()
    expect(auditSend).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.policy_denied',
        tenantId: 'tenant-1',
        payload: expect.objectContaining({
          method: 'password',
          action: 'login',
          reason: 'force_sso',
          path: '/auth/reset-password',
        }),
      }),
    )
  })

  it('root 入口 instance issuer token -> 按 tenant_id hint 重置密码', async () => {
    const resolvedTenant = makeTenant('tenant-resolved', 'https://xid.dev')
    resolvedTenant.issuer = 'https://xid.dev'
    vi.mocked(resolveTenantContextByIssuer).mockResolvedValue({
      ok: true,
      value: { status: 'resolved', tenant: resolvedTenant },
    } as never)
    vi.mocked(verifyResetToken).mockResolvedValue({ ok: true, userId: 'user-1', jti: 'jti-1' })
    vi.mocked(createTenantDb).mockReturnValue(
      resetDb({ userId: 'user-1', consumedAt: null, expiresAt: new Date(Date.now() + 900000) }),
    )
    const rootTenant = {
      ...makeTenant('tenant-entry', 'https://xid.dev'),
      rpId: 'xid.dev',
      resolution: { kind: 'instance_entry', primaryDomain: 'xid.dev', unresolvedRoot: true },
    }
    const app = makeApp(registerSessionAuthRoutes, { tenant: rootTenant as never })
    const env = makeEnv()
    const token = unsignedResetTokenPayload({
      iss: 'https://xid.dev',
      sub: 'user-1',
      jti: 'jti-1',
      exp: Math.floor(Date.now() / 1000) + 900,
      tenant_id: 'tenant-resolved',
    })

    const res = await post(app, env, 'https://xid.dev/auth/reset-password', {
      token,
      password: 'NewStrongPass1',
    })

    expect(res.status).toBe(200)
    expect(resolveTenantContextByIssuer).toHaveBeenCalledWith(
      expect.any(Request),
      env,
      'https://xid.dev',
      { tenantId: 'tenant-resolved' },
    )
    expect(createTenantDb).toHaveBeenCalledWith(env.DB, resolvedTenant)
  })

  it('deleted user valid token -> invalid_credentials 且不消费 token 不改密码', async () => {
    vi.mocked(verifyResetToken).mockResolvedValue({ ok: true, userId: 'user-1', jti: 'jti-1' })
    const db = resetDb({
      userId: 'user-1',
      consumedAt: null,
      expiresAt: new Date(Date.now() + 900000),
    })
    vi.mocked(db.users.findOne).mockResolvedValue(undefined)
    vi.mocked(createTenantDb).mockReturnValue(db)
    const app = makeApp(registerSessionAuthRoutes)
    const res = await post(app, makeEnv(), '/auth/reset-password', {
      token: 'valid.token',
      password: 'NewStrongPass1',
    })

    expect(res.status).toBe(401)
    expect(((await res.json()) as { code: string }).code).toBe('invalid_credentials')
    expect(db.passwordResetTokens.update).not.toHaveBeenCalled()
    expect(db.passwords.update).not.toHaveBeenCalled()
    expect(db.passwords.insert).not.toHaveBeenCalled()
  })

  it('token DB 无记录(跨租户/重放)-> token_invalid', async () => {
    vi.mocked(verifyResetToken).mockResolvedValue({ ok: true, userId: 'user-1', jti: 'jti-1' })
    // B 上下文 findOne 返回 undefined(查不到 A 的 reset token)。
    vi.mocked(createTenantDb).mockReturnValue(resetDb(null))
    const tenant = makeTenant('tenant-B')
    tenant.issuer = 'https://b.xid.dev'
    tenant.rpId = 'b.xid.dev'
    const app = makeApp(registerSessionAuthRoutes, {
      tenant: tenant as never,
    })
    const res = await post(app, makeEnv(), '/auth/reset-password', {
      token: 'valid.token',
      password: 'NewStrongPass1',
    })
    expect(((await res.json()) as { code: string }).code).toBe('token_invalid')
  })
})
