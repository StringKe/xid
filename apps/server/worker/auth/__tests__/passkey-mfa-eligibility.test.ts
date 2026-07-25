// passkey-mfa-eligibility 单元测试:phr 主登录后仅返回已链接 MFA passkey 凭证。
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createTenantDb, schema } from '@xid-kit/db'
import { listEligiblePasskeyCredentials } from '../passkey-mfa-eligibility'
import type { SessionData } from '../../lib/types'

vi.mock('@xid-kit/db', () => ({
  createTenantDb: vi.fn(),
  schema: {
    passkeyCredentials: {
      userId: 'userId',
      credentialId: 'credentialId',
      revokedAt: 'revokedAt',
    },
    mfaFactors: {
      userId: 'userId',
      factorType: 'factorType',
      status: 'status',
      passkeyCredentialId: 'passkeyCredentialId',
    },
  },
}))

const CRED_A = {
  credentialId: 'cred_a',
  transports: ['internal'],
  backedUp: false,
  credentialDeviceType: 'singleDevice',
  attestationFmt: 'none',
  enterpriseAttestationVerified: false,
}

const CRED_B = {
  credentialId: 'cred_b',
  transports: [],
  backedUp: true,
  credentialDeviceType: 'multiDevice',
  attestationFmt: 'none',
  enterpriseAttestationVerified: true,
}

function makeSession(amr: string[] | null): SessionData {
  return {
    sessionId: 'sess_1',
    userId: 'user_1',
    status: 'active',
    activeOrgId: null,
    authenticatedAt: new Date(),
    expiresAt: new Date(Date.now() + 86400000),
    rememberMe: false,
    isImpersonation: false,
    impersonatorUserId: null,
    acr: null,
    amr,
    aal: null,
  }
}

function mockDb(
  credentials: (typeof CRED_A)[],
  factors: Array<{ passkeyCredentialId: string | null; factorType: string; status: string }>,
) {
  const db = {
    passkeyCredentials: { findMany: vi.fn().mockResolvedValue(credentials) },
    mfaFactors: { findMany: vi.fn().mockResolvedValue(factors) },
  }
  vi.mocked(createTenantDb).mockReturnValue(db as unknown as ReturnType<typeof createTenantDb>)
  return db
}

describe('listEligiblePasskeyCredentials', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns all active credentials when session did not use passkey primary', async () => {
    mockDb([CRED_A, CRED_B], [])
    const db = createTenantDb({} as D1Database, schema, 'tenant_1')
    const result = await listEligiblePasskeyCredentials(db, makeSession(['pwd']))
    expect(result).toHaveLength(2)
    expect(result.map((row) => row.credentialId)).toEqual(['cred_a', 'cred_b'])
    expect(db.mfaFactors.findMany).not.toHaveBeenCalled()
  })

  it('filters to MFA-linked credentials after passkey primary (phr) login', async () => {
    mockDb(
      [CRED_A, CRED_B],
      [{ passkeyCredentialId: 'cred_b', factorType: 'passkey', status: 'active' }],
    )
    const db = createTenantDb({} as D1Database, schema, 'tenant_1')
    const result = await listEligiblePasskeyCredentials(db, makeSession(['phr']))
    expect(result).toHaveLength(1)
    expect(result[0]?.credentialId).toBe('cred_b')
  })

  it('returns empty list when phr session has no linked passkey MFA factors', async () => {
    mockDb([CRED_A], [])
    const db = createTenantDb({} as D1Database, schema, 'tenant_1')
    const result = await listEligiblePasskeyCredentials(db, makeSession(['phr']))
    expect(result).toEqual([])
  })
})
