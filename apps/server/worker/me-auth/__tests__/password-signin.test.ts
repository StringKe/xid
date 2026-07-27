// POST /auth/password/sign-in 单测:happy path / 枚举防护(不存在与错误同 invalid_credentials)/
// 账户锁定 / 限流 429 / 跨租户隔离(org B 上下文查不到 org A 用户 -> invalid_credentials 不泄露存在性)。

import { describe, it, expect, vi, beforeEach } from 'vitest'

// @xid-kit/i18n 间接依赖 @lingui/core/macro(node 池无 babel transform),mock 掉。
vi.mock('@xid-kit/i18n', () => ({
  renderScopeDescription: (s: string) => s,
}))

vi.mock('@xid-kit/db', () => ({
  createTenantDb: vi.fn(),
  resolveInstanceLoginCandidates: vi.fn(),
  resolveTenantContextById: vi.fn(),
  schema: {
    userEmails: {
      id: 'id',
      email: 'email',
      userId: 'userId',
      isPrimary: 'isPrimary',
    },
    userPhones: { phone: 'phone', userId: 'userId' },
    users: { id: 'id', username: 'username', externalId: 'externalId' },
    passwords: { userId: 'userId' },
    sessions: { id: 'id', userId: 'userId' },
    memberships: { userId: 'userId', status: 'status', orgId: 'orgId' },
    organizations: { id: 'id', status: 'status', deletedAt: 'deletedAt' },
  },
}))

// password.ts 纯逻辑 mock(argon2 慢,单测控制 verify 结果)。
vi.mock('../../auth/password', () => ({
  validatePasswordLength: vi.fn().mockReturnValue({ ok: true, value: true }),
  hashPassword: vi
    .fn()
    .mockResolvedValue({ hash: '$argon2id$new', algo: 'argon2id', pepperVersion: 1 }),
  passwordReuseTag: vi.fn().mockResolvedValue('pwd-reuse:v1:test'),
  verifyPassword: vi.fn(),
  checkHibpBreached: vi.fn().mockResolvedValue(false),
}))

