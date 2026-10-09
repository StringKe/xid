// passkey-mfa-eligibility 单元测试:登录挑战排除一次认证用过的 passkey,step-up 接受任意未吊销凭证。
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
  },
}))

const CREATED_AT = new Date('2026-01-01T00:00:00Z')

const CRED_A = {
  id: 'pk_a',
  credentialId: 'cred_a',
  transports: ['internal'],
  deviceName: 'Laptop',
  createdAt: CREATED_AT,
}

const CRED_B = {
  id: 'pk_b',
  credentialId: 'cred_b',
  transports: [],
  deviceName: null,
  createdAt: CREATED_AT,
}

function makeSession(amr: SessionData['amr'], status: SessionData['status']): SessionData {
  return {
    sessionId: 'sess_1',
    userId: 'user_1',
    status,
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

function mockDb(credentials: (typeof CRED_A | typeof CRED_B)[]) {
  const db = { passkeyCredentials: { findMany: vi.fn().mockResolvedValue(credentials) } }
  vi.mocked(createTenantDb).mockReturnValue(db as unknown as ReturnType<typeof createTenantDb>)
  return db
}

describe('listEligiblePasskeyCredentials', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns all active credentials as second factor after password login', async () => {
    mockDb([CRED_A, CRED_B])
    const db = createTenantDb({} as D1Database, schema, 'tenant_1')

    const result = await listEligiblePasskeyCredentials(db, makeSession(['pwd'], 'pending_mfa'))

    expect(result.map((row) => row.credentialId)).toEqual(['cred_a', 'cred_b'])
  })

  it('offers no passkey as second factor after passkey primary login', async () => {
    const mocked = mockDb([CRED_A, CRED_B])
    const db = createTenantDb({} as D1Database, schema, 'tenant_1')

    const result = await listEligiblePasskeyCredentials(db, makeSession(['phr'], 'pending_mfa'))

    expect(result).toEqual([])
    expect(mocked.passkeyCredentials.findMany).not.toHaveBeenCalled()
  })

  it('accepts any active passkey for step-up on an active passkey session', async () => {
    mockDb([CRED_A, CRED_B])
    const db = createTenantDb({} as D1Database, schema, 'tenant_1')

    const result = await listEligiblePasskeyCredentials(db, makeSession(['phr'], 'active'))

    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({
      id: 'pk_a',
      credentialId: 'cred_a',
      transports: ['internal'],
      deviceName: 'Laptop',
      createdAt: CREATED_AT,
      rpId: null,
    })
  })
})
