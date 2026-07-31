// verify-email 精确目标与 resend pending Email 单测。

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { sha256Hex } from '@xid-kit/crypto'

vi.mock('@xid-kit/i18n', () => ({ renderScopeDescription: (s: string) => s }))

vi.mock('@xid-kit/db', () => ({
  createTenantDb: vi.fn(),
  resolveTenantContextByIssuer: vi.fn(),
  USER_PROVISIONED_BY_ANONYMOUS: 'anonymous',
  schema: {
    users: { id: 'id' },
    userEmails: { id: 'id', userId: 'userId', isPrimary: 'isPrimary' },
    invitations: {
      id: 'id',
      email: 'email',
      status: 'status',
      expiresAt: 'expiresAt',
    },
    sessions: { id: 'id' },
    verificationTokens: { tokenHash: 'tokenHash' },
    passwords: { userId: 'userId' },
  },
}))

vi.mock('../email-verify-token', () => ({
  issueEmailVerification: vi.fn().mockResolvedValue(undefined),
  verifyEmailVerifyJwt: vi.fn(),
  loadEmailVerifyToken: vi.fn(),
}))

vi.mock('../../lib/session', () => ({
  ACTIVE_SESSION_STATUS: 'active',
  PENDING_MFA_SESSION_STATUS: 'pending_mfa',
  PENDING_MFA_SETUP_SESSION_STATUS: 'pending_mfa_setup',
  issueSession: vi.fn().mockResolvedValue({ session: { sessionId: 'session-victim' } }),
  readSession: vi.fn(),
  revokeSessionByIdentity: vi.fn().mockResolvedValue(undefined),
  sessionDoRevokeAll: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../lib/mfa-session', () => ({
  resolvePostAuthMfaGate: vi.fn().mockResolvedValue({}),
}))

vi.mock('../password-reset', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../password-reset')>()
  return {
    ...actual,
    issuePasswordResetToken: vi.fn().mockResolvedValue({
      token: 'setup.token.sig',
      expiresAt: new Date(Date.now() + 900_000),
    }),
  }
})

import { createTenantDb, resolveTenantContextByIssuer } from '@xid-kit/db'
import {
  issueEmailVerification,
  loadEmailVerifyToken,
  verifyEmailVerifyJwt,
} from '../email-verify-token'
import { readSession, sessionDoRevokeAll } from '../../lib/session'
import { AppError } from '../../lib/errors'
import { issuePasswordResetToken } from '../password-reset'
import { registerSessionAuthRoutes } from '../index'
import { execCtx, makeApp, makeEnv, makeSession, makeTenant } from './helpers'

type BoundStatement = { sql: string; params: unknown[] }

function makeD1(order?: string[]) {
  const batches: BoundStatement[][] = []
  const db = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          return { sql, params }
        },
      }
    },
    async batch(statements: BoundStatement[]) {
      order?.push('credential-reset-batch')
      batches.push(statements)
      return statements.map(() => ({
        success: true,
        results: [],
        meta: { changes: 1 },
      }))
    },
  } as unknown as D1Database
  return { db, batches }
}

function post(app: ReturnType<typeof makeApp>, env: Env, path: string, body?: unknown) {
  return app.request(
    path,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env,
    execCtx,
  )
}

function unsignedJwtPayload(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `header.${body}.signature`
}

function tokenRow(userId = 'user-1') {
  return {
    id: 'token-1',
    tenantId: 'tenant-1',
    userId,
    tokenHash: 'token-hash',
    purpose: 'email_verification',
    consumedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
  }
}

function mockVerificationDb(options: {
  email?: string
  pendingEmail?: string | null
  provisionedBy?: string | null
  hasPassword?: boolean
}) {
  const email = options.email
  const emailFindOne = vi.fn().mockResolvedValue(
    email
      ? {
          id: 'email-1',
          userId: 'user-1',
          email,
          verified: false,
          isPrimary: true,
        }
      : null,
  )
  vi.mocked(createTenantDb).mockReturnValue({
    users: {
      findOne: vi.fn().mockResolvedValue({
        id: 'user-1',
        status: 'active',
        deletedAt: null,
        primaryEmailId: email ? 'email-1' : null,
        pendingEmail: options.pendingEmail ?? null,
        provisionedBy: options.provisionedBy ?? 'hosted_password',
      }),
    },
    userEmails: { findOne: emailFindOne },
    passwords: {
      findOne: vi
        .fn()
        .mockResolvedValue(options.hasPassword === false ? undefined : { id: 'password-1' }),
    },
  } as unknown as ReturnType<typeof createTenantDb>)
}

