import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Context } from 'hono'

vi.mock('@xid-kit/db', () => ({
  createTenantDb: vi.fn(),
  schema: {
    mfaFactors: { id: 'id', userId: 'userId', factorType: 'factorType', status: 'status' },
    backupCodes: { userId: 'userId', used: 'used' },
    userPhones: { id: 'id', userId: 'userId', verified: 'verified' },
    passkeyCredentials: { userId: 'userId', revokedAt: 'revokedAt' },
  },
}))

vi.mock('../../auth/delivery-channels', () => ({
  smsDeliveryReady: vi.fn(() => true),
}))

import { createTenantDb } from '@xid-kit/db'
import {
  mfaSetupRedirectPath,
  resolvePostAuthMfaGate,
  shouldRequireMfaChallenge,
  shouldRequireMfaSetup,
} from '../mfa-session'
import type { TenantVar, XidHonoEnv } from '../types'

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

function mockFactors(state: FactorState): void {
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
  } as unknown as ReturnType<typeof createTenantDb>)
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

  it('does not accept the SMS factor as second factor after SMS sign-in', async () => {
    mockFactors({ smsFactor: true, verifiedPhone: true })

    const result = await shouldRequireMfaChallenge(context(), tenant(), {
      userId: 'u_1',
      sessionAmr: ['sms'],
    })

    expect(result).toBe(false)
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
