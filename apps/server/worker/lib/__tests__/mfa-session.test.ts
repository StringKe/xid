import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Context } from 'hono'

vi.mock('@xid-kit/db', () => ({
  createTenantDb: vi.fn(),
  schema: {
    mfaFactors: { id: 'id', userId: 'userId', factorType: 'factorType', status: 'status' },
    backupCodes: { userId: 'userId', used: 'used' },
    userPhones: { id: 'id', userId: 'userId', verified: 'verified' },
    passkeyCredentials: { userId: 'userId', revokedAt: 'revokedAt' },
    sessions: { id: 'id' },
  },
}))

vi.mock('../../auth/delivery-channels', () => ({
  smsDeliveryReady: vi.fn(() => true),
}))

vi.mock('../session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../session')>()),
  recordSessionActivated: vi.fn(),
}))

vi.mock('../step-up', () => ({
  issueStepUpCookie: vi.fn(),
}))

import { createTenantDb } from '@xid-kit/db'
import { recordSessionActivated } from '../session'
import { issueStepUpCookie } from '../step-up'
import {
  activateSessionAfterMfaSetup,
  mfaSetupRedirectPath,
  resolvePostAuthMfaGate,
  shouldRequireMfaChallenge,
  shouldRequireMfaSetup,
} from '../mfa-session'
import { listMfaMethods } from '../mfa-methods'
import type { SessionData, TenantVar, XidHonoEnv } from '../types'

type FactorState = {
  totp?: boolean
  backup?: boolean
  passkey?: boolean
  smsFactor?: boolean
  verifiedPhone?: boolean
}

function tenant(mfaEnforcement: 'required' | 'optional' = 'required'): TenantVar {
  return {
    tenantId: 'tenant-1',
    issuer: 'https://tenant-1.xid.dev',
    rpId: 'tenant-1.xid.dev',
    signingKeys: { activeKid: 'k1', defaultAlg: 'ES256', keys: [] },
    policy: { mfaEnforcement },
  } as TenantVar
}

function context(): Context<XidHonoEnv> {
  return { env: { DB: {} } } as Context<XidHonoEnv>
}

function setupSession(overrides: Partial<SessionData> = {}): SessionData {
  return {
    sessionId: 'sess_1',
    userId: 'u_1',
    status: 'pending_mfa_setup',
    activeOrgId: null,
    authenticatedAt: new Date(),
    lastActiveAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
    rememberMe: false,
    isImpersonation: false,
    impersonatorUserId: null,
    acr: 'urn:xid:aal1',
    amr: ['pwd'],
    aal: 1,
    ...overrides,
  }
}

function mockFactors(state: FactorState): ReturnType<typeof vi.fn> {
  const sessionUpdate = vi.fn().mockResolvedValue([])
  // listMfaMethods 每轮先查 TOTP 再查 SMS 因子,按调用奇偶返回对应行。
  let calls = 0
  const mfaFactorFindOne = vi.fn().mockImplementation(async () => {
    calls += 1
    if (calls % 2 === 1) return state.totp ? { id: 'mf_totp' } : undefined
    return state.smsFactor ? { id: 'mf_sms', target: 'ph_1', createdAt: new Date() } : undefined
  })
  vi.mocked(createTenantDb).mockReturnValue({
    mfaFactors: { findOne: mfaFactorFindOne },
    backupCodes: { findOne: vi.fn().mockResolvedValue(state.backup ? { id: 'bc_1' } : undefined) },
    passkeyCredentials: {
      findMany: vi
        .fn()
        .mockResolvedValue(
          state.passkey
            ? [{ id: 'pk_1', credentialId: 'cred_1', transports: [], createdAt: new Date() }]
            : [],
        ),
    },
    userPhones: {
      findOne: vi
        .fn()
        .mockResolvedValue(state.verifiedPhone ? { id: 'ph_1', phone: '+15555550100' } : undefined),
    },
    sessions: { update: sessionUpdate },
  } as unknown as ReturnType<typeof createTenantDb>)
  return sessionUpdate
}

describe('shouldRequireMfaSetup', () => {
  beforeEach(() => vi.clearAllMocks())

  it('does not require setup when only a passkey exists after password login', async () => {
    mockFactors({ passkey: true })

    const result = await shouldRequireMfaSetup(context(), tenant(), {
      userId: 'u_1',
      sessionAmr: ['pwd'],
    })

    expect(result).toBe(false)
  })

  it('does not require setup after passkey primary login even with no other factor', async () => {
    mockFactors({ passkey: true })

    const result = await shouldRequireMfaSetup(context(), tenant(), {
      userId: 'u_1',
      sessionAmr: ['phr'],
    })

    expect(result).toBe(false)
  })

  it('requires setup when the user only has a verified phone and no SMS factor', async () => {
    mockFactors({ verifiedPhone: true })

    const result = await shouldRequireMfaSetup(context(), tenant(), {
      userId: 'u_1',
      sessionAmr: ['pwd'],
    })

    expect(result).toBe(true)
  })
})

