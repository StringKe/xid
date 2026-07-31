// POST /auth/mfa/sms/send + /auth/mfa/verify 单测:
// 无 session -> 401(unauthorized);sms/send happy -> 200;verify totp/backup happy -> 200;
// verify 失败 -> otp_invalid;stepUp=true -> 颁发 acr cookie;限流 -> 429。

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@xid-kit/i18n', () => ({ renderScopeDescription: (s: string) => s }))

vi.mock('@xid-kit/crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xid-kit/crypto')>()
  return { ...actual, sha256Hex: vi.fn().mockResolvedValue('code-hash') }
})

vi.mock('@xid-kit/db', () => ({
  createTenantDb: vi.fn(),
  schema: {
    userPhones: { userId: 'userId', verified: 'verified' },
    mfaFactors: { userId: 'userId', factorType: 'factorType', status: 'status' },
    verificationTokens: { tokenHash: 'tokenHash' },
    sessions: { id: 'id' },
  },
}))

vi.mock('../../auth/mfa', () => ({
  verifyTotp: vi.fn(),
  issueStepUpToken: vi.fn().mockResolvedValue({ token: 'stepup.token.sig' }),
}))

vi.mock('../../auth/backup-codes', () => ({ verifyAndConsumeBackupCode: vi.fn() }))

vi.mock('../../auth/otp', () => ({
  consumeVerifiableOtp: vi.fn().mockResolvedValue(true),
  constantTimeEqualStr: vi.fn().mockReturnValue(true),
  loadVerifiableOtp: vi.fn(),
  persistAndSendOtp: vi.fn().mockResolvedValue(undefined),
  recordOtpFailure: vi.fn(),
}))

vi.mock('../../lib/session', () => ({
  readSession: vi.fn(),
  ACTIVE_SESSION_STATUS: 'active',
  PENDING_MFA_SESSION_STATUS: 'pending_mfa',
  PENDING_MFA_SETUP_SESSION_STATUS: 'pending_mfa_setup',
}))

import { createTenantDb } from '@xid-kit/db'
import { issueStepUpToken, verifyTotp } from '../../auth/mfa'
import { verifyAndConsumeBackupCode } from '../../auth/backup-codes'
import { constantTimeEqualStr, loadVerifiableOtp, recordOtpFailure } from '../../auth/otp'
import { readSession } from '../../lib/session'
import type { TenantVar } from '../../lib/types'
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

function tenantWithSmsDelivery() {
  const tenant = makeTenant()
  tenant.policy.deliveryChannels = {
    sms: {
      provider: 'twilio',
      enabled: true,
      secretRefs: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'],
    },
  }
  return tenant
}

describe('POST /auth/mfa/sms/send', () => {
  beforeEach(() => vi.clearAllMocks())

  it('无 session -> 401', async () => {
    vi.mocked(readSession).mockResolvedValue(null)
    const app = makeApp(registerSessionAuthRoutes, { session: null })
    const res = await post(app, makeEnv(), '/auth/mfa/sms/send')
    expect(res.status).toBe(401)
  })

  it('session + 已验证手机号 -> 200', async () => {
    vi.mocked(createTenantDb).mockReturnValue({
      userPhones: { findOne: vi.fn().mockResolvedValue({ phone: '+15551234567' }) },
    } as unknown as ReturnType<typeof createTenantDb>)
    const app = makeApp(registerSessionAuthRoutes, {
      session: makeSession(),
      tenant: tenantWithSmsDelivery() as never,
    })
    const res = await post(app, makeEnv({ smsProvider: 'twilio' }), '/auth/mfa/sms/send')
    expect(res.status).toBe(200)
  })

  it('session + 已验证手机号但 SMS provider 未配置 -> 400', async () => {
    vi.mocked(createTenantDb).mockReturnValue({
      userPhones: { findOne: vi.fn().mockResolvedValue({ phone: '+15551234567' }) },
    } as unknown as ReturnType<typeof createTenantDb>)
    const app = makeApp(registerSessionAuthRoutes, { session: makeSession() })
    const res = await post(app, makeEnv(), '/auth/mfa/sms/send')
    expect(res.status).toBe(400)
  })
})