vi.mock('../email-verify-token', () => ({
  issueEmailVerification: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../lib/mfa-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/mfa-session')>()
  return { ...actual, resolvePostAuthMfaGate: vi.fn().mockResolvedValue({}) }
})

import {
  createTenantDb,
  resolveInstanceLoginCandidates,
  resolveTenantContextById,
} from '@xid-kit/db'
import { verifyPassword } from '../../auth/password'
import { issueEmailVerification } from '../email-verify-token'
import { registerSessionAuthRoutes } from '../index'
import { execCtx, makeApp, makeEnv, makeTenant } from './helpers'

function dbWithUser(opts: {
  emailUserId?: string | null
  user?: {
    id: string
    status: string
    lockoutUntil: Date | null
    deletedAt?: Date | null
    primaryEmailId?: string | null
  } | null
  passwordHash?: string | null
  emailVerified?: boolean
}) {
  return {
    userEmails: {
      findOne: vi.fn().mockResolvedValue(
        opts.emailUserId
          ? {
              id: 'email-1',
              userId: opts.emailUserId,
              email: 'user@example.com',
              verified: opts.emailVerified ?? true,
              isPrimary: true,
            }
          : undefined,
      ),
      insert: vi.fn().mockResolvedValue({ id: 'email-new' }),
    },
    userPhones: { findOne: vi.fn().mockResolvedValue(undefined), insert: vi.fn() },
    users: {
      findOne: vi.fn().mockResolvedValue(opts.user ?? undefined),
      insert: vi.fn().mockResolvedValue({ id: 'user-new' }),
    },
    passwords: {
      findOne: vi
        .fn()
        .mockResolvedValue(
          opts.passwordHash ? { hash: opts.passwordHash, algo: 'argon2id' } : undefined,
        ),
      update: vi.fn().mockResolvedValue([]),
      insert: vi.fn().mockResolvedValue({ id: 'pw-new' }),
    },
    memberships: {
      findMany: vi
        .fn()
        .mockResolvedValue([
          { id: 'mem-1', userId: opts.user?.id ?? 'user-1', orgId: 'tenant-1', status: 'active' },
        ]),
      insert: vi.fn().mockResolvedValue({ id: 'mem-new' }),
    },
    organizations: {
      findOne: vi.fn().mockResolvedValue({ id: 'tenant-1', status: 'active', deletedAt: null }),
      findMany: vi.fn().mockResolvedValue([{ id: 'tenant-1', status: 'active', deletedAt: null }]),
    },
    sessions: {
      insert: vi.fn().mockResolvedValue({
        id: 'sess-1',
        userId: opts.user?.id ?? 'user-1',
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

function request(app: ReturnType<typeof makeApp>, env: Env, body: unknown) {
  return app.request(
    '/auth/password/sign-in',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    env,
    execCtx,
  )
}

function makeTenantWithUsernamePasswordCreation() {
  return {
    tenantId: 'tenant-1',
    issuer: 'https://tenant-1.xid.dev',
    rpId: 'tenant-1.xid.dev',
    signingKeys: { activeKid: 'k1', defaultAlg: 'ES256', keys: [] },
    policy: {
      hostedAuth: {
        identifierMode: 'username',
        requireVerifiedEmail: true,
        allowedEmailDomains: [],
        blockedEmailDomains: [],
        forceSso: false,
        allowUserCreation: true,
        allowExistingUserLogin: true,
        profileFields: {
          email: 'required',
          username: 'required',
          phone: 'hidden',
          name: 'hidden',
          givenName: 'hidden',
          familyName: 'hidden',
        },
        password: {
          enabled: true,
          allowLogin: true,
          allowUserCreation: true,
          requireEmailVerification: true,
        },
        magicLink: { enabled: false, allowLogin: false, allowUserCreation: false },
        emailOtp: { enabled: false, allowLogin: false, allowUserCreation: false },
        whatsappOtp: { enabled: false, allowLogin: false, allowUserCreation: false },
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
      },
    },
  }
}

describe('POST /auth/password/sign-in', () => {
  beforeEach(() => vi.clearAllMocks())

  it('正确密码 -> 200 + 签发 session', async () => {
    vi.mocked(verifyPassword).mockResolvedValue(true)
    const db = dbWithUser({
      emailUserId: 'user-1',
      user: { id: 'user-1', status: 'active', lockoutUntil: null },
      passwordHash: '$argon2id$stored',
    })
    vi.mocked(createTenantDb).mockReturnValue(db)
    const app = makeApp(registerSessionAuthRoutes)
    const res = await request(app, makeEnv(), {
      identifier: 'user@example.com',
      password: 'CorrectHorse12',
      turnstileToken: null,
    })
    expect(res.status).toBe(200)
    expect(db.sessions.insert).toHaveBeenCalledWith(
      expect.objectContaining({ activeOrgId: 'tenant-1' }),
    )
  })

  it('body.rememberMe 显式 true -> session rememberMe=true', async () => {
    vi.mocked(verifyPassword).mockResolvedValue(true)
    const db = dbWithUser({
      emailUserId: 'user-1',
      user: { id: 'user-1', status: 'active', lockoutUntil: null },
      passwordHash: '$argon2id$stored',
    })
    vi.mocked(createTenantDb).mockReturnValue(db)
    const app = makeApp(registerSessionAuthRoutes)
    const res = await request(app, makeEnv(), {
      identifier: 'user@example.com',
      password: 'CorrectHorse12',
      rememberMe: true,
    })
    expect(res.status).toBe(200)
    expect(db.sessions.insert).toHaveBeenCalledWith(expect.objectContaining({ rememberMe: true }))
  })

  it('body 未传 rememberMe -> 回退策略 rememberMeDefault', async () => {
    vi.mocked(verifyPassword).mockResolvedValue(true)
    const db = dbWithUser({
      emailUserId: 'user-1',
      user: { id: 'user-1', status: 'active', lockoutUntil: null },
      passwordHash: '$argon2id$stored',
    })
    vi.mocked(createTenantDb).mockReturnValue(db)
    const base = makeTenant()
    const tenant = {
      ...base,
      policy: {
        ...base.policy,
        session: { idleTimeoutMin: 60, absoluteTimeoutDays: 7, rememberMeDefault: true },
      },
    }
    const app = makeApp(registerSessionAuthRoutes, { tenant: tenant as never })
    const res = await request(app, makeEnv(), {
      identifier: 'user@example.com',
      password: 'CorrectHorse12',
    })
    expect(res.status).toBe(200)
    expect(db.sessions.insert).toHaveBeenCalledWith(expect.objectContaining({ rememberMe: true }))
  })

  it('body 与策略均未设 rememberMe -> 兜底 false', async () => {
    vi.mocked(verifyPassword).mockResolvedValue(true)
    const db = dbWithUser({
      emailUserId: 'user-1',
      user: { id: 'user-1', status: 'active', lockoutUntil: null },
      passwordHash: '$argon2id$stored',
    })
    vi.mocked(createTenantDb).mockReturnValue(db)
    const app = makeApp(registerSessionAuthRoutes)
    const res = await request(app, makeEnv(), {
      identifier: 'user@example.com',
      password: 'CorrectHorse12',
    })
    expect(res.status).toBe(200)
    expect(db.sessions.insert).toHaveBeenCalledWith(expect.objectContaining({ rememberMe: false }))
  })

  it('root 入口按 email/phone/username/external_id candidates 切到最终 tenant 后登录', async () => {
    const resolvedTenant = {
      tenantId: 'tenant-resolved',
      issuer: 'https://xid.dev',
      rpId: 'app.xid.dev',
      signingKeys: { activeKid: 'k1', defaultAlg: 'ES256', keys: [] },
      policy: {
        hostedAuth: {
          identifierMode: 'username',
          requireVerifiedEmail: false,
          allowedEmailDomains: [],
          blockedEmailDomains: [],
          forceSso: false,
          allowUserCreation: true,
          allowExistingUserLogin: true,
          password: { enabled: true, allowLogin: true, allowUserCreation: true },
          magicLink: { enabled: false, allowLogin: false, allowUserCreation: false },
          emailOtp: { enabled: false, allowLogin: false, allowUserCreation: false },
          whatsappOtp: { enabled: false, allowLogin: false, allowUserCreation: false },
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
        },
      },
    }
    const rootTenant = {
      ...resolvedTenant,
      tenantId: 'tenant-entry',
      rpId: 'xid.dev',
      resolution: { kind: 'instance_entry', primaryDomain: 'xid.dev', unresolvedRoot: true },
    }
    vi.mocked(resolveInstanceLoginCandidates).mockResolvedValue({
      ok: true,
      value: { status: 'resolved', tenant: resolvedTenant, matchedBy: 'username' },
    } as never)
    vi.mocked(verifyPassword).mockResolvedValue(true)
    const db = dbWithUser({
      user: { id: 'user-1', status: 'active', lockoutUntil: null },
      passwordHash: '$argon2id$stored',
    })
    vi.mocked(createTenantDb).mockReturnValue(db)
    const app = makeApp(registerSessionAuthRoutes, { tenant: rootTenant as never })

    const res = await request(app, makeEnv(), {
      identifier: 'alice',
      password: 'CorrectHorse12',
      turnstileToken: null,
    })

    expect(res.status).toBe(200)
    expect(resolveInstanceLoginCandidates).toHaveBeenCalledWith(
      expect.any(Request),
      expect.anything(),
      [
        { kind: 'username', value: 'alice' },
        { kind: 'external_id', value: 'alice' },
      ],
    )
    expect(createTenantDb).toHaveBeenCalledWith(expect.anything(), resolvedTenant)
  })

  it('root 入口带 organizationId 时按选中 organization 创建 password 用户', async () => {
    const resolvedTenant = makeTenantWithUsernamePasswordCreation()
    resolvedTenant.tenantId = 'tenant-selected'
    resolvedTenant.issuer = 'https://xid.dev'
    resolvedTenant.rpId = 'xid.dev'
    const rootTenant = {
      ...makeTenantWithUsernamePasswordCreation(),
      tenantId: 'tenant-entry',
      issuer: 'https://xid.dev',
      rpId: 'xid.dev',
      resolution: { kind: 'instance_entry', primaryDomain: 'xid.dev', unresolvedRoot: true },
    }
    vi.mocked(resolveTenantContextById).mockResolvedValue({
      ok: true,
      value: { status: 'resolved', tenant: resolvedTenant },
    } as never)
    vi.mocked(verifyPassword).mockResolvedValue(false)
    const db = dbWithUser({ emailUserId: null, user: null })
    vi.mocked(createTenantDb).mockReturnValue(db)
    const app = makeApp(registerSessionAuthRoutes, { tenant: rootTenant as never })

    const res = await request(app, makeEnv(), {
      identifier: 'alice',
      email: 'alice@example.com',
      password: 'StrongPass123',
      organizationId: 'tenant-selected',
      turnstileToken: null,
    })

    expect(res.status).toBe(200)
    expect(resolveTenantContextById).toHaveBeenCalledWith(
      expect.any(Request),
      expect.anything(),
      'tenant-selected',
    )
    expect(resolveInstanceLoginCandidates).not.toHaveBeenCalled()
    expect(createTenantDb).toHaveBeenCalledWith(expect.anything(), resolvedTenant)
    expect(db.users.insert).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-selected', username: 'alice' }),
    )
  })

  it('tenant 禁用 password login -> invalid_credentials', async () => {
    const auditSend = vi.fn()
    vi.mocked(verifyPassword).mockResolvedValue(true)
    vi.mocked(createTenantDb).mockReturnValue(
      dbWithUser({
        emailUserId: 'user-1',
        user: { id: 'user-1', status: 'active', lockoutUntil: null },
        passwordHash: '$argon2id$stored',
      }),
    )
    const app = makeApp(registerSessionAuthRoutes, {
      tenant: {
        tenantId: 'tenant-1',
        issuer: 'https://tenant-1.xid.dev',
        rpId: 'tenant-1.xid.dev',
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
            magicLink: { enabled: true, allowLogin: true, allowUserCreation: false },
            emailOtp: { enabled: true, allowLogin: true, allowUserCreation: false },
            smsOtp: { enabled: false, allowLogin: false, allowUserCreation: false },
            passkey: { enabled: false, allowLogin: false, allowUserCreation: false },
            enterpriseSso: {
              enabled: false,
              allowLogin: false,
              allowJitUserCreation: false,
              domainDiscovery: false,
            },
          },
        },
      } as never,
    })
    const res = await request(app, makeEnv(), {
      identifier: 'user@example.com',
      password: 'CorrectHorse12',
      turnstileToken: null,
    })
    expect(res.status).toBe(401)
    expect(((await res.json()) as { code: string }).code).toBe('invalid_credentials')

    const resWithAudit = await request(app, makeEnv({ auditSend }), {
      identifier: 'user@example.com',
      password: 'CorrectHorse12',
      turnstileToken: null,
    })
    expect(resWithAudit.status).toBe(401)
    expect(auditSend).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        action: 'auth.policy_denied',
        payload: expect.objectContaining({
          method: 'password',
          action: 'login',
          reason: 'method_disabled',
          identifierType: 'email',
          emailDomain: 'example.com',
        }),
      }),
    )
    expect(JSON.stringify(auditSend.mock.calls[0])).not.toContain('user@example.com')
  })

  it('forceSso 禁止 password login -> invalid_credentials + 策略拒绝审计', async () => {
    const auditSend = vi.fn()
    vi.mocked(verifyPassword).mockResolvedValue(true)
    const db = dbWithUser({
      emailUserId: 'user-1',
      user: { id: 'user-1', status: 'active', lockoutUntil: null },
      passwordHash: '$argon2id$stored',
    })
    vi.mocked(createTenantDb).mockReturnValue(db)
    const tenant = makeTenantWithUsernamePasswordCreation()
    tenant.policy.hostedAuth.identifierMode = 'email'
    tenant.policy.hostedAuth.forceSso = true
    const app = makeApp(registerSessionAuthRoutes, { tenant: tenant as never })
    const res = await request(app, makeEnv({ auditSend }), {
      identifier: 'user@example.com',
      password: 'CorrectHorse12',
      turnstileToken: null,
    })

    expect(res.status).toBe(401)
    expect(((await res.json()) as { code: string }).code).toBe('invalid_credentials')
    expect(db.sessions.insert).not.toHaveBeenCalled()
    expect(auditSend).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        action: 'auth.policy_denied',
        payload: expect.objectContaining({
          method: 'password',
          action: 'login',
          reason: 'force_sso',
          identifierType: 'email',
          emailDomain: 'example.com',
        }),
      }),
    )
  })

  it('用户不存在且允许 password 创建 -> 创建用户并返回 verify_email', async () => {
    vi.mocked(verifyPassword).mockResolvedValue(false)
    const db = dbWithUser({ emailUserId: null, user: null })
    vi.mocked(createTenantDb).mockReturnValue(db)
    const app = makeApp(registerSessionAuthRoutes)
    const res = await request(app, makeEnv(), {
      identifier: 'new@example.com',
      password: 'StrongPass123',
      turnstileToken: null,
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { nextStep: string }).nextStep).toBe('verify_email')
    expect(db.users.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        primaryEmailId: expect.any(String),
        username: null,
        profileCompletionStatus: 'complete',
      }),
    )
    expect(issueEmailVerification).toHaveBeenCalledOnce()
  })

  it('intent=sign-up 的验证邮件保留组织 onboarding intent', async () => {
    vi.mocked(verifyPassword).mockResolvedValue(false)
    const db = dbWithUser({ emailUserId: null, user: null })
    vi.mocked(createTenantDb).mockReturnValue(db)
    const app = makeApp(registerSessionAuthRoutes)

    const res = await request(app, makeEnv(), {
      identifier: 'owner@example.com',
      password: 'StrongPass123',
      intent: 'sign-up',
      turnstileToken: null,
    })

    expect(res.status).toBe(200)
    expect(((await res.json()) as { nextStep: string }).nextStep).toBe('verify_email')
    expect(issueEmailVerification).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'owner@example.com',
        intent: 'sign-up',
      }),
    )
  })

  it('既有未验证 password 用户不能绕过 sign-up Email verification', async () => {
    vi.mocked(verifyPassword).mockResolvedValue(true)
    const db = dbWithUser({
      emailUserId: 'user-1',
      emailVerified: false,
      user: {
        id: 'user-1',
        status: 'active',
        lockoutUntil: null,
        primaryEmailId: 'email-1',
      },
      passwordHash: '$argon2id$stored',
    })
    vi.mocked(createTenantDb).mockReturnValue(db)
    const app = makeApp(registerSessionAuthRoutes)

    const res = await request(app, makeEnv(), {
      identifier: 'user@example.com',
      password: 'CorrectHorse12',
      intent: 'sign-up',
      turnstileToken: null,
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ nextStep: 'verify_email' })
    expect(issueEmailVerification).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'user@example.com',
        intent: 'sign-up',
      }),
    )
    expect(db.sessions.insert).not.toHaveBeenCalled()
  })

  it('用户不存在且 username identifier 要求 profile email -> 创建用户并发送验证邮件', async () => {
    vi.mocked(verifyPassword).mockResolvedValue(false)
    const db = dbWithUser({ emailUserId: null, user: null })
    vi.mocked(createTenantDb).mockReturnValue(db)
    const tenant = makeTenantWithUsernamePasswordCreation()
    Object.assign(tenant.policy.hostedAuth, {
      profileFields: {
        ...tenant.policy.hostedAuth.profileFields,
        email: 'required',
        username: 'required',
        name: 'optional',
      },
    })
    const app = makeApp(registerSessionAuthRoutes, { tenant: tenant as never })

    const res = await request(app, makeEnv(), {
      identifier: 'alice',
      email: 'alice@example.com',
      name: 'Alice Chen',
      password: 'StrongPass123',
      turnstileToken: null,
    })

    expect(res.status).toBe(200)
    expect(((await res.json()) as { nextStep: string }).nextStep).toBe('verify_email')
    expect(db.users.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        username: 'alice',
        displayName: 'Alice Chen',
        profileCompletionStatus: 'complete',
      }),
    )
    expect(db.userEmails.insert).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'alice@example.com', isPrimary: true }),
    )
    expect(issueEmailVerification).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'alice@example.com' }),
    )
  })

  it('用户不存在且缺 required profile email -> validation_failed', async () => {
    vi.mocked(verifyPassword).mockResolvedValue(false)
    const db = dbWithUser({ emailUserId: null, user: null })
    vi.mocked(createTenantDb).mockReturnValue(db)
    const tenant = makeTenantWithUsernamePasswordCreation()
    Object.assign(tenant.policy.hostedAuth, {
      profileFields: {
        ...tenant.policy.hostedAuth.profileFields,
        email: 'required',
        username: 'required',
      },
    })
    const app = makeApp(registerSessionAuthRoutes, { tenant: tenant as never })

    const res = await request(app, makeEnv(), {
      identifier: 'alice',
      password: 'StrongPass123',
      turnstileToken: null,
    })

    expect(res.status).toBe(422)
    expect(((await res.json()) as { code: string }).code).toBe('validation_failed')
    expect(db.users.insert).not.toHaveBeenCalled()
  })

  it('用户不存在且禁用 password 创建 -> invalid_credentials', async () => {
    vi.mocked(verifyPassword).mockResolvedValue(false)
    vi.mocked(createTenantDb).mockReturnValue(dbWithUser({ emailUserId: null, user: null }))
    const tenant = {
      tenantId: 'tenant-1',
      issuer: 'https://tenant-1.xid.dev',
      rpId: 'tenant-1.xid.dev',
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
          password: {
            enabled: true,
            allowLogin: true,
            allowUserCreation: false,
            requireEmailVerification: true,
          },
          magicLink: { enabled: true, allowLogin: true, allowUserCreation: false },
          emailOtp: { enabled: true, allowLogin: true, allowUserCreation: false },
          smsOtp: { enabled: false, allowLogin: false, allowUserCreation: false },
          passkey: { enabled: false, allowLogin: false, allowUserCreation: false },
          enterpriseSso: {
            enabled: false,
            allowLogin: false,
            allowJitUserCreation: false,
            domainDiscovery: false,
          },
        },
      },
    } as never
    const app = makeApp(registerSessionAuthRoutes, { tenant })
    const res = await request(app, makeEnv(), {
      identifier: 'nobody@example.com',
      password: 'whatever12345',
      turnstileToken: null,
    })
    expect(res.status).toBe(401)
    expect(((await res.json()) as { code: string }).code).toBe('invalid_credentials')
  })

  it('forceSso 禁止 password 创建 -> invalid_credentials + 不创建用户', async () => {
    const auditSend = vi.fn()
    vi.mocked(verifyPassword).mockResolvedValue(false)
    const db = dbWithUser({ emailUserId: null, user: null })
    vi.mocked(createTenantDb).mockReturnValue(db)
    const tenant = makeTenantWithUsernamePasswordCreation()
    tenant.policy.hostedAuth.identifierMode = 'email'
    tenant.policy.hostedAuth.forceSso = true
    const app = makeApp(registerSessionAuthRoutes, { tenant: tenant as never })
    const res = await request(app, makeEnv({ auditSend }), {
      identifier: 'new@example.com',
      password: 'StrongPass123',
      turnstileToken: null,
    })

    expect(res.status).toBe(401)
    expect(((await res.json()) as { code: string }).code).toBe('invalid_credentials')
    expect(db.users.insert).not.toHaveBeenCalled()
    expect(db.passwords.insert).not.toHaveBeenCalled()
    expect(issueEmailVerification).not.toHaveBeenCalled()
    expect(auditSend).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        action: 'auth.policy_denied',
        payload: expect.objectContaining({
          method: 'password',
          action: 'user_creation',
          reason: 'force_sso',
          identifierType: 'email',
          emailDomain: 'example.com',
        }),
      }),
    )
  })

  it('密码错误 -> invalid_credentials(与不存在同响应)', async () => {
    vi.mocked(verifyPassword).mockResolvedValue(false)
    vi.mocked(createTenantDb).mockReturnValue(
      dbWithUser({
        emailUserId: 'user-1',
        user: { id: 'user-1', status: 'active', lockoutUntil: null },
        passwordHash: '$argon2id$stored',
      }),
    )
    const app = makeApp(registerSessionAuthRoutes)
    const res = await request(app, makeEnv(), {
      identifier: 'user@example.com',
      password: 'WrongPassword1',
      turnstileToken: null,
    })
    expect(res.status).toBe(401)
    expect(((await res.json()) as { code: string }).code).toBe('invalid_credentials')
  })

  it('账户锁定中 -> account_locked', async () => {
    vi.mocked(verifyPassword).mockResolvedValue(true)
    vi.mocked(createTenantDb).mockReturnValue(
      dbWithUser({
        emailUserId: 'user-1',
        user: { id: 'user-1', status: 'active', lockoutUntil: new Date(Date.now() + 60000) },
        passwordHash: '$argon2id$stored',
      }),
    )
    const app = makeApp(registerSessionAuthRoutes)
    const res = await request(app, makeEnv(), {
      identifier: 'user@example.com',
      password: 'CorrectHorse12',
      turnstileToken: null,
    })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { code: string }).code).toBe('account_locked')
  })

  it('soft deleted user 正确密码 -> account_locked 且不签发 session', async () => {
    vi.mocked(verifyPassword).mockResolvedValue(true)
    const db = dbWithUser({
      emailUserId: 'user-1',
      user: {
        id: 'user-1',
        status: 'active',
        lockoutUntil: null,
        deletedAt: new Date(),
      },
      passwordHash: '$argon2id$stored',
    })
    vi.mocked(createTenantDb).mockReturnValue(db)

    const app = makeApp(registerSessionAuthRoutes)
    const res = await request(app, makeEnv(), {
      identifier: 'user@example.com',
      password: 'CorrectHorse12',
      turnstileToken: null,
    })

    expect(res.status).toBe(403)
    expect(((await res.json()) as { code: string }).code).toBe('account_locked')
    expect(db.sessions.insert).not.toHaveBeenCalled()
  })

  it('限流时 -> 429', async () => {
    vi.mocked(createTenantDb).mockReturnValue(dbWithUser({ emailUserId: 'user-1' }))
    const app = makeApp(registerSessionAuthRoutes)
    const res = await request(app, makeEnv({ rateLimitAllowed: false }), {
      identifier: 'user@example.com',
      password: 'CorrectHorse12',
      turnstileToken: null,
    })
    expect(res.status).toBe(429)
  })

  it('跨租户:org B 上下文查不到 org A 用户 -> invalid_credentials 不泄露存在性', async () => {
    // 租户隔离由 createTenantDb 注入 tenant_id;B 上下文 findOne 返回 undefined(查不到 A 的 user)。
    vi.mocked(verifyPassword).mockResolvedValue(false)
    vi.mocked(createTenantDb).mockReturnValue(dbWithUser({ emailUserId: null, user: null }))
    const app = makeApp(registerSessionAuthRoutes, {
      tenant: { tenantId: 'tenant-B', issuer: 'https://b.xid.dev', rpId: 'b.xid.dev' } as never,
    })
    const res = await request(app, makeEnv(), {
      identifier: 'a-user@example.com',
      password: 'CorrectHorse12',
      turnstileToken: null,
    })
    expect(res.status).toBe(401)
    expect(((await res.json()) as { code: string }).code).toBe('invalid_credentials')
  })
})