describe('POST /auth/verify-email', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(loadEmailVerifyToken).mockResolvedValue(tokenRow() as never)
    vi.mocked(issuePasswordResetToken).mockResolvedValue({
      token: 'setup.token.sig',
      expiresAt: new Date(Date.now() + 900_000),
    })
  })

  it('signed email_hash 只验证绑定的 primary Email', async () => {
    const emailHash = await sha256Hex('owner@example.com')
    vi.mocked(verifyEmailVerifyJwt).mockResolvedValue({
      jti: 'jti-1',
      userId: 'user-1',
      emailHash,
      intent: null,
    })
    mockVerificationDb({ email: 'owner@example.com' })
    const { db, batches } = makeD1()
    const app = makeApp(registerSessionAuthRoutes)
    const res = await post(app, { ...makeEnv(), DB: db }, '/auth/verify-email', {
      token: 'valid.jwt.sig',
    })

    expect(res.status).toBe(200)
    expect(batches[0]?.[0]?.sql).toContain('UPDATE verification_tokens')
    expect(batches[0]?.[1]?.sql).toContain('UPDATE user_emails')
    expect(batches[0]?.[1]?.params).toContain('email-1')
    expect(batches[0]?.[1]?.params).toContain('owner@example.com')
  })

  it('pending Email 验证后原子创建 primary Email 并转正 guest', async () => {
    const emailHash = await sha256Hex('guest@example.com')
    vi.mocked(verifyEmailVerifyJwt).mockResolvedValue({
      jti: 'jti-1',
      userId: 'user-1',
      emailHash,
      intent: null,
    })
    mockVerificationDb({
      pendingEmail: 'guest@example.com',
      provisionedBy: 'anonymous',
    })
    vi.mocked(readSession).mockResolvedValue(makeSession('user-1', 'session-1'))
    const { db, batches } = makeD1()
    const app = makeApp(registerSessionAuthRoutes, { session: null })
    const res = await post(app, { ...makeEnv(), DB: db }, '/auth/verify-email', {
      token: 'valid.jwt.sig',
    })

    expect(res.status).toBe(200)
    expect(sessionDoRevokeAll).toHaveBeenCalledWith(expect.anything(), 'user-1')
    expect(batches[0]?.some((statement) => statement.sql.includes('pending_email = NULL'))).toBe(
      true,
    )
    expect(batches[0]?.some((statement) => statement.sql.includes('INSERT INTO user_emails'))).toBe(
      true,
    )
    expect(batches[0]?.some((statement) => statement.sql.includes("status = 'revoked'"))).toBe(true)
  })

  it('hosted password Email proof 后才签发一次性 password setup continuation', async () => {
    const order: string[] = []
    const emailHash = await sha256Hex('owner@example.com')
    vi.mocked(verifyEmailVerifyJwt).mockResolvedValue({
      jti: 'jti-1',
      userId: 'user-1',
      emailHash,
      intent: null,
    })
    mockVerificationDb({
      email: 'owner@example.com',
      provisionedBy: 'hosted_password',
      hasPassword: false,
    })
    vi.mocked(issuePasswordResetToken).mockImplementationOnce(async () => {
      order.push('password-setup-token')
      return {
        token: 'setup.token.sig',
        expiresAt: new Date(Date.now() + 900_000),
      }
    })
    const { db, batches } = makeD1(order)
    const app = makeApp(registerSessionAuthRoutes)

    const res = await post(app, { ...makeEnv(), DB: db }, '/auth/verify-email', {
      token: 'valid.jwt.sig',
    })

    expect(res.status).toBe(200)
    expect(order).toEqual(['credential-reset-batch', 'password-setup-token'])
    expect(batches[0]?.some((statement) => statement.sql.includes('INSERT INTO memberships'))).toBe(
      true,
    )
    expect(issuePasswordResetToken).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        tenant: expect.objectContaining({ tenantId: 'tenant-1' }),
      }),
    )
    expect(await res.json()).toEqual({
      ok: true,
      redirectUrl: '/reset-password?token=setup.token.sig',
    })
  })

  it('email_hash 与当前目标不一致时拒绝且不消费 token', async () => {
    vi.mocked(verifyEmailVerifyJwt).mockResolvedValue({
      jti: 'jti-1',
      userId: 'user-1',
      emailHash: await sha256Hex('other@example.com'),
      intent: null,
    })
    mockVerificationDb({ email: 'owner@example.com' })
    const { db, batches } = makeD1()
    const app = makeApp(registerSessionAuthRoutes)
    const res = await post(app, { ...makeEnv(), DB: db }, '/auth/verify-email', {
      token: 'valid.jwt.sig',
    })

    expect((await res.json()) as { code: string }).toMatchObject({ code: 'token_invalid' })
    expect(batches).toHaveLength(0)
  })

  it('拒绝 legacy invitation verification token 且不读取或消费持久化 token', async () => {
    vi.mocked(verifyEmailVerifyJwt).mockResolvedValue({
      jti: 'jti-legacy',
      userId: 'user-1',
      emailHash: await sha256Hex('owner@example.com'),
      intent: null,
      continuePath: null,
      applicationClientId: null,
      invitationId: 'invitation-legacy',
    })
    const app = makeApp(registerSessionAuthRoutes)
    const { db, batches } = makeD1()

    const res = await post(app, { ...makeEnv(), DB: db }, '/auth/verify-email', {
      token: 'legacy.jwt.sig',
    })

    expect((await res.json()) as { code: string }).toMatchObject({ code: 'token_invalid' })
    expect(loadEmailVerifyToken).not.toHaveBeenCalled()
    expect(createTenantDb).not.toHaveBeenCalled()
    expect(batches).toHaveLength(0)
  })

  it('signed email_hash 不匹配 pending Email 时拒绝', async () => {
    vi.mocked(verifyEmailVerifyJwt).mockResolvedValue({
      jti: 'jti-1',
      userId: 'user-1',
      emailHash: await sha256Hex('other@example.com'),
      intent: null,
    })
    mockVerificationDb({ pendingEmail: 'guest@example.com', provisionedBy: 'anonymous' })
    const { db, batches } = makeD1()
    const app = makeApp(registerSessionAuthRoutes)
    const res = await post(app, { ...makeEnv(), DB: db }, '/auth/verify-email', {
      token: 'valid.jwt.sig',
    })

    expect((await res.json()) as { code: string }).toMatchObject({ code: 'token_invalid' })
    expect(batches).toHaveLength(0)
  })

  it('root 入口按 signed tenant_id hint 解析目标 Tenant', async () => {
    const resolvedTenant = makeTenant('tenant-resolved', 'https://xid.dev')
    resolvedTenant.issuer = 'https://xid.dev'
    vi.mocked(resolveTenantContextByIssuer).mockResolvedValue({
      ok: true,
      value: { status: 'resolved', tenant: resolvedTenant },
    } as never)
    vi.mocked(verifyEmailVerifyJwt).mockResolvedValue({
      jti: 'jti-1',
      userId: 'user-1',
      emailHash: await sha256Hex('owner@example.com'),
      intent: null,
    })
    mockVerificationDb({ email: 'owner@example.com' })
    const rootTenant = {
      ...makeTenant('tenant-entry', 'https://xid.dev'),
      rpId: 'xid.dev',
      resolution: { kind: 'instance_entry', primaryDomain: 'xid.dev', unresolvedRoot: true },
    }
    const app = makeApp(registerSessionAuthRoutes, { tenant: rootTenant as never })
    const { db } = makeD1()
    const env = { ...makeEnv(), DB: db }
    const token = unsignedJwtPayload({
      iss: 'https://xid.dev',
      sub: 'user-1',
      jti: 'jti-1',
      purpose: 'email_verification',
      tenant_id: 'tenant-resolved',
    })

    const res = await post(app, env, 'https://xid.dev/auth/verify-email', { token })

    expect(res.status).toBe(200)
    expect(resolveTenantContextByIssuer).toHaveBeenCalledWith(
      expect.any(Request),
      env,
      'https://xid.dev',
      { tenantId: 'tenant-resolved' },
    )
    expect(createTenantDb).toHaveBeenCalledWith(env.DB, resolvedTenant)
  })

  it('signed sign-up intent returns the organization onboarding sign-in target', async () => {
    vi.mocked(verifyEmailVerifyJwt).mockResolvedValue({
      jti: 'jti-1',
      userId: 'user-1',
      emailHash: await sha256Hex('owner@example.com'),
      intent: 'sign-up',
    })
    mockVerificationDb({ email: 'owner@example.com' })
    const { db } = makeD1()
    const app = makeApp(registerSessionAuthRoutes)

    const res = await post(app, { ...makeEnv(), DB: db }, '/auth/verify-email', {
      token: 'valid.jwt.sig',
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      ok: true,
      redirectUrl: '/sign-in?intent=sign-up',
    })
  })

  it('过期和无效 token 保持原错误契约', async () => {
    vi.mocked(verifyEmailVerifyJwt).mockRejectedValueOnce(new AppError('token_expired'))
    const app = makeApp(registerSessionAuthRoutes)
    const expired = await post(app, makeEnv(), '/auth/verify-email', { token: 'expired.jwt' })
    expect((await expired.json()) as { code: string }).toMatchObject({ code: 'token_expired' })

    vi.mocked(verifyEmailVerifyJwt).mockRejectedValueOnce(new AppError('token_invalid'))
    const invalid = await post(app, makeEnv(), '/auth/verify-email', { token: 'forged.jwt' })
    expect((await invalid.json()) as { code: string }).toMatchObject({ code: 'token_invalid' })
  })
})

