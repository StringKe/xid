// passwordless 单测:magic-link/send(枚举防护 200)/ otp/email/send(不存在 200)/
// otp/email/verify(happy 200 签发 session)/ otp/whatsapp|sms/send(国家白名单)/ 跨租户(B 查不到 A target)。

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DEFAULT_HOSTED_AUTH_PROFILE_FIELDS } from '@xid-kit/types'

vi.mock('@xid-kit/i18n', () => ({ renderScopeDescription: (s: string) => s }))

vi.mock('@xid-kit/crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xid-kit/crypto')>()
  return {
    ...actual,
    base64UrlDecodeToString: (s: string) => Buffer.from(s, 'base64url').toString('utf8'),
    sha256Hex: vi.fn().mockResolvedValue('code-hash'),
    verifyJwt: vi.fn(),
  }
})

vi.mock('@xid-kit/db', () => ({
  createTenantDb: vi.fn(),
  resolveInstanceLogin: vi.fn(),
  resolveInstanceLoginCandidates: vi.fn(),
  resolveTenantContextById: vi.fn(),
  resolveTenantContextByIssuer: vi.fn(),
  schema: {
    verificationTokens: { tokenHash: 'tokenHash' },
    magicLinkTokens: {
      tokenHash: 'tokenHash',
      consumedAt: 'consumedAt',
      expiresAt: 'expiresAt',
      userId: 'userId',
    },
    userEmails: { userId: 'userId', isPrimary: 'isPrimary' },
    userPhones: { userId: 'userId', isPrimary: 'isPrimary' },
    users: { id: 'id', status: 'status', deletedAt: 'deletedAt' },
    sessions: { id: 'id', userId: 'userId' },
    memberships: { userId: 'userId', status: 'status', orgId: 'orgId' },
    organizations: { id: 'id', status: 'status', deletedAt: 'deletedAt' },
  },
}))

vi.mock('../../oidc/shared', () => ({
  buildVerifyKeySet: vi.fn().mockResolvedValue({ keys: [] }),
  loadActiveSigner: vi.fn().mockResolvedValue({ kid: 'k1', alg: 'ES256', privateKey: {} }),
}))

vi.mock('../../auth/magic-link', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../auth/magic-link')>()
  return { ...actual, sendMagicLink: vi.fn().mockResolvedValue(undefined) }
})

vi.mock('../../auth/account-provisioning', () => ({
  provisionAccountAtomically: vi.fn(async (input: { user: { id: string } }) => input.user.id),
}))

vi.mock('../../lib/mfa-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/mfa-session')>()
  return { ...actual, resolvePostAuthMfaGate: vi.fn().mockResolvedValue({}) }
})

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

import {
  createTenantDb,
  resolveInstanceLogin,
  resolveTenantContextById,
  resolveTenantContextByIssuer,
} from '@xid-kit/db'
import { verifyJwt } from '@xid-kit/crypto'
import { sendMagicLink } from '../../auth/magic-link'
import { provisionAccountAtomically } from '../../auth/account-provisioning'
import {
  constantTimeEqualStr,
  loadVerifiableOtp,
  persistAndSendOtp,
  reserveOtpSendRateLimit,
  resolveTargetUserId,
} from '../../auth/otp'
import { resolvePostAuthMfaGate } from '../../lib/mfa-session'
import { registerSessionAuthRoutes } from '../index'
import { execCtx, makeApp, makeEnv, makeTenant } from './helpers'

const LOGIN_FLOW_CONTEXT = JSON.stringify({
  version: 1,
  intent: null,
  continuePath: '/console',
  applicationClientId: null,
  invitationId: null,
})
const PRODUCT_SIGN_UP_FLOW_CONTEXT = JSON.stringify({
  version: 1,
  intent: 'sign-up',
  continuePath: '/create-organization',
  applicationClientId: null,
  invitationId: null,
})

function post(app: ReturnType<typeof makeApp>, env: Env, path: string, body: unknown) {
  return app.request(
    path,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    env,
    execCtx,
  )
}

function get(app: ReturnType<typeof makeApp>, env: Env, path: string, headers?: HeadersInit) {
  const url = path.startsWith('http') ? path : `https://tenant-1.xid.dev${path}`
  return app.request(url, { method: 'GET', ...(headers ? { headers } : {}) }, env, execCtx)
}

function setVerifyOk(payload: Record<string, unknown>): void {
  const verifiedPayload =
    payload['purpose'] === 'magic_link' && payload['flow_context'] === undefined
      ? { ...payload, flow_context: LOGIN_FLOW_CONTEXT }
      : payload
  vi.mocked(verifyJwt).mockResolvedValue({
    ok: true,
    value: { header: {}, payload: verifiedPayload },
  } as never)
}

function setVerifyFail(reason: string): void {
  vi.mocked(verifyJwt).mockResolvedValue({ ok: false, error: { reason } } as never)
}

function unsignedJwtPayload(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `header.${body}.signature`
}

function sessionDb(overrides: Record<string, unknown> = {}) {
  return {
    verificationTokens: { hardDelete: vi.fn().mockResolvedValue(undefined) },
    magicLinkTokens: {
      findOne: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue([]),
      hardDelete: vi.fn().mockResolvedValue(undefined),
      insert: vi.fn().mockResolvedValue(undefined),
    },
    users: {
      findOne: vi.fn().mockResolvedValue({ id: 'user-1', status: 'active', deletedAt: null }),
      insert: vi.fn().mockResolvedValue({ id: 'user-new' }),
    },
    userEmails: {
      insert: vi.fn().mockResolvedValue({ id: 'email-new' }),
      update: vi.fn().mockResolvedValue([]),
    },
    userPhones: {
      insert: vi.fn().mockResolvedValue({ id: 'phone-new' }),
      update: vi.fn().mockResolvedValue([]),
    },
    memberships: {
      findMany: vi
        .fn()
        .mockResolvedValue([
          { id: 'mem-1', userId: 'user-1', orgId: 'tenant-1', status: 'active' },
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
        userId: 'user-1',
        activeOrgId: 'tenant-1',
        authenticatedAt: new Date(),
        expiresAt: new Date(Date.now() + 86400000),
        rememberMe: false,
        isImpersonation: false,
        impersonatorUserId: null,
      }),
    },
    ...overrides,
  } as unknown as ReturnType<typeof createTenantDb>
}

function tenantWithEmailOtpCreation(): ReturnType<typeof makeTenant> {
  const tenant = makeTenant()
  Object.assign(tenant.policy.hostedAuth, {
    profileFields: DEFAULT_HOSTED_AUTH_PROFILE_FIELDS,
  })
  tenant.policy.hostedAuth.emailOtp = { enabled: true, allowLogin: true, allowUserCreation: true }
  return tenant
}

function tenantWithIdentifierMode(mode: 'email' | 'username' | 'email_or_username' | 'phone') {
  const tenant = makeTenant()
  Object.assign(tenant.policy.hostedAuth, {
    profileFields: DEFAULT_HOSTED_AUTH_PROFILE_FIELDS,
  })
  tenant.policy.hostedAuth.identifierMode = mode
  return tenant
}

function tenantWithPhoneOtpCreation(
  method: 'smsOtp' | 'whatsappOtp',
  profileFields: Partial<typeof DEFAULT_HOSTED_AUTH_PROFILE_FIELDS> = {},
) {
  const tenant = tenantWithPhoneModeAndDelivery(method)
  tenant.policy.hostedAuth[method] = { enabled: true, allowLogin: true, allowUserCreation: true }
  Object.assign(tenant.policy.hostedAuth, {
    profileFields: {
      ...DEFAULT_HOSTED_AUTH_PROFILE_FIELDS,
      ...profileFields,
    },
  })
  return tenant
}

