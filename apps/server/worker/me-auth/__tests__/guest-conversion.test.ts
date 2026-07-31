// guest 转正(guest conversion)单测:四切入点中的 OTP 与 password 路径。
// 覆盖:send 挂接不建号 / verify 转正(provisionedBy 改写 + session 轮换 + 审计 + GuestStore 解绑)/
// 强制 MFA 走 pending_mfa_setup / email 冲突(send 不泄露 + verify invalid_credentials)/
// 跨租户(B 租户上下文查不到 A 租户 guest -> 落回建号)/ 非 guest session 零回归。
// harness 对齐 passwordless.test.ts / password-signin.test.ts:mock @xid-kit/db 查询层 + auth/otp +
// auth/password,DO/队列走 helpers fake。

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DEFAULT_HOSTED_AUTH_PROFILE_FIELDS } from '@xid-kit/types'

vi.mock('@xid-kit/i18n', () => ({ renderScopeDescription: (s: string) => s }))

vi.mock('@xid-kit/db', () => ({
  createTenantDb: vi.fn(),
  resolveInstanceLogin: vi.fn(),
  resolveInstanceLoginCandidates: vi.fn(),
  resolveTenantContextById: vi.fn(),
  resolveTenantContextByIssuer: vi.fn(),
  USER_PROVISIONED_BY_ANONYMOUS: 'anonymous',
  schema: {
    verificationTokens: { tokenHash: 'tokenHash' },
    userEmails: { email: 'email', userId: 'userId', isPrimary: 'isPrimary' },
    userPhones: { phone: 'phone', userId: 'userId', isPrimary: 'isPrimary' },
    users: {
      id: 'id',
      status: 'status',
      deletedAt: 'deletedAt',
      username: 'username',
      externalId: 'externalId',
    },
    passwords: { userId: 'userId' },
    sessions: { id: 'id', userId: 'userId' },
    memberships: { userId: 'userId', status: 'status', orgId: 'orgId' },
    organizations: { id: 'id', status: 'status', deletedAt: 'deletedAt' },
  },
}))

vi.mock('../../auth/otp', () => ({
  consumeVerifiableOtp: vi.fn().mockResolvedValue(true),
  constantTimeEqualStr: vi.fn().mockReturnValue(true),
  loadVerifiableOtp: vi.fn(),
  otpMinKey: (t: string, id: string) => `otp:min:${id}:${t}`,
  otpHourKey: (t: string, id: string) => `otp:hour:${id}:${t}`,
  persistAndSendOtp: vi.fn().mockResolvedValue(undefined),
  recordOtpFailure: vi.fn(),
  reserveRateLimitWindows: vi.fn().mockResolvedValue(undefined),
  reserveOtpSendRateLimit: vi.fn().mockResolvedValue(undefined),
  resolveTargetUserId: vi.fn(),
  validatePhoneOtpTarget: (p: string) => p.startsWith('+1'),
}))

// password.ts 纯逻辑 mock(argon2 慢,HIBP 出网)。
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

vi.mock('../../auth/account-provisioning', () => ({
  provisionAccountAtomically: vi.fn(async (input: { user: { id: string } }) => input.user.id),
}))

vi.mock('../../lib/mfa-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/mfa-session')>()
  return { ...actual, resolvePostAuthMfaGate: vi.fn().mockResolvedValue({}) }
})

import { createTenantDb } from '@xid-kit/db'
import {
  constantTimeEqualStr,
  consumeVerifiableOtp,
  loadVerifiableOtp,
  persistAndSendOtp,
  resolveTargetUserId,
} from '../../auth/otp'
import { hashPassword, passwordReuseTag, verifyPassword } from '../../auth/password'
import { issueEmailVerification } from '../email-verify-token'
import { provisionAccountAtomically } from '../../auth/account-provisioning'
import { resolvePostAuthMfaGate } from '../../lib/mfa-session'
import { registerSessionAuthRoutes } from '../index'
import { execCtx, makeApp, makeEnv, makeSession, makeTenant } from './helpers'

const ANON_COOKIE = '__Host-xid.anon=anon-x'
const GUEST_SESSION = () => makeSession('user-guest', 'sess-guest')
const GUEST_ROW = {
  id: 'user-guest',
  status: 'active',
  deletedAt: null,
  provisionedBy: 'anonymous',
}
const LOGIN_FLOW_CONTEXT = JSON.stringify({
  version: 1,
  intent: null,
  continuePath: '/console',
  applicationClientId: null,
  invitationId: null,
})

