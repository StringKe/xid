// POST /auth/verify-email + /auth/resend-verification 单测:
// verify:happy -> 200 + 置 verified;token 过期 -> token_expired;无效 -> token_invalid。
// resend:无 session -> 200(枚举防护);session + 未验证邮箱 -> 200 + 发信;已验证 -> 200 静默不发。

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@xid-kit/i18n', () => ({ renderScopeDescription: (s: string) => s }))

vi.mock('@xid-kit/db', () => ({
  createTenantDb: vi.fn(),
  resolveTenantContextByIssuer: vi.fn(),
  schema: {
    userEmails: { userId: 'userId', isPrimary: 'isPrimary' },
    verificationTokens: { tokenHash: 'tokenHash' },
  },
}))

vi.mock('../email-verify-token', () => ({
  issueEmailVerification: vi.fn().mockResolvedValue(undefined),
  verifyEmailVerifyJwt: vi.fn(),
  consumeEmailVerifyToken: vi.fn(),
}))

vi.mock('../../lib/session', () => ({ readSession: vi.fn() }))

import { createTenantDb, resolveTenantContextByIssuer } from '@xid-kit/db'
import {
  consumeEmailVerifyToken,
  issueEmailVerification,
  verifyEmailVerifyJwt,
} from '../email-verify-token'
import { readSession } from '../../lib/session'
import { AppError } from '../../lib/errors'
import { registerSessionAuthRoutes } from '../index'
import { execCtx, makeApp, makeEnv, makeSession, makeTenant } from './helpers'

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

describe('POST /auth/verify-email', () => {
  beforeEach(() => vi.clearAllMocks())

  it('有效 token -> 200 + 置 verified', async () => {
    vi.mocked(verifyEmailVerifyJwt).mockResolvedValue('jti-1')
    vi.mocked(consumeEmailVerifyToken).mockResolvedValue('user-1')
    const update = vi.fn().mockResolvedValue([])
    vi.mocked(createTenantDb).mockReturnValue({
      userEmails: { update },
    } as unknown as ReturnType<typeof createTenantDb>)
    const app = makeApp(registerSessionAuthRoutes)
    const res = await post(app, makeEnv(), '/auth/verify-email', { token: 'valid.jwt.sig' })
    expect(res.status).toBe(200)
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ verified: true }),
      expect.anything(),
    )
  })

  it('root 入口 instance issuer token -> 按 tenant_id hint 验证邮箱', async () => {
    const resolvedTenant = makeTenant('tenant-resolved', 'https://xid.dev')
    resolvedTenant.issuer = 'https://xid.dev'
    vi.mocked(resolveTenantContextByIssuer).mockResolvedValue({
      ok: true,
      value: { status: 'resolved', tenant: resolvedTenant },
    } as never)
    vi.mocked(verifyEmailVerifyJwt).mockResolvedValue('jti-1')
    vi.mocked(consumeEmailVerifyToken).mockResolvedValue('user-1')
    const update = vi.fn().mockResolvedValue([])
    vi.mocked(createTenantDb).mockReturnValue({
      userEmails: { update },
    } as unknown as ReturnType<typeof createTenantDb>)
    const rootTenant = {
      ...makeTenant('tenant-entry', 'https://xid.dev'),
      rpId: 'xid.dev',
      resolution: { kind: 'instance_entry', primaryDomain: 'xid.dev', unresolvedRoot: true },
    }
    const app = makeApp(registerSessionAuthRoutes, { tenant: rootTenant as never })
    const env = makeEnv()
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

  it('过期 token -> token_expired', async () => {
    vi.mocked(verifyEmailVerifyJwt).mockRejectedValue(new AppError('token_expired'))
    const app = makeApp(registerSessionAuthRoutes)
    const res = await post(app, makeEnv(), '/auth/verify-email', { token: 'expired.jwt' })
    expect(((await res.json()) as { code: string }).code).toBe('token_expired')
  })

  it('无效 token -> token_invalid', async () => {
    vi.mocked(verifyEmailVerifyJwt).mockRejectedValue(new AppError('token_invalid'))
    const app = makeApp(registerSessionAuthRoutes)
    const res = await post(app, makeEnv(), '/auth/verify-email', { token: 'forged.jwt' })
    expect(((await res.json()) as { code: string }).code).toBe('token_invalid')
  })
})

describe('POST /auth/resend-verification', () => {
  beforeEach(() => vi.clearAllMocks())

  it('无 session -> 200(枚举防护,不发信)', async () => {
    vi.mocked(readSession).mockResolvedValue(null)
    const app = makeApp(registerSessionAuthRoutes, { session: null })
    const res = await post(app, makeEnv(), '/auth/resend-verification')
    expect(res.status).toBe(200)
    expect(issueEmailVerification).not.toHaveBeenCalled()
  })

  it('session + 未验证邮箱 -> 200 + 签发验证 token', async () => {
    vi.mocked(createTenantDb).mockReturnValue({
      userEmails: {
        findOne: vi.fn().mockResolvedValue({ email: 'u@example.com', verified: false }),
      },
    } as unknown as ReturnType<typeof createTenantDb>)
    const app = makeApp(registerSessionAuthRoutes, { session: makeSession() })
    const res = await post(app, makeEnv(), '/auth/resend-verification')
    expect(res.status).toBe(200)
    expect(issueEmailVerification).toHaveBeenCalledOnce()
  })

  it('session + 已验证邮箱 -> 200 静默不发(枚举防护)', async () => {
    vi.mocked(createTenantDb).mockReturnValue({
      userEmails: {
        findOne: vi.fn().mockResolvedValue({ email: 'u@example.com', verified: true }),
      },
    } as unknown as ReturnType<typeof createTenantDb>)
    const app = makeApp(registerSessionAuthRoutes, { session: makeSession() })
    const res = await post(app, makeEnv(), '/auth/resend-verification')
    expect(res.status).toBe(200)
    expect(issueEmailVerification).not.toHaveBeenCalled()
  })
})