function tenantWithPhoneModeAndDelivery(method: 'smsOtp' | 'whatsappOtp') {
  const tenant = tenantWithIdentifierMode('phone')
  tenant.policy.deliveryChannels =
    method === 'smsOtp'
      ? {
          sms: {
            provider: 'twilio',
            enabled: true,
            secretRefs: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'],
          },
        }
      : {
          whatsapp: {
            provider: 'meta',
            enabled: true,
            secretRefs: ['WHATSAPP_META_PHONE_NUMBER_ID', 'WHATSAPP_META_ACCESS_TOKEN'],
          },
        }
  return tenant
}

describe('POST /auth/magic-link/send', () => {
  beforeEach(() => vi.clearAllMocks())

  it('委托 sendMagicLink + 200(枚举防护)', async () => {
    const app = makeApp(registerSessionAuthRoutes)
    const res = await post(app, makeEnv(), '/auth/magic-link/send', {
      email: 'user@example.com',
      turnstileToken: null,
    })
    expect(res.status).toBe(200)
    expect(sendMagicLink).toHaveBeenCalledOnce()
  })

  it('root 入口带 organizationId 时按选中 organization 发送 Magic Link', async () => {
    const resolvedTenant = makeTenant('tenant-selected')
    resolvedTenant.issuer = 'https://xid.dev'
    resolvedTenant.rpId = 'xid.dev'
    const rootTenant = {
      ...makeTenant('tenant-entry'),
      issuer: 'https://xid.dev',
      rpId: 'xid.dev',
      resolution: { kind: 'instance_entry', primaryDomain: 'xid.dev', unresolvedRoot: true },
    }
    vi.mocked(resolveTenantContextById).mockResolvedValue({
      ok: true,
      value: { status: 'resolved', tenant: resolvedTenant },
    } as never)
    const app = makeApp(registerSessionAuthRoutes, { tenant: rootTenant as never })

    const res = await post(app, makeEnv(), '/auth/magic-link/send', {
      email: 'user@example.com',
      organizationId: 'tenant-selected',
      turnstileToken: null,
    })

    expect(res.status).toBe(200)
    expect(resolveTenantContextById).toHaveBeenCalledWith(
      expect.any(Request),
      expect.anything(),
      'tenant-selected',
    )
    expect(resolveInstanceLogin).not.toHaveBeenCalled()
    expect(sendMagicLink).toHaveBeenCalledWith(expect.anything(), 'user@example.com', {
      profileInput: {
        email: 'user@example.com',
        organizationId: 'tenant-selected',
        turnstileToken: null,
      },
      invitationToken: undefined,
      continuePath: undefined,
      intent: undefined,
      applicationClientId: undefined,
    })
  })

  it('root intent=sign-up skips existing Tenant and verified-domain resolution for Magic Link', async () => {
    const rootTenant = {
      ...makeTenant('tenant-entry'),
      issuer: 'https://xid.dev',
      rpId: 'xid.dev',
      resolution: {
        kind: 'instance_entry' as const,
        primaryDomain: 'xid.dev',
        unresolvedRoot: true,
      },
    }
    const app = makeApp(registerSessionAuthRoutes, { tenant: rootTenant as never })

    const res = await post(app, makeEnv(), '/auth/magic-link/send', {
      email: 'owner@verified.example',
      organizationId: 'tenant-existing',
      intent: 'sign-up',
      turnstileToken: null,
    })

    expect(res.status).toBe(200)
    expect(resolveTenantContextById).not.toHaveBeenCalled()
    expect(resolveInstanceLogin).not.toHaveBeenCalled()
    expect(sendMagicLink).toHaveBeenCalledWith(
      expect.anything(),
      'owner@verified.example',
      expect.objectContaining({
        intent: 'sign-up',
      }),
    )
  })

  it('forceSso -> 200 但不入队 Magic Link 邮件', async () => {
    const auditSend = vi.fn()
    const emailSend = vi.fn()
    const actualMagicLink =
      await vi.importActual<typeof import('../../auth/magic-link')>('../../auth/magic-link')
    vi.mocked(sendMagicLink).mockImplementationOnce(actualMagicLink.sendMagicLink)
    vi.mocked(createTenantDb).mockReturnValue(sessionDb())
    const tenant = makeTenant()
    tenant.policy.hostedAuth.forceSso = true
    const app = makeApp(registerSessionAuthRoutes, { tenant: tenant as never })
    const res = await post(app, makeEnv({ auditSend, emailSend }), '/auth/magic-link/send', {
      email: 'user@example.com',
      turnstileToken: null,
    })

    expect(res.status).toBe(200)
    expect(sendMagicLink).toHaveBeenCalledOnce()
    expect(emailSend).not.toHaveBeenCalled()
    expect(auditSend).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        action: 'auth.policy_denied',
        payload: expect.objectContaining({
          method: 'magicLink',
          action: 'availability',
          reason: 'force_sso',
          identifierType: 'email',
          emailDomain: 'example.com',
        }),
      }),
    )
  })
})