describe('POST /auth/resend-verification', () => {
  beforeEach(() => vi.clearAllMocks())

  it('无 session 时静默 200', async () => {
    vi.mocked(readSession).mockResolvedValue(null)
    const app = makeApp(registerSessionAuthRoutes, { session: null })
    const res = await post(app, makeEnv(), '/auth/resend-verification')
    expect(res.status).toBe(200)
    expect(issueEmailVerification).not.toHaveBeenCalled()
  })

  it('pending Email 可签发精确目标 token', async () => {
    vi.mocked(createTenantDb).mockReturnValue({
      users: {
        findOne: vi.fn().mockResolvedValue({
          id: 'user-1',
          status: 'active',
          deletedAt: null,
          primaryEmailId: null,
          pendingEmail: 'guest@example.com',
        }),
      },
      userEmails: { findOne: vi.fn().mockResolvedValue(null) },
    } as unknown as ReturnType<typeof createTenantDb>)
    const app = makeApp(registerSessionAuthRoutes, { session: makeSession() })
    const res = await post(app, makeEnv(), '/auth/resend-verification')

    expect(res.status).toBe(200)
    expect(issueEmailVerification).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'guest@example.com', userId: 'user-1' }),
    )
  })

  it('已验证 primary Email 静默 200 且不发信', async () => {
    vi.mocked(createTenantDb).mockReturnValue({
      users: {
        findOne: vi.fn().mockResolvedValue({
          id: 'user-1',
          status: 'active',
          deletedAt: null,
          primaryEmailId: 'email-1',
          pendingEmail: null,
        }),
      },
      userEmails: {
        findOne: vi.fn().mockResolvedValue({
          id: 'email-1',
          email: 'owner@example.com',
          verified: true,
        }),
      },
    } as unknown as ReturnType<typeof createTenantDb>)
    const app = makeApp(registerSessionAuthRoutes, { session: makeSession() })
    const res = await post(app, makeEnv(), '/auth/resend-verification')
    expect(res.status).toBe(200)
    expect(issueEmailVerification).not.toHaveBeenCalled()
  })
})