describe('shouldRequireMfaChallenge', () => {
  beforeEach(() => vi.clearAllMocks())

  it('requires challenge when user has passkeys and primary auth was not passkey', async () => {
    mockFactors({ passkey: true })

    const result = await shouldRequireMfaChallenge(context(), tenant(), {
      userId: 'u_1',
      sessionAmr: ['pwd'],
    })

    expect(result).toBe(true)
  })

  it('does not count the primary passkey as a second factor', async () => {
    mockFactors({ passkey: true })

    const result = await shouldRequireMfaChallenge(context(), tenant(), {
      userId: 'u_1',
      sessionAmr: ['phr'],
    })

    expect(result).toBe(false)
  })

  it('still challenges a passkey login when the user has TOTP', async () => {
    mockFactors({ totp: true, passkey: true })

    const result = await shouldRequireMfaChallenge(context(), tenant(), {
      userId: 'u_1',
      sessionAmr: ['phr'],
    })

    expect(result).toBe(true)
  })

  it('does not treat a verified phone as an MFA factor under optional policy', async () => {
    mockFactors({ verifiedPhone: true })

    const result = await shouldRequireMfaChallenge(context(), tenant('optional'), {
      userId: 'u_1',
      sessionAmr: ['sms'],
    })

    expect(result).toBe(false)
  })

  it('does not offer an SMS factor whose phone is outside the allowed regions', async () => {
    mockFactors({ smsFactor: true, verifiedPhone: true })

    const methods = await listMfaMethods(context(), tenant(), {
      userId: 'u_1',
      sessionAmr: ['pwd'],
    })

    expect(methods).not.toContain('sms')
  })

  it('does not accept the SMS factor as second factor after SMS sign-in', async () => {
    mockFactors({ smsFactor: true, verifiedPhone: true })

    const result = await shouldRequireMfaChallenge(context(), tenant(), {
      userId: 'u_1',
      sessionAmr: ['sms'],
    })

    expect(result).toBe(false)
  })
})

describe('activateSessionAfterMfaSetup', () => {
  beforeEach(() => vi.clearAllMocks())

  it('records the enrolled TOTP as a second factor when forced setup completes', async () => {
    const sessionUpdate = mockFactors({ totp: true })

    await activateSessionAfterMfaSetup(context(), tenant(), {
      session: setupSession(),
      method: 'totp',
    })

    expect(sessionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'active',
        acr: 'urn:xid:aal2',
        amr: ['pwd', 'otp', 'mfa'],
        aal: 2,
      }),
      expect.anything(),
    )
    expect(recordSessionActivated).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sessionId: 'sess_1', status: 'pending_mfa_setup' }),
    )
  })

  it('issues a step-up cookie bound to the session so backup codes can follow immediately', async () => {
    mockFactors({ totp: true })

    await activateSessionAfterMfaSetup(context(), tenant(), {
      session: setupSession(),
      method: 'totp',
    })

    expect(issueStepUpCookie).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        method: 'totp',
        session: expect.objectContaining({ sessionId: 'sess_1', userId: 'u_1' }),
      }),
    )
  })

  it('leaves an already active session untouched', async () => {
    const sessionUpdate = mockFactors({ totp: true })

    await activateSessionAfterMfaSetup(context(), tenant(), {
      session: setupSession({ status: 'active' }),
      method: 'totp',
    })

    expect(sessionUpdate).not.toHaveBeenCalled()
    expect(issueStepUpCookie).not.toHaveBeenCalled()
  })

  it('keeps the session pending while the enrolled factor does not satisfy the policy', async () => {
    const sessionUpdate = mockFactors({})

    await activateSessionAfterMfaSetup(context(), tenant(), {
      session: setupSession(),
      method: 'totp',
    })

    expect(sessionUpdate).not.toHaveBeenCalled()
    expect(recordSessionActivated).not.toHaveBeenCalled()
    expect(issueStepUpCookie).not.toHaveBeenCalled()
  })

  it('points forced enrollment at the Hosted Auth setup route', () => {
    expect(mfaSetupRedirectPath('/authorize?authz_request_id=a')).toBe(
      '/mfa/setup?redirect_to=%2Fauthorize%3Fauthz_request_id%3Da',
    )
  })
})

describe('resolvePostAuthMfaGate', () => {
  beforeEach(() => vi.clearAllMocks())

  it('redirects to MFA setup when enforcement is required and no factor exists', async () => {
    mockFactors({})

    const gate = await resolvePostAuthMfaGate(context(), tenant(), {
      userId: 'u_1',
      returnPath: '/console',
      sessionAmr: ['pwd'],
    })

    expect(gate.sessionStatus).toBe('pending_mfa_setup')
    expect(gate.redirectUrl).toBe(mfaSetupRedirectPath('/console'))
  })

  it('issues an active session for a passkey-only user under required policy', async () => {
    mockFactors({ passkey: true })

    const gate = await resolvePostAuthMfaGate(context(), tenant(), {
      userId: 'u_1',
      returnPath: '/console',
      sessionAmr: ['phr'],
    })

    expect(gate).toEqual({})
  })
})