describe('magic-link scanner-safe GET and explicit POST verification', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(resolveTenantContextByIssuer).mockReset()
    vi.mocked(createTenantDb).mockReturnValue(
      sessionDb({
        verificationTokens: {
          findOne: vi.fn().mockResolvedValue({
            tokenHash: 'code-hash',
            userId: 'user-1',
            purpose: 'magic_link',
            flowContext: LOGIN_FLOW_CONTEXT,
            consumedAt: null,
            expiresAt: new Date(Date.now() + 600000),
          }),
          update: vi.fn().mockResolvedValue([]),
          hardDelete: vi.fn().mockResolvedValue(undefined),
        },
      }),
    )
  })

  it('legacy GET missing token -> branded error UI redirect', async () => {
    const app = makeApp(registerSessionAuthRoutes)
    const res = await get(app, makeEnv(), '/auth/magic-link/verify')
    expect(res.status).toBe(303)
    expect(res.headers.get('Location')).toBe('https://tenant-1.xid.dev/magic-link')
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(res.headers.get('Set-Cookie')).toBeNull()
  })

  it('签名错误 -> magic_link_invalid', async () => {
    setVerifyFail('bad_signature')
    const app = makeApp(registerSessionAuthRoutes)
    const res = await post(app, makeEnv(), '/auth/magic-link/verify', { token: 'bad.jwt.sig' })
    expect(((await res.json()) as { code: string }).code).toBe('magic_link_invalid')
  })

  it('签名过期 -> magic_link_expired', async () => {
    setVerifyFail('expired')
    const app = makeApp(registerSessionAuthRoutes)
    const res = await post(app, makeEnv(), '/auth/magic-link/verify', { token: 'expired.jwt.sig' })
    expect(((await res.json()) as { code: string }).code).toBe('magic_link_expired')
  })

  it('签名有效且 token 未消费 -> 签发 session 并跳转 console', async () => {
    const emailUpdate = vi.fn().mockResolvedValue([])
    const sessionInsert = vi.fn().mockImplementation((row: Record<string, unknown>) =>
      Promise.resolve({
        ...row,
        isImpersonation: false,
        impersonatorUserId: null,
      }),
    )
    setVerifyOk({ sub: 'user-1', jti: 'jti-123', purpose: 'magic_link', action: 'login' })
    vi.mocked(createTenantDb).mockReturnValue(
      sessionDb({
        verificationTokens: {
          findOne: vi.fn().mockResolvedValue({
            tokenHash: 'code-hash',
            userId: 'user-1',
            purpose: 'magic_link',
            flowContext: LOGIN_FLOW_CONTEXT,
            consumedAt: null,
            expiresAt: new Date(Date.now() + 600000),
          }),
          update: vi.fn().mockResolvedValue([]),
          hardDelete: vi.fn().mockResolvedValue(undefined),
        },
        userEmails: { insert: vi.fn(), update: emailUpdate },
        sessions: { insert: sessionInsert },
      }),
    )
    const app = makeApp(registerSessionAuthRoutes)
    const res = await post(app, makeEnv(), '/auth/magic-link/verify', { token: 'valid.jwt.sig' })
    expect(res.status).toBe(200)
    expect(await res.clone().json()).toEqual({ redirectUrl: '/console' })
    expect(res.headers.get('Set-Cookie')).toContain('__Host-xid.rt.')
    expect(emailUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ verified: true, verificationStatus: 'verified' }),
      expect.anything(),
    )
    expect(sessionInsert).toHaveBeenCalledWith(expect.objectContaining({ activeOrgId: 'tenant-1' }))
  })

  it('forceSso valid Magic Link -> invalid_credentials 且不消费 token 不签发 session', async () => {
    const auditSend = vi.fn()
    const tokenUpdate = vi.fn().mockResolvedValue([])
    const emailUpdate = vi.fn().mockResolvedValue([])
    const sessionInsert = vi.fn()
    setVerifyOk({ sub: 'user-1', jti: 'jti-123', purpose: 'magic_link', action: 'login' })
    vi.mocked(createTenantDb).mockReturnValue(
      sessionDb({
        verificationTokens: {
          findOne: vi.fn().mockResolvedValue({
            tokenHash: 'code-hash',
            userId: 'user-1',
            purpose: 'magic_link',
            flowContext: LOGIN_FLOW_CONTEXT,
            consumedAt: null,
            expiresAt: new Date(Date.now() + 600000),
          }),
          update: tokenUpdate,
          hardDelete: vi.fn().mockResolvedValue(undefined),
        },
        userEmails: { insert: vi.fn(), update: emailUpdate },
        sessions: { insert: sessionInsert },
      }),
    )
    const tenant = makeTenant()
    tenant.policy.hostedAuth.forceSso = true
    const app = makeApp(registerSessionAuthRoutes, { tenant: tenant as never })
    const res = await post(app, makeEnv({ auditSend }), '/auth/magic-link/verify', {
      token: 'valid.jwt.sig',
    })

    expect(res.status).toBe(401)
    expect(((await res.json()) as { code: string }).code).toBe('invalid_credentials')
    expect(tokenUpdate).not.toHaveBeenCalled()
    expect(emailUpdate).not.toHaveBeenCalled()
    expect(sessionInsert).not.toHaveBeenCalled()
    expect(auditSend).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        action: 'auth.policy_denied',
        payload: expect.objectContaining({
          method: 'magicLink',
          action: 'login',
          reason: 'force_sso',
          path: '/auth/magic-link/verify',
        }),
      }),
    )
  })

  it('root 入口 instance issuer token -> 按 tenant_id hint 消费 token', async () => {
    const resolvedTenant = makeTenant('tenant-resolved', 'https://xid.dev')
    resolvedTenant.issuer = 'https://xid.dev'
    setVerifyOk({ sub: 'user-1', jti: 'jti-123', purpose: 'magic_link', action: 'login' })
    vi.mocked(resolveTenantContextByIssuer).mockResolvedValue({
      ok: true,
      value: { status: 'resolved', tenant: resolvedTenant },
    } as never)
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
      jti: 'jti-123',
      purpose: 'magic_link',
      action: 'login',
      tenant_id: 'tenant-resolved',
    })

    const res = await app.request(
      'https://xid.dev/auth/magic-link/verify',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      },
      env,
      execCtx,
    )

    expect(res.status).toBe(200)
    expect(await res.clone().json()).toEqual({ redirectUrl: '/console' })
    expect(resolveTenantContextByIssuer).toHaveBeenCalledWith(
      expect.any(Request),
      env,
      'https://xid.dev',
      { tenantId: 'tenant-resolved' },
    )
    expect(createTenantDb).toHaveBeenCalledWith(env.DB, resolvedTenant)
    expect(res.headers.get('Set-Cookie')).toContain('__Host-xid.rt.')
  })

  it('root 入口旧 per-org issuer token 无法解析 -> 品牌错误页且不消费 token', async () => {
    vi.mocked(resolveTenantContextByIssuer).mockResolvedValue({
      ok: false,
      error: { code: 'tenant_not_found', message: 'Tenant not found', httpStatus: 404 },
    } as never)
    const rootTenant = {
      ...makeTenant('tenant-entry', 'https://xid.dev'),
      rpId: 'xid.dev',
      resolution: { kind: 'instance_entry', primaryDomain: 'xid.dev', unresolvedRoot: true },
    }
    const app = makeApp(registerSessionAuthRoutes, { tenant: rootTenant as never })
    const env = makeEnv()
    const token = unsignedJwtPayload({
      iss: 'https://tenant-resolved.xid.dev',
      sub: 'user-1',
      jti: 'jti-123',
      purpose: 'magic_link',
      action: 'login',
    })

    const res = await get(
      app,
      env,
      `https://xid.dev/auth/magic-link/verify?token=${encodeURIComponent(token)}`,
    )

    expect(res.status).toBe(303)
    expect(res.headers.get('Location')).toBe('https://xid.dev/magic-link')
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(res.headers.get('Set-Cookie')).toBeNull()
    expect(resolveTenantContextByIssuer).toHaveBeenCalledWith(
      expect.any(Request),
      env,
      'https://tenant-resolved.xid.dev',
      { tenantId: undefined },
    )
    expect(verifyJwt).not.toHaveBeenCalled()
    expect(createTenantDb).not.toHaveBeenCalled()
  })

  it('子域 legacy GET -> 303 回 hosted auth confirmation 且不消费 token', async () => {
    const resolvedTenant = {
      ...makeTenant('tenant-resolved', 'https://xid.dev'),
      hostedAuthOrigin: 'https://xid.dev',
    }
    const app = makeApp(registerSessionAuthRoutes, { tenant: resolvedTenant as never })
    const env = makeEnv()
    const token = unsignedJwtPayload({
      iss: 'https://xid.dev',
      sub: 'user-1',
      jti: 'jti-123',
      purpose: 'magic_link',
      action: 'login',
      tenant_id: 'tenant-resolved',
    })

    const res = await get(
      app,
      env,
      `https://admin.xid.dev/auth/magic-link/verify?token=${encodeURIComponent(token)}&continue=%2Fconsole`,
    )

    expect(res.status).toBe(303)
    expect(res.headers.get('Location')).toBe(`https://xid.dev/magic-link#token=${token}`)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(resolveTenantContextByIssuer).not.toHaveBeenCalled()
    expect(verifyJwt).not.toHaveBeenCalled()
    expect(createTenantDb).not.toHaveBeenCalled()
    expect(res.headers.get('Set-Cookie')).toBeNull()
  })

  it('hosted auth origin legacy GET 只跳确认页,不消费 token', async () => {
    const resolvedTenant = makeTenant('tenant-resolved', 'https://xid.dev')
    resolvedTenant.issuer = 'https://xid.dev'
    setVerifyOk({ sub: 'user-1', jti: 'jti-123', purpose: 'magic_link', action: 'login' })
    vi.mocked(resolveTenantContextByIssuer).mockResolvedValue({
      ok: true,
      value: { status: 'not_instance_entry', tenant: resolvedTenant },
    } as never)
    const app = makeApp(registerSessionAuthRoutes, { tenant: resolvedTenant as never })
    const env = makeEnv()
    const token = unsignedJwtPayload({
      iss: 'https://xid.dev',
      sub: 'user-1',
      jti: 'jti-123',
      purpose: 'magic_link',
      action: 'login',
      tenant_id: 'tenant-resolved',
    })

    const res = await get(
      app,
      env,
      `https://xid.dev/auth/magic-link/verify?token=${encodeURIComponent(token)}`,
    )

    expect(res.status).toBe(303)
    expect(res.headers.get('Location')).toBe(`https://xid.dev/magic-link#token=${token}`)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(resolveTenantContextByIssuer).not.toHaveBeenCalled()
    expect(createTenantDb).not.toHaveBeenCalled()
    expect(res.headers.get('Set-Cookie')).toBeNull()
  })

  it('已消费 token -> magic_link_invalid', async () => {
    setVerifyOk({ sub: 'user-1', jti: 'jti-123', purpose: 'magic_link', action: 'login' })
    vi.mocked(createTenantDb).mockReturnValue(
      sessionDb({
        verificationTokens: {
          findOne: vi.fn().mockResolvedValue({
            tokenHash: 'code-hash',
            userId: 'user-1',
            purpose: 'magic_link',
            flowContext: LOGIN_FLOW_CONTEXT,
            consumedAt: new Date(),
            expiresAt: new Date(Date.now() + 600000),
          }),
          update: vi.fn(),
          hardDelete: vi.fn(),
        },
      }),
    )
    const app = makeApp(registerSessionAuthRoutes)
    const res = await post(app, makeEnv(), '/auth/magic-link/verify', { token: 'valid.jwt.sig' })
    expect(((await res.json()) as { code: string }).code).toBe('magic_link_invalid')
  })

  it('失败限流触发 -> 429', async () => {
    setVerifyOk({ sub: 'user-1', jti: 'jti-123', purpose: 'magic_link', action: 'login' })
    const app = makeApp(registerSessionAuthRoutes)
    const res = await app.request(
      'https://tenant-1.xid.dev/auth/magic-link/verify',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'cf-connecting-ip': '203.0.113.7',
        },
        body: JSON.stringify({ token: 'valid.jwt.sig' }),
      },
      makeEnv({ rateLimitAllowed: false }),
      execCtx,
    )
    expect(res.status).toBe(429)
  })
})

