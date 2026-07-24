import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Context } from 'hono'

vi.mock('@xid-kit/db', () => ({
  createTenantDb: vi.fn(),
  schema: {
    mfaFactors: { userId: 'userId', factorType: 'factorType', status: 'status' },
    backupCodes: { userId: 'userId', used: 'used' },
    userPhones: { userId: 'userId', verified: 'verified' },
    passkeyCredentials: { userId: 'userId', revokedAt: 'revokedAt' },
  },
}))

import { createTenantDb } from '@xid-kit/db'
import {
  mfaSetupRedirectPath,
  resolvePostAuthMfaGate,
  shouldRequireMfaChallenge,
  shouldRequireMfaSetup,
} from '../mfa-session'
import type { TenantVar, XidHonoEnv } from '../types'

function tenant(): TenantVar {
  return {
    tenantId: 'tenant-1',
    issuer: 'https://tenant-1.xid.dev',
    rpId: 'tenant-1.xid.dev',
    signingKeys: { activeKid: 'k1', defaultAlg: 'ES256', keys: [] },
    policy: { mfaEnforcement: 'required' },
  } as TenantVar
}

function context(): Context<XidHonoEnv> {
  return { env: { DB: {} } } as Context<XidHonoEnv>
}

describe('shouldRequireMfaSetup', () => {
  beforeEach(() => vi.clearAllMocks())

  it('does not require setup when only a passkey exists', async () => {
    vi.mocked(createTenantDb).mockReturnValue({
      mfaFactors: { findOne: vi.fn().mockResolvedValue(undefined) },
      backupCodes: { findOne: vi.fn().mockResolvedValue(undefined) },
      passkeyCredentials: { findOne: vi.fn().mockResolvedValue({ id: 'pk_1' }) },
      userPhones: { findOne: vi.fn().mockResolvedValue(undefined) },
    } as unknown as ReturnType<typeof createTenantDb>)

    await expect(shouldRequireMfaSetup(context(), tenant(), 'u_1')).resolves.toBe(false)
  })

  it('does not require setup when a challengeable TOTP factor exists', async () => {
    vi.mocked(createTenantDb).mockReturnValue({
      mfaFactors: { findOne: vi.fn().mockResolvedValue({ id: 'mf_1' }) },
      backupCodes: { findOne: vi.fn().mockResolvedValue(undefined) },
      passkeyCredentials: { findOne: vi.fn().mockResolvedValue(undefined) },
      userPhones: { findOne: vi.fn().mockResolvedValue(undefined) },
    } as unknown as ReturnType<typeof createTenantDb>)

    await expect(shouldRequireMfaSetup(context(), tenant(), 'u_1')).resolves.toBe(false)
  })
})

describe('shouldRequireMfaChallenge', () => {
  beforeEach(() => vi.clearAllMocks())

  it('requires challenge when user has passkeys and primary auth was not passkey', async () => {
    vi.mocked(createTenantDb).mockReturnValue({
      mfaFactors: { findOne: vi.fn().mockResolvedValue(undefined) },
      backupCodes: { findOne: vi.fn().mockResolvedValue(undefined) },
      passkeyCredentials: { findOne: vi.fn().mockResolvedValue({ id: 'pk_1' }) },
      userPhones: { findOne: vi.fn().mockResolvedValue(undefined) },
    } as unknown as ReturnType<typeof createTenantDb>)

    await expect(shouldRequireMfaChallenge(context(), tenant(), 'u_1', ['pwd'])).resolves.toBe(true)
  })

  it('does not count primary passkey login toward MFA challenge requirement', async () => {
    const passkeyFindOne = vi.fn().mockResolvedValue(undefined)
    vi.mocked(createTenantDb).mockReturnValue({
      mfaFactors: { findOne: passkeyFindOne },
      backupCodes: { findOne: vi.fn().mockResolvedValue(undefined) },
      passkeyCredentials: { findOne: vi.fn().mockResolvedValue(undefined) },
      userPhones: { findOne: vi.fn().mockResolvedValue(undefined) },
    } as unknown as ReturnType<typeof createTenantDb>)

    await expect(shouldRequireMfaChallenge(context(), tenant(), 'u_1', ['phr'])).resolves.toBe(
      false,
    )
    expect(passkeyFindOne).toHaveBeenCalled()
  })
})

describe('resolvePostAuthMfaGate', () => {
  it('redirects to MFA setup when enforcement is required and no factor exists', async () => {
    vi.mocked(createTenantDb).mockReturnValue({
      mfaFactors: { findOne: vi.fn().mockResolvedValue(undefined) },
      backupCodes: { findOne: vi.fn().mockResolvedValue(undefined) },
      passkeyCredentials: { findOne: vi.fn().mockResolvedValue(undefined) },
      userPhones: { findOne: vi.fn().mockResolvedValue(undefined) },
    } as unknown as ReturnType<typeof createTenantDb>)

    const gate = await resolvePostAuthMfaGate(context(), tenant(), {
      userId: 'u_1',
      returnPath: '/console',
    })
    expect(gate.sessionStatus).toBe('pending_mfa_setup')
    expect(gate.redirectUrl).toBe(mfaSetupRedirectPath('/console'))
  })
})