describe('POST /auth/mfa/verify', () => {
  beforeEach(() => vi.clearAllMocks())

  it('无 session -> 401', async () => {
    vi.mocked(readSession).mockResolvedValue(null)
    const app = makeApp(registerSessionAuthRoutes, { session: null })
    const res = await post(app, makeEnv(), '/auth/mfa/verify', { method: 'totp', code: '123456' })
    expect(res.status).toBe(401)
  })

  it('totp 正确 -> 200(非 stepUp:touch session)', async () => {
    vi.mocked(verifyTotp).mockResolvedValue({ ok: true })
    const update = vi.fn().mockResolvedValue([])
    vi.mocked(createTenantDb).mockReturnValue({
      mfaFactors: { findOne: vi.fn().mockResolvedValue({ id: 'factor-1' }) },
      sessions: { update },
    } as unknown as ReturnType<typeof createTenantDb>)
    const app = makeApp(registerSessionAuthRoutes, { session: makeSession() })
    const res = await post(app, makeEnv(), '/auth/mfa/verify', { method: 'totp', code: '123456' })
    expect(res.status).toBe(200)
    expect(update.mock.calls[0]?.[0]).toMatchObject({
      status: 'active',
      acr: 'urn:xid:aal2',
      amr: ['pwd', 'otp', 'mfa'],
      aal: 2,
    })
  })

  it('pending MFA session 先反解 organization tenant 再验证 TOTP', async () => {
    const entryTenant = makeTenant('org_default') as unknown as TenantVar
    const sessionTenant = makeTenant('org_selected') as unknown as TenantVar
    const session = makeSession()
    vi.mocked(readSession).mockImplementation(async (c) => {
      c.set('tenant', sessionTenant)
      return session
    })
    vi.mocked(verifyTotp).mockResolvedValue({ ok: true })
    const update = vi.fn().mockResolvedValue([])
    vi.mocked(createTenantDb).mockReturnValue({
      mfaFactors: { findOne: vi.fn().mockResolvedValue({ id: 'factor-1' }) },
      sessions: { update },
    } as unknown as ReturnType<typeof createTenantDb>)
    const app = makeApp(registerSessionAuthRoutes, { tenant: entryTenant, session: null })

    const res = await post(app, makeEnv(), '/auth/mfa/verify', {
      method: 'totp',
      code: '123456',
    })

    expect(res.status).toBe(200)
    expect(verifyTotp).toHaveBeenCalledWith(
      expect.objectContaining({ ctx: sessionTenant, userId: session.userId }),
    )
  })

  it('totp 错误 -> otp_invalid', async () => {
    vi.mocked(verifyTotp).mockResolvedValue({ ok: false, reason: 'invalid_code' })
    vi.mocked(createTenantDb).mockReturnValue({
      mfaFactors: { findOne: vi.fn().mockResolvedValue({ id: 'factor-1' }) },
    } as unknown as ReturnType<typeof createTenantDb>)
    const app = makeApp(registerSessionAuthRoutes, { session: makeSession() })
    const res = await post(app, makeEnv(), '/auth/mfa/verify', { method: 'totp', code: '000000' })
    expect(((await res.json()) as { code: string }).code).toBe('otp_invalid')
  })

  it('backup 正确 -> 200', async () => {
    vi.mocked(verifyAndConsumeBackupCode).mockResolvedValue({ ok: true, codeId: 'bc-1' })
    vi.mocked(createTenantDb).mockReturnValue({
      sessions: { update: vi.fn().mockResolvedValue([]) },
    } as unknown as ReturnType<typeof createTenantDb>)
    const app = makeApp(registerSessionAuthRoutes, { session: makeSession() })
    const res = await post(app, makeEnv(), '/auth/mfa/verify', {
      method: 'backup',
      code: 'ABCD2345',
    })
    expect(res.status).toBe(200)
  })

  it('sms verify 在 provider 未配置时拒绝', async () => {
    vi.mocked(loadVerifiableOtp).mockResolvedValue({
      tokenHash: 'token-hash',
      codeHash: 'code-hash',
    } as never)
    vi.mocked(createTenantDb).mockReturnValue({
      userPhones: { findOne: vi.fn().mockResolvedValue({ phone: '+15551234567' }) },
    } as unknown as ReturnType<typeof createTenantDb>)
    const app = makeApp(registerSessionAuthRoutes, { session: makeSession() })
    const res = await post(app, makeEnv(), '/auth/mfa/verify', {
      method: 'sms',
      code: '123456',
    })

    expect(res.status).toBe(400)
    expect(((await res.json()) as { code: string }).code).toBe('otp_invalid')
  })

  it('sms verify 错码记录失败并拒绝', async () => {
    vi.mocked(constantTimeEqualStr).mockReturnValue(false)
    vi.mocked(loadVerifiableOtp).mockResolvedValue({
      tokenHash: 'token-hash',
      codeHash: 'other-hash',
    } as never)
    const hardDelete = vi.fn().mockResolvedValue(undefined)
    vi.mocked(createTenantDb).mockReturnValue({
      userPhones: { findOne: vi.fn().mockResolvedValue({ phone: '+15551234567' }) },
      verificationTokens: { hardDelete },
    } as unknown as ReturnType<typeof createTenantDb>)
    const app = makeApp(registerSessionAuthRoutes, {
      session: makeSession(),
      tenant: tenantWithSmsDelivery() as never,
    })
    const res = await post(app, makeEnv({ smsProvider: 'twilio' }), '/auth/mfa/verify', {
      method: 'sms',
      code: '123456',
    })

    expect(res.status).toBe(400)
    expect(((await res.json()) as { code: string }).code).toBe('otp_invalid')
    expect(recordOtpFailure).toHaveBeenCalledOnce()
    expect(hardDelete).not.toHaveBeenCalled()
  })

  it('stepUp=true -> 颁发 acr step-up token 并设 cookie', async () => {
    vi.mocked(verifyTotp).mockResolvedValue({ ok: true })
    vi.mocked(createTenantDb).mockReturnValue({
      mfaFactors: { findOne: vi.fn().mockResolvedValue({ id: 'factor-1' }) },
    } as unknown as ReturnType<typeof createTenantDb>)
    const app = makeApp(registerSessionAuthRoutes, { session: makeSession() })
    const res = await post(app, makeEnv(), '/auth/mfa/verify', {
      method: 'totp',
      code: '123456',
      stepUp: true,
    })
    expect(res.status).toBe(200)
    expect(issueStepUpToken).toHaveBeenCalledOnce()
    expect(issueStepUpToken).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'totp', sessionId: 'sess-1', userId: 'user-1' }),
    )
    expect(res.headers.get('set-cookie')).toContain('__Host-xid.acr=')
  })

  it('限流 -> 429', async () => {
    const app = makeApp(registerSessionAuthRoutes, { session: makeSession() })
    const res = await post(app, makeEnv({ rateLimitAllowed: false }), '/auth/mfa/verify', {
      method: 'totp',
      code: '123456',
    })
    expect(res.status).toBe(429)
  })
})