describe('POST /auth/otp/email/send', () => {
  beforeEach(() => vi.clearAllMocks())

  it('target 不存在 -> 200 不发(枚举防护)', async () => {
    vi.mocked(resolveTargetUserId).mockResolvedValue(null)
    vi.mocked(createTenantDb).mockReturnValue(sessionDb())
    const app = makeApp(registerSessionAuthRoutes)
    const res = await post(app, makeEnv(), '/auth/otp/email/send', {
      email: 'nobody@example.com',
      turnstileToken: null,
    })
    expect(res.status).toBe(200)
    expect(persistAndSendOtp).not.toHaveBeenCalled()
  })

  it('uses one combined OTP rate-limit reservation before delivery', async () => {
    vi.mocked(resolveTargetUserId).mockResolvedValue('user-1')
    vi.mocked(createTenantDb).mockReturnValue(sessionDb())
    const app = makeApp(registerSessionAuthRoutes)

    const res = await post(app, makeEnv(), '/auth/otp/email/send', {
      email: 'user@example.com',
      turnstileToken: null,
    })

    expect(res.status).toBe(200)
    expect(reserveOtpSendRateLimit).toHaveBeenCalledWith(
      expect.anything(),
      'user@example.com',
      'tenant-1',
    )
  })

  it('target 不存在且允许 email OTP 创建 -> 创建 passwordless 用户并发码', async () => {
    vi.mocked(resolveTargetUserId).mockResolvedValue(null)
    const db = sessionDb()
    vi.mocked(createTenantDb).mockReturnValue(db)
    const app = makeApp(registerSessionAuthRoutes, {
      tenant: tenantWithEmailOtpCreation() as never,
    })
    const res = await post(app, makeEnv(), '/auth/otp/email/send', {
      email: 'new@example.com',
      turnstileToken: null,
    })
    expect(res.status).toBe(200)
    expect(provisionAccountAtomically).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        user: expect.objectContaining({ provisionedBy: 'hosted_passwordless' }),
        primaryEmail: expect.objectContaining({ email: 'new@example.com' }),
      }),
    )
    expect(persistAndSendOtp).toHaveBeenCalledOnce()
  })

  it('root 入口带 organizationId 时按选中 organization 创建 Email OTP 用户', async () => {
    const resolvedTenant = tenantWithEmailOtpCreation()
    resolvedTenant.tenantId = 'tenant-selected'
    resolvedTenant.issuer = 'https://xid.dev'
    resolvedTenant.rpId = 'xid.dev'
    const rootTenant = {
      ...tenantWithEmailOtpCreation(),
      tenantId: 'tenant-entry',
      issuer: 'https://xid.dev',
      rpId: 'xid.dev',
      resolution: { kind: 'instance_entry', primaryDomain: 'xid.dev', unresolvedRoot: true },
    }
    vi.mocked(resolveTenantContextById).mockResolvedValue({
      ok: true,
      value: { status: 'resolved', tenant: resolvedTenant },
    } as never)
    vi.mocked(resolveTargetUserId).mockResolvedValue(null)
    vi.mocked(createTenantDb).mockReturnValue(sessionDb())
    const app = makeApp(registerSessionAuthRoutes, { tenant: rootTenant as never })

    const res = await post(app, makeEnv(), '/auth/otp/email/send', {
      email: 'new@example.com',
      organizationId: 'tenant-selected',
      turnstileToken: null,
    })

    expect(res.status).toBe(200)
    expect(resolveTenantContextById).toHaveBeenCalledWith(
      expect.any(Request),
      expect.anything(),
      'tenant-selected',
    )
    expect(resolveInstanceLogin).not.toHaveBeenCalled()
    expect(createTenantDb).toHaveBeenCalledWith(expect.anything(), resolvedTenant)
    expect(provisionAccountAtomically).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-selected' }),
    )
    expect(persistAndSendOtp).toHaveBeenCalledOnce()
  })

  it('target 不存在且缺 required profile field -> 200 不创建不发码并审计', async () => {
    const auditSend = vi.fn()
    vi.mocked(resolveTargetUserId).mockResolvedValue(null)
    const usersInsert = vi.fn()
    vi.mocked(createTenantDb).mockReturnValue(sessionDb({ users: { insert: usersInsert } }))
    const tenant = tenantWithEmailOtpCreation()
    Object.assign(tenant.policy.hostedAuth, {
      profileFields: {
        ...DEFAULT_HOSTED_AUTH_PROFILE_FIELDS,
        username: 'required',
      },
    })
    const app = makeApp(registerSessionAuthRoutes, { tenant: tenant as never })
    const res = await post(app, makeEnv({ auditSend }), '/auth/otp/email/send', {
      email: 'new@example.com',
      turnstileToken: null,
    })

    expect(res.status).toBe(200)
    expect(usersInsert).not.toHaveBeenCalled()
    expect(persistAndSendOtp).not.toHaveBeenCalled()
    expect(auditSend).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        action: 'auth.policy_denied',
        payload: expect.objectContaining({
          method: 'emailOtp',
          action: 'user_creation',
          reason: 'profile_field_required',
          identifierType: 'email',
          emailDomain: 'example.com',
        }),
      }),
    )
  })

  it('target 不存在且提供 profile field -> 创建用户时写 profile 和额外 phone identity', async () => {
    vi.mocked(resolveTargetUserId).mockResolvedValue(null)
    vi.mocked(createTenantDb).mockReturnValue(sessionDb())
    const tenant = tenantWithEmailOtpCreation()
    Object.assign(tenant.policy.hostedAuth, {
      profileFields: {
        ...DEFAULT_HOSTED_AUTH_PROFILE_FIELDS,
        username: 'required',
        phone: 'optional',
        givenName: 'optional',
        familyName: 'optional',
      },
    })
    const app = makeApp(registerSessionAuthRoutes, { tenant: tenant as never })
    const res = await post(app, makeEnv(), '/auth/otp/email/send', {
      email: 'new@example.com',
      username: 'Alice',
      phone: '+15557654321',
      givenName: 'Alice',
      familyName: 'Chen',
      turnstileToken: null,
    })

    expect(res.status).toBe(200)
    expect(provisionAccountAtomically).toHaveBeenCalledWith(
      expect.objectContaining({
        user: expect.objectContaining({
          username: 'alice',
          primaryPhoneId: expect.any(String),
          firstName: 'Alice',
          lastName: 'Chen',
          displayName: 'Alice Chen',
          profileCompletionStatus: 'complete',
        }),
        primaryPhone: expect.objectContaining({
          phone: '+15557654321',
          verified: false,
          verificationStatus: 'unverified',
        }),
      }),
    )
    expect(persistAndSendOtp).toHaveBeenCalledOnce()
  })

  it('root 入口按 verified domain resolver 切到最终 tenant 后执行 allowed domain 策略', async () => {
    const auditSend = vi.fn()
    const baseResolvedTenant = tenantWithEmailOtpCreation()
    const resolvedTenant = {
      ...baseResolvedTenant,
      tenantId: 'tenant-resolved',
      policy: {
        ...baseResolvedTenant.policy,
        hostedAuth: {
          ...baseResolvedTenant.policy.hostedAuth,
          emailOtp: { enabled: true, allowLogin: true, allowUserCreation: true },
          allowedEmailDomains: ['allowed.example.com'],
        },
      },
    }
    const rootTenant = {
      ...tenantWithEmailOtpCreation(),
      tenantId: 'tenant-entry',
      rpId: 'xid.dev',
      resolution: { kind: 'instance_entry', primaryDomain: 'xid.dev', unresolvedRoot: true },
    }
    vi.mocked(resolveInstanceLogin).mockResolvedValue({
      ok: true,
      value: { status: 'new_user', tenant: resolvedTenant, matchedBy: 'email' },
    } as never)
    vi.mocked(resolveTargetUserId).mockResolvedValue(null)
    vi.mocked(createTenantDb).mockReturnValue(sessionDb())
    const app = makeApp(registerSessionAuthRoutes, {
      tenant: rootTenant as never,
    })

    const res = await post(app, makeEnv({ auditSend }), '/auth/otp/email/send', {
      email: 'new@blocked.example.com',
      turnstileToken: null,
    })

    expect(res.status).toBe(200)
    expect(resolveInstanceLogin).toHaveBeenCalledWith(expect.any(Request), expect.anything(), {
      kind: 'email',
      value: 'new@blocked.example.com',
    })
    expect(persistAndSendOtp).not.toHaveBeenCalled()
    expect(auditSend).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-resolved',
        action: 'auth.policy_denied',
        payload: expect.objectContaining({
          method: 'emailOtp',
          action: 'availability',
          reason: 'email_domain_not_allowed',
          identifierType: 'email',
          emailDomain: 'blocked.example.com',
        }),
      }),
    )
  })

  it('target 存在 -> 200 + persistAndSendOtp', async () => {
    vi.mocked(resolveTargetUserId).mockResolvedValue('user-1')
    vi.mocked(createTenantDb).mockReturnValue(sessionDb())
    const app = makeApp(registerSessionAuthRoutes)
    const res = await post(app, makeEnv(), '/auth/otp/email/send', {
      email: 'user@example.com',
      turnstileToken: null,
    })
    expect(res.status).toBe(200)
    expect(persistAndSendOtp).toHaveBeenCalledWith(
      expect.objectContaining({
        flowContext: {
          version: 1,
          intent: null,
          continuePath: '/console',
          applicationClientId: null,
          invitationId: null,
        },
      }),
    )
  })

  it('forceSso -> 200 但不发送 Email OTP', async () => {
    const auditSend = vi.fn()
    vi.mocked(resolveTargetUserId).mockResolvedValue('user-1')
    vi.mocked(createTenantDb).mockReturnValue(sessionDb())
    const tenant = makeTenant()
    tenant.policy.hostedAuth.forceSso = true
    const app = makeApp(registerSessionAuthRoutes, { tenant: tenant as never })
    const res = await post(app, makeEnv({ auditSend }), '/auth/otp/email/send', {
      email: 'user@example.com',
      turnstileToken: null,
    })

    expect(res.status).toBe(200)
    expect(persistAndSendOtp).not.toHaveBeenCalled()
    expect(auditSend).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        action: 'auth.policy_denied',
        payload: expect.objectContaining({
          method: 'emailOtp',
          action: 'availability',
          reason: 'force_sso',
          identifierType: 'email',
          emailDomain: 'example.com',
        }),
      }),
    )
  })

  it('target 存在但 email OTP 不允许登录 -> 200 不发码并审计', async () => {
    const auditSend = vi.fn()
    vi.mocked(resolveTargetUserId).mockResolvedValue('user-1')
    vi.mocked(createTenantDb).mockReturnValue(sessionDb())
    const tenant = makeTenant()
    tenant.policy.hostedAuth.emailOtp = {
      enabled: true,
      allowLogin: false,
      allowUserCreation: true,
    }
    const app = makeApp(registerSessionAuthRoutes, { tenant: tenant as never })
    const res = await post(app, makeEnv({ auditSend }), '/auth/otp/email/send', {
      email: 'user@example.com',
      turnstileToken: null,
    })
    expect(res.status).toBe(200)
    expect(persistAndSendOtp).not.toHaveBeenCalled()
    expect(auditSend).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        action: 'auth.policy_denied',
        payload: expect.objectContaining({
          method: 'emailOtp',
          action: 'login',
          reason: 'method_login_disabled',
          identifierType: 'email',
          emailDomain: 'example.com',
        }),
      }),
    )
    expect(JSON.stringify(auditSend.mock.calls[0])).not.toContain('user@example.com')
  })

  it('phone identifier 下 email OTP 兼容端点 -> 200 不发码并审计', async () => {
    const auditSend = vi.fn()
    vi.mocked(resolveTargetUserId).mockResolvedValue('user-1')
    vi.mocked(createTenantDb).mockReturnValue(sessionDb())
    const tenant = tenantWithIdentifierMode('phone')
    tenant.policy.deliveryChannels = {
      whatsapp: {
        provider: 'meta',
        enabled: true,
        secretRefs: ['WHATSAPP_META_PHONE_NUMBER_ID', 'WHATSAPP_META_ACCESS_TOKEN'],
      },
    }
    const app = makeApp(registerSessionAuthRoutes, {
      tenant: tenant as never,
    })
    const res = await post(app, makeEnv({ auditSend }), '/auth/otp/email/send', {
      email: 'user@example.com',
      turnstileToken: null,
    })
    expect(res.status).toBe(200)
    expect(persistAndSendOtp).not.toHaveBeenCalled()
    expect(auditSend).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        action: 'auth.policy_denied',
        payload: expect.objectContaining({
          method: 'emailOtp',
          action: 'availability',
          reason: 'identifier_mode_not_allowed',
          identifierType: 'email',
          emailDomain: 'example.com',
        }),
      }),
    )
  })
})