// stateful GuestStore fake:记录 (DO 实例名, action),断言 unbind 是否命中正确 tenant:anonKey。
function makeGuestStoreFake() {
  const calls: { name: string; action: string }[] = []
  const ns = {
    idFromName: (name: string) => name as unknown as DurableObjectId,
    get: (id: DurableObjectId) =>
      ({
        fetch: async (url: string) => {
          const action = new URL(url).pathname.replace(/^\//, '')
          calls.push({ name: String(id), action })
          if (action === 'lookup') return new Response('Not Found', { status: 404 })
          if (action === 'unbind') return new Response(null, { status: 204 })
          return Response.json({ userId: 'user-guest', created: true })
        },
      }) as unknown as DurableObjectStub,
  } as unknown as DurableObjectNamespace
  return { ns, calls }
}

// createTenantDb 返回值:users.findOne 默认命中 live guest;session insert 回显插入行
// (issueSession 的 toSessionData 需要完整字段)。
function makeDb(overrides: Record<string, unknown> = {}) {
  return {
    verificationTokens: { hardDelete: vi.fn().mockResolvedValue(undefined) },
    users: {
      findOne: vi.fn().mockResolvedValue(GUEST_ROW),
      insert: vi.fn().mockResolvedValue({ id: 'user-new' }),
      update: vi.fn().mockResolvedValue([]),
    },
    userEmails: {
      findOne: vi.fn().mockResolvedValue(undefined),
      insert: vi.fn().mockResolvedValue({ id: 'email-new' }),
      update: vi.fn().mockResolvedValue([]),
    },
    userPhones: {
      findOne: vi.fn().mockResolvedValue(undefined),
      insert: vi.fn().mockResolvedValue({ id: 'phone-new' }),
      update: vi.fn().mockResolvedValue([]),
    },
    passwords: {
      findOne: vi.fn().mockResolvedValue(undefined),
      insert: vi.fn().mockResolvedValue({ id: 'pw-new' }),
      update: vi.fn().mockResolvedValue([]),
    },
    passwordHistory: { insert: vi.fn().mockResolvedValue({ id: 'history-new' }) },
    memberships: {
      findMany: vi.fn().mockResolvedValue([]),
      insert: vi.fn().mockResolvedValue({ id: 'mem-new' }),
    },
    organizations: {
      findOne: vi.fn().mockResolvedValue(undefined),
      findMany: vi.fn().mockResolvedValue([]),
    },
    sessions: {
      insert: vi.fn().mockImplementation((row: Record<string, unknown>) =>
        Promise.resolve({
          ...row,
          lastActiveAt: new Date(),
          isImpersonation: false,
          impersonatorUserId: null,
        }),
      ),
      update: vi.fn().mockResolvedValue([]),
    },
    ...overrides,
  } as unknown as ReturnType<typeof createTenantDb>
}

function tenantWithEmailOtpCreation(tenantId = 'tenant-1') {
  const tenant = makeTenant(tenantId)
  Object.assign(tenant.policy.hostedAuth, {
    profileFields: DEFAULT_HOSTED_AUTH_PROFILE_FIELDS,
  })
  tenant.policy.hostedAuth.emailOtp = { enabled: true, allowLogin: true, allowUserCreation: true }
  return tenant
}

function post(
  app: ReturnType<typeof makeApp>,
  env: Env,
  path: string,
  input: { body: unknown; headers?: Record<string, string> },
) {
  return app.request(
    `https://tenant-1.xid.dev${path}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...input.headers },
      body: JSON.stringify(input.body),
    },
    env,
    execCtx,
  )
}

describe('guest 转正 -- OTP email', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(resolvePostAuthMfaGate).mockResolvedValue({})
  })

  it('send:guest session + 新 email -> 不建号,email 挂为 guest user 未验证主邮箱', async () => {
    vi.mocked(resolveTargetUserId).mockResolvedValue(null)
    const db = makeDb()
    vi.mocked(createTenantDb).mockReturnValue(db)
    const app = makeApp(registerSessionAuthRoutes, {
      session: GUEST_SESSION(),
      tenant: tenantWithEmailOtpCreation() as never,
    })

    const res = await post(app, makeEnv(), '/auth/otp/email/send', {
      body: { email: 'new@example.com', turnstileToken: null },
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(db.users.insert).not.toHaveBeenCalled()
    expect(db.userEmails.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-guest',
        email: 'new@example.com',
        verified: false,
        verificationStatus: 'unverified',
        isPrimary: true,
      }),
    )
    expect(persistAndSendOtp).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-guest' }),
    )
  })

  it('verify:OTP 通过 -> 标 verified + provisionedBy 改写 + session 轮换 + 审计 + GuestStore 解绑', async () => {
    vi.mocked(constantTimeEqualStr).mockReturnValue(true)
    vi.mocked(loadVerifiableOtp).mockResolvedValue({
      tokenHash: 'th-1',
      userId: 'user-guest',
      codeHash: 'code-hash',
      flowContext: LOGIN_FLOW_CONTEXT,
    } as never)
    const db = makeDb()
    vi.mocked(createTenantDb).mockReturnValue(db)
    const auditSend = vi.fn()
    const guestStore = makeGuestStoreFake()
    const env = makeEnv({ auditSend, guestStoreNs: guestStore.ns })
    const app = makeApp(registerSessionAuthRoutes, { session: GUEST_SESSION() })

    const res = await post(app, env, '/auth/otp/email/verify', {
      body: { email: 'new@example.com', code: '123456' },
      headers: { cookie: ANON_COOKIE },
    })

    expect(res.status).toBe(200)
    // 验证后 email 标 verified。
    expect(db.userEmails.update).toHaveBeenCalledWith(
      expect.objectContaining({ verified: true, verificationStatus: 'verified' }),
      expect.anything(),
    )
    // provisionedBy 从 anonymous 改写为 hosted_passwordless。
    expect(db.users.update).toHaveBeenCalledWith(
      { provisionedBy: 'hosted_passwordless' },
      expect.anything(),
    )
    // session 轮换:旧 refresh token 吊销 + 新 session 签发(amr 不含 guest)。
    expect(db.sessions.update).toHaveBeenCalledWith({ status: 'revoked' }, expect.anything())
    expect(db.sessions.insert).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-guest', amr: ['email'] }),
    )
    const insertedRow = db.sessions.insert.mock.calls[0]?.[0] as { amr: string[] } | undefined
    expect(insertedRow?.amr).toEqual(['email'])
    expect(insertedRow?.amr).not.toContain('guest')
    // 审计 + GuestStore 解绑(防向已转正账号续签 guest)。
    expect(auditSend).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        action: 'guest.converted',
        actorId: 'user-guest',
      }),
    )
    expect(guestStore.calls).toContainEqual({ name: 'tenant-1:anon-x', action: 'unbind' })
    // MFA 策略门恢复正常评估(guest 建号绕过,转正必须过门)。
    expect(resolvePostAuthMfaGate).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ userId: 'user-guest' }),
    )
  })

  it('verify:租户强制 MFA -> 转正后 session 走 pending_mfa_setup 既有路径', async () => {
    vi.mocked(constantTimeEqualStr).mockReturnValue(true)
    vi.mocked(loadVerifiableOtp).mockResolvedValue({
      tokenHash: 'th-1',
      userId: 'user-guest',
      codeHash: 'code-hash',
      flowContext: LOGIN_FLOW_CONTEXT,
    } as never)
    vi.mocked(resolvePostAuthMfaGate).mockResolvedValue({
      sessionStatus: 'pending_mfa_setup',
      redirectUrl: '/account/security?setup=mfa&redirect_to=%2Fconsole',
    })
    const db = makeDb()
    vi.mocked(createTenantDb).mockReturnValue(db)
    const app = makeApp(registerSessionAuthRoutes, { session: GUEST_SESSION() })

    const res = await post(app, makeEnv(), '/auth/otp/email/verify', {
      body: { email: 'new@example.com', code: '123456' },
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { redirectUrl?: string }
    expect(body.redirectUrl).toContain('/account/security')
    expect(db.sessions.insert).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pending_mfa_setup' }),
    )
    // 转正钩子仍然完成。
    expect(db.users.update).toHaveBeenCalledWith(
      { provisionedBy: 'hosted_passwordless' },
      expect.anything(),
    )
  })

  it('email 冲突:send 阶段响应与未占用时一致,不泄露占用事实', async () => {
    vi.mocked(resolveTargetUserId).mockResolvedValue('user-b')
    const db = makeDb()
    vi.mocked(createTenantDb).mockReturnValue(db)
    const app = makeApp(registerSessionAuthRoutes, { session: GUEST_SESSION() })

    const res = await post(app, makeEnv(), '/auth/otp/email/send', {
      body: { email: 'taken@example.com', turnstileToken: null },
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    // OTP 发给既有账号的证明流程;不把 email 挂到 guest,也不告知占用。
    expect(persistAndSendOtp).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-b' }))
    expect(db.userEmails.insert).not.toHaveBeenCalled()
  })

  it('email 冲突:verify 证明控制权后拒绝挂接,invalid_credentials 口径', async () => {
    vi.mocked(constantTimeEqualStr).mockReturnValue(true)
    vi.mocked(loadVerifiableOtp).mockResolvedValue({
      tokenHash: 'th-1',
      userId: 'user-b',
      codeHash: 'code-hash',
      flowContext: LOGIN_FLOW_CONTEXT,
    } as never)
    const db = makeDb()
    vi.mocked(createTenantDb).mockReturnValue(db)
    const app = makeApp(registerSessionAuthRoutes, { session: GUEST_SESSION() })

    const res = await post(app, makeEnv(), '/auth/otp/email/verify', {
      body: { email: 'taken@example.com', code: '123456' },
    })

    expect(((await res.json()) as { code: string }).code).toBe('invalid_credentials')
    expect(consumeVerifiableOtp).not.toHaveBeenCalled()
    expect(db.users.update).not.toHaveBeenCalled()
    expect(db.sessions.insert).not.toHaveBeenCalled()
  })

  it('跨租户:B 租户上下文查不到 A 租户 guest -> 落回建号路径', async () => {
    vi.mocked(resolveTargetUserId).mockResolvedValue(null)
    const db = makeDb({
      users: {
        // 租户查询层注入 tenant_id:A 租户 guest 在 B 租户 scoped db 下不可见。
        findOne: vi.fn().mockResolvedValue(null),
        insert: vi.fn().mockResolvedValue({ id: 'user-new' }),
        update: vi.fn().mockResolvedValue([]),
      },
    })
    vi.mocked(createTenantDb).mockReturnValue(db)
    const app = makeApp(registerSessionAuthRoutes, {
      session: GUEST_SESSION(),
      tenant: tenantWithEmailOtpCreation('tenant-b') as never,
    })

    const res = await post(app, makeEnv(), '/auth/otp/email/send', {
      body: { email: 'new@example.com', turnstileToken: null },
    })

    expect(res.status).toBe(200)
    expect(db.userEmails.insert).not.toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-guest' }),
    )
    expect(provisionAccountAtomically).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-b',
        user: expect.objectContaining({ provisionedBy: 'hosted_passwordless' }),
      }),
    )
    const sentInput = persistAndSendOtp.mock.calls[0]?.[0] as { userId: string } | undefined
    expect(sentInput?.userId).not.toBe('user-guest')
  })

  it('非 guest session(provisionedBy 非 anonymous)-> 走原建号路径零回归', async () => {
    vi.mocked(resolveTargetUserId).mockResolvedValue(null)
    const db = makeDb({
      users: {
        findOne: vi.fn().mockResolvedValue({
          id: 'user-reg',
          status: 'active',
          deletedAt: null,
          provisionedBy: 'hosted_password',
        }),
        insert: vi.fn().mockResolvedValue({ id: 'user-new' }),
        update: vi.fn().mockResolvedValue([]),
      },
    })
    vi.mocked(createTenantDb).mockReturnValue(db)
    const app = makeApp(registerSessionAuthRoutes, {
      session: makeSession('user-reg', 'sess-reg'),
      tenant: tenantWithEmailOtpCreation() as never,
    })

    const res = await post(app, makeEnv(), '/auth/otp/email/send', {
      body: { email: 'new@example.com', turnstileToken: null },
    })

    expect(res.status).toBe(200)
    expect(provisionAccountAtomically).toHaveBeenCalledWith(
      expect.objectContaining({
        user: expect.objectContaining({ provisionedBy: 'hosted_passwordless' }),
      }),
    )
  })
})

describe('guest 转正 -- password', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(resolvePostAuthMfaGate).mockResolvedValue({})
  })

  it('guest session + sign-up -> proof 前只挂 Email,不写 password 或默认 Membership', async () => {
    const db = makeDb({
      users: {
        // 第一次:resolveUserByIdentifier 的 externalId 兜底查 -> 无此人;
        // 之后:guest 判定 + issueSession 的 active user 查 -> live guest。
        findOne: vi.fn().mockResolvedValueOnce(undefined).mockResolvedValue(GUEST_ROW),
        insert: vi.fn().mockResolvedValue({ id: 'user-new' }),
        update: vi.fn().mockResolvedValue([]),
      },
    })
    vi.mocked(createTenantDb).mockReturnValue(db)
    const auditSend = vi.fn()
    const guestStore = makeGuestStoreFake()
    const env = makeEnv({ auditSend, guestStoreNs: guestStore.ns })
    const app = makeApp(registerSessionAuthRoutes, { session: GUEST_SESSION() })

    const res = await post(app, env, '/auth/password/sign-in', {
      body: { identifier: 'new@example.com', password: 'StrongPass123', turnstileToken: null },
      headers: { cookie: ANON_COOKIE },
    })

    expect(res.status).toBe(200)
    expect(((await res.json()) as { nextStep: string }).nextStep).toBe('verify_email')
    expect(db.users.insert).not.toHaveBeenCalled()
    expect(db.userEmails.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-guest',
        email: 'new@example.com',
        verified: false,
        isPrimary: true,
      }),
    )
    expect(db.passwords.insert).not.toHaveBeenCalled()
    expect(db.passwordHistory.insert).not.toHaveBeenCalled()
    expect(hashPassword).not.toHaveBeenCalled()
    expect(passwordReuseTag).not.toHaveBeenCalled()
    expect(db.memberships.insert).not.toHaveBeenCalled()
    expect(db.users.update).toHaveBeenCalledWith(
      { provisionedBy: 'hosted_password' },
      expect.anything(),
    )
    // proof 前吊销 guest session,但没有 password 凭证可签发新 session。
    expect(db.sessions.update).toHaveBeenCalledWith({ status: 'revoked' }, expect.anything())
    expect(db.sessions.insert).not.toHaveBeenCalled()
    // 既有 email 验证 token 流程照走。
    expect(issueEmailVerification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-guest', email: 'new@example.com' }),
    )
    expect(auditSend).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'guest.converted', actorId: 'user-guest' }),
    )
    expect(guestStore.calls).toContainEqual({ name: 'tenant-1:anon-x', action: 'unbind' })
  })

  it('email 冲突:目标 email 属于本租户其他 user -> invalid_credentials,不写任何行', async () => {
    vi.mocked(verifyPassword).mockResolvedValue(false)
    const db = makeDb({
      userEmails: {
        findOne: vi.fn().mockResolvedValue({ userId: 'user-b' }),
        insert: vi.fn(),
        update: vi.fn(),
      },
      users: {
        findOne: vi.fn().mockResolvedValue({
          id: 'user-b',
          status: 'active',
          lockoutUntil: null,
          deletedAt: null,
          primaryEmailId: 'em-b',
          provisionedBy: 'hosted_password',
        }),
        insert: vi.fn(),
        update: vi.fn(),
      },
      passwords: {
        findOne: vi.fn().mockResolvedValue({ hash: '$argon2id$existing', algo: 'argon2id' }),
        insert: vi.fn(),
        update: vi.fn(),
      },
    })
    vi.mocked(createTenantDb).mockReturnValue(db)
    const app = makeApp(registerSessionAuthRoutes, { session: GUEST_SESSION() })

    const res = await post(app, makeEnv(), '/auth/password/sign-in', {
      body: { identifier: 'taken@example.com', password: 'StrongPass123', turnstileToken: null },
    })

    expect(((await res.json()) as { code: string }).code).toBe('invalid_credentials')
    expect(db.users.insert).not.toHaveBeenCalled()
    expect(db.users.update).not.toHaveBeenCalled()
    expect(db.passwords.insert).not.toHaveBeenCalled()
    expect(db.sessions.insert).not.toHaveBeenCalled()
  })
})