describe('POST /auth/otp/sms/send', () => {
  beforeEach(() => vi.clearAllMocks())

  it('非白名单国家号码 -> invalid_request', async () => {
    vi.mocked(createTenantDb).mockReturnValue(sessionDb())
    const app = makeApp(registerSessionAuthRoutes)
    const res = await post(app, makeEnv(), '/auth/otp/sms/send', {
      phone: '+449999999999',
      turnstileToken: null,
    })
    expect(((await res.json()) as { code: string }).code).toBe('invalid_request')
  })

  it('email identifier 下 SMS OTP 兼容端点 -> 200 不发码并审计', async () => {
    const auditSend = vi.fn()
    vi.mocked(resolveTargetUserId).mockResolvedValue('user-1')
    vi.mocked(createTenantDb).mockReturnValue(sessionDb())
    const app = makeApp(registerSessionAuthRoutes, {
      tenant: tenantWithIdentifierMode('email') as never,
    })
    const res = await post(app, makeEnv({ auditSend }), '/auth/otp/sms/send', {
      phone: '+15551234567',
      turnstileToken: null,
    })
    expect(res.status).toBe(200)
    expect(persistAndSendOtp).not.toHaveBeenCalled()
    expect(auditSend).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        action: 'auth.policy_denied',
        payload: expect.objectContaining({
          method: 'smsOtp',
          action: 'availability',
          reason: 'identifier_mode_not_allowed',
          identifierType: 'phone',
          emailDomain: null,
        }),
      }),
    )
  })

  it('新手机号且允许 SMS OTP 创建 -> 创建 passwordless phone 用户并发码', async () => {
    vi.mocked(resolveTargetUserId).mockResolvedValue(null)
    const db = sessionDb()
    vi.mocked(createTenantDb).mockReturnValue(db)
    const app = makeApp(registerSessionAuthRoutes, {
      tenant: tenantWithPhoneOtpCreation('smsOtp', {
        email: 'hidden',
        phone: 'required',
      }) as never,
    })
    const res = await post(app, makeEnv({ smsProvider: 'twilio' }), '/auth/otp/sms/send', {
      phone: '+15551234567',
      turnstileToken: null,
    })
    expect(res.status).toBe(200)
    expect(provisionAccountAtomically).toHaveBeenCalledWith(
      expect.objectContaining({
        user: expect.objectContaining({
          primaryPhoneId: expect.any(String),
          provisionedBy: 'hosted_passwordless',
        }),
        primaryPhone: expect.objectContaining({
          phone: '+15551234567',
          verified: false,
          verificationStatus: 'unverified',
        }),
      }),
    )
    expect(persistAndSendOtp).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'sms', target: '+15551234567' }),
    )
  })

  it('新手机号且要求 profile email -> 创建 phone 用户时写 primary email', async () => {
    vi.mocked(resolveTargetUserId).mockResolvedValue(null)
    const db = sessionDb()
    vi.mocked(createTenantDb).mockReturnValue(db)
    const app = makeApp(registerSessionAuthRoutes, {
      tenant: tenantWithPhoneOtpCreation('smsOtp', {
        email: 'required',
        phone: 'required',
      }) as never,
    })
    const res = await post(app, makeEnv({ smsProvider: 'twilio' }), '/auth/otp/sms/send', {
      phone: '+15551234567',
      email: 'phone-owner@example.com',
      turnstileToken: null,
    })

    expect(res.status).toBe(200)
    expect(provisionAccountAtomically).toHaveBeenCalledWith(
      expect.objectContaining({
        user: expect.objectContaining({
          primaryEmailId: expect.any(String),
          primaryPhoneId: expect.any(String),
          profileCompletionStatus: 'complete',
        }),
        primaryEmail: expect.objectContaining({
          email: 'phone-owner@example.com',
          verified: false,
          verificationStatus: 'unverified',
        }),
      }),
    )
    expect(persistAndSendOtp).toHaveBeenCalledOnce()
  })

  it('新手机号且 profile email 被域名策略拒绝 -> 200 不创建不发码并审计', async () => {
    const auditSend = vi.fn()
    vi.mocked(resolveTargetUserId).mockResolvedValue(null)
    const usersInsert = vi.fn()
    vi.mocked(createTenantDb).mockReturnValue(sessionDb({ users: { insert: usersInsert } }))
    const tenant = tenantWithPhoneOtpCreation('smsOtp', {
      email: 'required',
      phone: 'required',
    })
    Object.assign(tenant.policy.hostedAuth, { allowedEmailDomains: ['allowed.example.com'] })
    const app = makeApp(registerSessionAuthRoutes, { tenant: tenant as never })
    const res = await post(
      app,
      makeEnv({ auditSend, smsProvider: 'twilio' }),
      '/auth/otp/sms/send',
      {
        phone: '+15551234567',
        email: 'owner@blocked.example.com',
        turnstileToken: null,
      },
    )

    expect(res.status).toBe(200)
    expect(usersInsert).not.toHaveBeenCalled()
    expect(persistAndSendOtp).not.toHaveBeenCalled()
    expect(auditSend).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        action: 'auth.policy_denied',
        payload: expect.objectContaining({
          method: 'smsOtp',
          action: 'user_creation',
          reason: 'email_domain_not_allowed',
          identifierType: 'phone',
          emailDomain: null,
        }),
      }),
    )
  })
})

describe('POST /auth/otp/whatsapp/send', () => {
  beforeEach(() => vi.clearAllMocks())

  it('非白名单国家号码 -> invalid_request', async () => {
    vi.mocked(createTenantDb).mockReturnValue(sessionDb())
    const app = makeApp(registerSessionAuthRoutes)
    const res = await post(app, makeEnv(), '/auth/otp/whatsapp/send', {
      phone: '+449999999999',
      turnstileToken: null,
    })
    expect(((await res.json()) as { code: string }).code).toBe('invalid_request')
  })

  it('phone identifier + WhatsApp provider 已配置 -> 200 + persistAndSendOtp', async () => {
    vi.mocked(resolveTargetUserId).mockResolvedValue('user-1')
    vi.mocked(createTenantDb).mockReturnValue(sessionDb())
    const app = makeApp(registerSessionAuthRoutes, {
      tenant: tenantWithPhoneModeAndDelivery('whatsappOtp') as never,
    })
    const res = await post(app, makeEnv({ whatsappProvider: 'meta' }), '/auth/otp/whatsapp/send', {
      phone: '+15551234567',
      turnstileToken: null,
    })
    expect(res.status).toBe(200)
    expect(persistAndSendOtp).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'whatsapp', target: '+15551234567' }),
    )
  })

  it('新手机号且允许 WhatsApp OTP 创建 -> 创建 passwordless phone 用户并发码', async () => {
    vi.mocked(resolveTargetUserId).mockResolvedValue(null)
    const db = sessionDb()
    vi.mocked(createTenantDb).mockReturnValue(db)
    const app = makeApp(registerSessionAuthRoutes, {
      tenant: tenantWithPhoneOtpCreation('whatsappOtp', {
        email: 'hidden',
        phone: 'required',
      }) as never,
    })
    const res = await post(app, makeEnv({ whatsappProvider: 'meta' }), '/auth/otp/whatsapp/send', {
      phone: '+15551234567',
      turnstileToken: null,
    })
    expect(res.status).toBe(200)
    expect(provisionAccountAtomically).toHaveBeenCalledWith(
      expect.objectContaining({
        user: expect.objectContaining({
          primaryPhoneId: expect.any(String),
          provisionedBy: 'hosted_passwordless',
        }),
        primaryPhone: expect.objectContaining({
          phone: '+15551234567',
          verified: false,
          verificationStatus: 'unverified',
        }),
      }),
    )
    expect(persistAndSendOtp).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'whatsapp', target: '+15551234567' }),
    )
  })

  it('root 入口按 phone resolver 切到最终 tenant 后发送 WhatsApp OTP', async () => {
    const resolvedTenant = tenantWithPhoneModeAndDelivery('whatsappOtp')
    resolvedTenant.tenantId = 'tenant-resolved'
    resolvedTenant.policy.deliveryChannels = {
      whatsapp: {
        provider: 'meta',
        enabled: true,
        secretRefs: ['WHATSAPP_META_PHONE_NUMBER_ID', 'WHATSAPP_META_ACCESS_TOKEN'],
      },
    }
    const rootTenant = {
      ...tenantWithIdentifierMode('phone'),
      tenantId: 'tenant-entry',
      rpId: 'xid.dev',
      resolution: { kind: 'instance_entry', primaryDomain: 'xid.dev', unresolvedRoot: true },
    }
    vi.mocked(resolveInstanceLogin).mockResolvedValue({
      ok: true,
      value: { status: 'resolved', tenant: resolvedTenant, matchedBy: 'phone' },
    } as never)
    vi.mocked(resolveTargetUserId).mockResolvedValue('user-1')
    vi.mocked(createTenantDb).mockReturnValue(sessionDb())
    const app = makeApp(registerSessionAuthRoutes, {
      tenant: rootTenant as never,
    })

    const res = await post(app, makeEnv({ whatsappProvider: 'meta' }), '/auth/otp/whatsapp/send', {
      phone: '+15551234567',
      turnstileToken: null,
    })

    expect(res.status).toBe(200)
    expect(resolveInstanceLogin).toHaveBeenCalledWith(expect.any(Request), expect.anything(), {
      kind: 'phone',
      value: '+15551234567',
    })
    expect(createTenantDb).toHaveBeenCalledWith(expect.anything(), resolvedTenant)
    expect(persistAndSendOtp).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-resolved', channel: 'whatsapp' }),
    )
  })

  it('WhatsApp provider 未配置 -> 200 不发码并审计', async () => {
    const auditSend = vi.fn()
    vi.mocked(resolveTargetUserId).mockResolvedValue('user-1')
    vi.mocked(createTenantDb).mockReturnValue(sessionDb())
    const app = makeApp(registerSessionAuthRoutes, {
      tenant: tenantWithPhoneModeAndDelivery('whatsappOtp') as never,
    })
    const res = await post(app, makeEnv({ auditSend }), '/auth/otp/whatsapp/send', {
      phone: '+15551234567',
      turnstileToken: null,
    })
    expect(res.status).toBe(200)
    expect(persistAndSendOtp).not.toHaveBeenCalled()
    expect(auditSend).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        action: 'auth.policy_denied',
        payload: expect.objectContaining({
          method: 'whatsappOtp',
          action: 'availability',
          reason: 'method_not_configured',
          identifierType: 'phone',
        }),
      }),
    )
  })
})

describe('POST /auth/otp/email/verify', () => {
  beforeEach(() => vi.clearAllMocks())

  it('正确 code -> 200 + 签发 session', async () => {
    const emailUpdate = vi.fn().mockResolvedValue([])
    const sessionInsert = vi.fn().mockImplementation((row: Record<string, unknown>) =>
      Promise.resolve({
        ...row,
        isImpersonation: false,
        impersonatorUserId: null,
      }),
    )
    vi.mocked(constantTimeEqualStr).mockReturnValue(true)
    vi.mocked(loadVerifiableOtp).mockResolvedValue({
      tokenHash: 'th-1',
      userId: 'user-1',
      codeHash: 'code-hash',
      flowContext: LOGIN_FLOW_CONTEXT,
    } as never)
    vi.mocked(createTenantDb).mockReturnValue(
      sessionDb({
        userEmails: { update: emailUpdate, insert: vi.fn() },
        sessions: { insert: sessionInsert },
      }),
    )
    const app = makeApp(registerSessionAuthRoutes)
    const res = await post(app, makeEnv(), '/auth/otp/email/verify', {
      email: 'user@example.com',
      code: '123456',
    })
    expect(res.status).toBe(200)
    expect(emailUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ verified: true, verificationStatus: 'verified' }),
      expect.anything(),
    )
    expect(sessionInsert).toHaveBeenCalledWith(expect.objectContaining({ activeOrgId: 'tenant-1' }))
  })

  it('verify ignores rewritten intent and continue fields and follows the persisted send flow', async () => {
    vi.mocked(constantTimeEqualStr).mockReturnValue(true)
    vi.mocked(loadVerifiableOtp).mockResolvedValue({
      tokenHash: 'th-product',
      userId: 'user-1',
      codeHash: 'code-hash',
      flowContext: PRODUCT_SIGN_UP_FLOW_CONTEXT,
    } as never)
    vi.mocked(createTenantDb).mockReturnValue(sessionDb())
    const app = makeApp(registerSessionAuthRoutes)

    const res = await post(app, makeEnv(), '/auth/otp/email/verify', {
      email: 'user@example.com',
      code: '123456',
      intent: 'sign-in',
      continue: '/console',
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ redirectUrl: '/create-organization' })
    expect(resolvePostAuthMfaGate).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ returnPath: '/create-organization' }),
    )
  })

  it('forceSso -> invalid_credentials 且不消费 Email OTP 不签发 session', async () => {
    const auditSend = vi.fn()
    const db = sessionDb({
      verificationTokens: { hardDelete: vi.fn() },
      userEmails: { update: vi.fn(), insert: vi.fn() },
      sessions: { insert: vi.fn() },
    })
    vi.mocked(createTenantDb).mockReturnValue(db)
    const tenant = makeTenant()
    tenant.policy.hostedAuth.forceSso = true
    const app = makeApp(registerSessionAuthRoutes, { tenant: tenant as never })
    const res = await post(app, makeEnv({ auditSend }), '/auth/otp/email/verify', {
      email: 'user@example.com',
      code: '123456',
    })

    expect(res.status).toBe(401)
    expect(((await res.json()) as { code: string }).code).toBe('invalid_credentials')
    expect(loadVerifiableOtp).not.toHaveBeenCalled()
    expect(db.verificationTokens.hardDelete).not.toHaveBeenCalled()
    expect(db.sessions.insert).not.toHaveBeenCalled()
    expect(auditSend).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        action: 'auth.policy_denied',
        payload: expect.objectContaining({
          method: 'emailOtp',
          action: 'login',
          reason: 'force_sso',
          identifierType: 'email',
          emailDomain: 'example.com',
        }),
      }),
    )
  })

  it('root 入口按 email resolver 切到最终 tenant 后验证 OTP', async () => {
    const resolvedTenant = makeTenant()
    resolvedTenant.tenantId = 'tenant-resolved'
    const rootTenant = {
      ...makeTenant(),
      tenantId: 'tenant-entry',
      rpId: 'xid.dev',
      resolution: { kind: 'instance_entry', primaryDomain: 'xid.dev', unresolvedRoot: true },
    }
    vi.mocked(resolveInstanceLogin).mockResolvedValue({
      ok: true,
      value: { status: 'resolved', tenant: resolvedTenant, matchedBy: 'email' },
    } as never)
    vi.mocked(constantTimeEqualStr).mockReturnValue(true)
    vi.mocked(loadVerifiableOtp).mockResolvedValue({
      tokenHash: 'th-1',
      userId: 'user-1',
      codeHash: 'code-hash',
      flowContext: LOGIN_FLOW_CONTEXT,
    } as never)
    const db = sessionDb()
    vi.mocked(createTenantDb).mockReturnValue(db)
    const app = makeApp(registerSessionAuthRoutes, {
      tenant: rootTenant as never,
    })

    const res = await post(app, makeEnv(), '/auth/otp/email/verify', {
      email: 'user@example.com',
      code: '123456',
    })

    expect(res.status).toBe(200)
    expect(resolveInstanceLogin).toHaveBeenCalledWith(expect.any(Request), expect.anything(), {
      kind: 'email',
      value: 'user@example.com',
    })
    expect(createTenantDb).toHaveBeenCalledWith(expect.anything(), resolvedTenant)
  })

  it('root 入口带 organizationId 时按选中 organization 验证 OTP', async () => {
    const resolvedTenant = makeTenant('tenant-selected')
    resolvedTenant.issuer = 'https://xid.dev'
    resolvedTenant.rpId = 'xid.dev'
    const rootTenant = {
      ...makeTenant('tenant-entry'),
      issuer: 'https://xid.dev',
      rpId: 'xid.dev',
      resolution: { kind: 'instance_entry', primaryDomain: 'xid.dev', unresolvedRoot: true },
    }
    vi.mocked(resolveTenantContextById).mockResolvedValue({
      ok: true,
      value: { status: 'resolved', tenant: resolvedTenant },
    } as never)
    vi.mocked(constantTimeEqualStr).mockReturnValue(true)
    vi.mocked(loadVerifiableOtp).mockResolvedValue({
      tokenHash: 'th-1',
      userId: 'user-1',
      codeHash: 'code-hash',
      flowContext: LOGIN_FLOW_CONTEXT,
    } as never)
    vi.mocked(createTenantDb).mockReturnValue(sessionDb())
    const app = makeApp(registerSessionAuthRoutes, { tenant: rootTenant as never })

    const res = await post(app, makeEnv(), '/auth/otp/email/verify', {
      email: 'user@example.com',
      code: '123456',
      organizationId: 'tenant-selected',
    })

    expect(res.status).toBe(200)
    expect(resolveTenantContextById).toHaveBeenCalledWith(
      expect.any(Request),
      expect.anything(),
      'tenant-selected',
    )
    expect(resolveInstanceLogin).not.toHaveBeenCalled()
    expect(createTenantDb).toHaveBeenCalledWith(expect.anything(), resolvedTenant)
  })

  it('错误 code 格式 -> otp_invalid', async () => {
    const app = makeApp(registerSessionAuthRoutes)
    const res = await post(app, makeEnv(), '/auth/otp/email/verify', {
      email: 'user@example.com',
      code: '12',
    })
    expect(((await res.json()) as { code: string }).code).toBe('otp_invalid')
  })

  it('跨租户:B 上下文 loadVerifiableOtp 抛 otp_invalid(查不到 A token)', async () => {
    vi.mocked(loadVerifiableOtp).mockRejectedValue(
      await import('../../lib/errors').then((m) => new m.AppError('otp_invalid')),
    )
    vi.mocked(createTenantDb).mockReturnValue(sessionDb())
    const app = makeApp(registerSessionAuthRoutes, {
      tenant: { tenantId: 'tenant-B', issuer: 'https://b.xid.dev', rpId: 'b.xid.dev' } as never,
    })
    const res = await post(app, makeEnv(), '/auth/otp/email/verify', {
      email: 'a-user@example.com',
      code: '123456',
    })
    expect(((await res.json()) as { code: string }).code).toBe('otp_invalid')
  })
})

describe('POST /auth/otp/whatsapp/verify', () => {
  beforeEach(() => vi.clearAllMocks())

  it('正确 code -> 200 + 签发 session', async () => {
    const phoneUpdate = vi.fn().mockResolvedValue([])
    vi.mocked(constantTimeEqualStr).mockReturnValue(true)
    vi.mocked(loadVerifiableOtp).mockResolvedValue({
      tokenHash: 'th-1',
      userId: 'user-1',
      codeHash: 'code-hash',
      flowContext: LOGIN_FLOW_CONTEXT,
    } as never)
    vi.mocked(createTenantDb).mockReturnValue(
      sessionDb({
        userPhones: { insert: vi.fn(), update: phoneUpdate },
      }),
    )
    const app = makeApp(registerSessionAuthRoutes, {
      tenant: tenantWithPhoneModeAndDelivery('whatsappOtp') as never,
    })
    const res = await post(
      app,
      makeEnv({ whatsappProvider: 'meta' }),
      '/auth/otp/whatsapp/verify',
      {
        phone: '+15551234567',
        code: '123456',
      },
    )
    expect(res.status).toBe(200)
    expect(loadVerifiableOtp).toHaveBeenCalledWith(expect.anything(), 'whatsapp', '+15551234567')
    expect(phoneUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ verified: true, verificationStatus: 'verified' }),
      expect.anything(),
    )
  })

  it('root 入口按 phone resolver 切到最终 tenant 后验证 WhatsApp OTP', async () => {
    const resolvedTenant = tenantWithPhoneModeAndDelivery('whatsappOtp')
    resolvedTenant.tenantId = 'tenant-resolved'
    const rootTenant = {
      ...tenantWithIdentifierMode('phone'),
      tenantId: 'tenant-entry',
      rpId: 'xid.dev',
      resolution: { kind: 'instance_entry', primaryDomain: 'xid.dev', unresolvedRoot: true },
    }
    vi.mocked(resolveInstanceLogin).mockResolvedValue({
      ok: true,
      value: { status: 'resolved', tenant: resolvedTenant, matchedBy: 'phone' },
    } as never)
    vi.mocked(constantTimeEqualStr).mockReturnValue(true)
    vi.mocked(loadVerifiableOtp).mockResolvedValue({
      tokenHash: 'th-1',
      userId: 'user-1',
      codeHash: 'code-hash',
      flowContext: LOGIN_FLOW_CONTEXT,
    } as never)
    vi.mocked(createTenantDb).mockReturnValue(sessionDb())
    const app = makeApp(registerSessionAuthRoutes, {
      tenant: rootTenant as never,
    })

    const res = await post(
      app,
      makeEnv({ whatsappProvider: 'meta' }),
      '/auth/otp/whatsapp/verify',
      {
        phone: '+15551234567',
        code: '123456',
      },
    )

    expect(res.status).toBe(200)
    expect(resolveInstanceLogin).toHaveBeenCalledWith(expect.any(Request), expect.anything(), {
      kind: 'phone',
      value: '+15551234567',
    })
    expect(createTenantDb).toHaveBeenCalledWith(expect.anything(), resolvedTenant)
  })
})
