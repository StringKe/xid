// jit.ts 单元测试。
// 验证:分支 A(idp_id 精确匹配)/分支 B(email 关联)/分支 C(JIT 关闭)/分支 D(新建)。

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SsoAssertion } from '../jit'

// --- 租户查询层 mock ---
const mockUserIdentitiesFindOne = vi.fn()
const mockUserIdentitiesUpdate = vi.fn()
const mockUserIdentitiesInsert = vi.fn()
const mockUserEmailsFindOne = vi.fn()
const mockUsersInsert = vi.fn()
const mockUsersUpdate = vi.fn()
const mockSsoConnectionsFindOne = vi.fn()
const mockMembershipsFindOne = vi.fn()
const mockMembershipsUpdate = vi.fn()
const mockMembershipsInsert = vi.fn()
const mockUserEmailsInsert = vi.fn()

function makeTenantDbMock() {
  return {
    ssoConnections: { findOne: mockSsoConnectionsFindOne },
    userIdentities: {
      findOne: mockUserIdentitiesFindOne,
      update: mockUserIdentitiesUpdate,
      insert: mockUserIdentitiesInsert,
    },
    userEmails: { findOne: mockUserEmailsFindOne, insert: mockUserEmailsInsert },
    users: { insert: mockUsersInsert, update: mockUsersUpdate },
    memberships: {
      findOne: mockMembershipsFindOne,
      update: mockMembershipsUpdate,
      insert: mockMembershipsInsert,
    },
    forOrg: () => makeTenantDbMock(),
  }
}

vi.mock('@xid-kit/db', () => ({
  createTenantDb: vi.fn(() => makeTenantDbMock()),
  schema: {
    ssoConnections: { id: 'id' },
    userIdentities: {
      provider: 'provider',
      providerUserId: 'provider_user_id',
      id: 'id',
      userId: 'user_id',
    },
    userEmails: { email: 'email', userId: 'user_id' },
    users: { id: 'id' },
    memberships: { userId: 'user_id', orgId: 'org_id', id: 'id' },
  },
}))

import { isAppError } from '../../lib/errors'
import { jitProvision } from '../jit'

function makeConnection(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'conn-1',
    orgId: 'org-1',
    jitEnabled: true,
    roleMapping: {},
    status: 'active',
    protocol: 'oidc',
    ...overrides,
  }
}

function makeAssertion(overrides: Partial<SsoAssertion> = {}): SsoAssertion {
  return {
    idpId: 'idp-user-001',
    connectionId: 'conn-1',
    orgId: 'org-1',
    email: 'alice@corp.example.com',
    emailVerified: true,
    firstName: 'Alice',
    lastName: 'Smith',
    groups: [],
    customAttributes: {},
    ...overrides,
  }
}

const fakeAuditQueue = { send: vi.fn().mockResolvedValue(undefined) }
const fakeEnv = { DB: {}, AUDIT_QUEUE: fakeAuditQueue } as unknown as Env

function makeHostedAuthPolicy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    identifierMode: 'email',
    requireVerifiedEmail: true,
    allowedEmailDomains: [],
    blockedEmailDomains: [],
    forceSso: false,
    allowUserCreation: true,
    allowExistingUserLogin: true,
    password: { enabled: false, allowLogin: false, allowUserCreation: false },
    magicLink: { enabled: false, allowLogin: false, allowUserCreation: false },
    emailOtp: { enabled: false, allowLogin: false, allowUserCreation: false },
    smsOtp: { enabled: false, allowLogin: false, allowUserCreation: false },
    passkey: { enabled: false, allowLogin: false, allowUserCreation: false },
    enterpriseSso: {
      enabled: true,
      allowLogin: true,
      allowJitUserCreation: true,
      domainDiscovery: true,
      allowedEmailDomains: [],
      blockedEmailDomains: [],
    },
    ...overrides,
  }
}

function makeContext(tenantId = 'tenant-1', hostedAuth = makeHostedAuthPolicy()) {
  return {
    env: fakeEnv,
    req: { url: 'https://tenant-1.xid.dev/sso/oidc/callback', header: () => null },
    get: (key: string) => {
      if (key === 'tenant') {
        return {
          tenantId,
          issuer: `https://${tenantId}.xid.dev`,
          rpId: `${tenantId}.xid.dev`,
          signingKeys: { activeKid: 'k1', defaultAlg: 'ES256', keys: [] },
          policy: { hostedAuth },
        }
      }
      return null
    },
  } as unknown as import('hono').Context<import('../../lib/types').XidHonoEnv>
}

describe('jitProvision -- 分支 A/B', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fakeAuditQueue.send.mockResolvedValue(undefined)
  })

  it('分支 A:idp_id 精确匹配 -> 返回 userId,不新建', async () => {
    mockSsoConnectionsFindOne.mockResolvedValue(makeConnection())
    mockUserIdentitiesFindOne.mockResolvedValue({ id: 'identity-1', userId: 'user-existing' })
    mockUserIdentitiesUpdate.mockResolvedValue([])
    mockUsersUpdate.mockResolvedValue([])
    mockMembershipsFindOne.mockResolvedValue({ id: 'mem-1', role: 'member' })

    const result = await jitProvision(makeContext(), makeAssertion())

    expect(result.provisioned).toBe(false)
    expect(result.userId).toBe('user-existing')
    expect(mockUsersInsert).not.toHaveBeenCalled()
    expect(fakeAuditQueue.send).not.toHaveBeenCalled()
  })

  it('分支 B:email 关联(已验证) -> 返回 userId,不新建', async () => {
    mockSsoConnectionsFindOne.mockResolvedValue(makeConnection())
    mockUserIdentitiesFindOne.mockResolvedValue(undefined)
    mockUserEmailsFindOne.mockResolvedValue({ id: 'email-1', userId: 'user-email-match' })
    mockUserIdentitiesInsert.mockResolvedValue({})
    mockUsersUpdate.mockResolvedValue([])
    mockMembershipsFindOne.mockResolvedValue({ id: 'mem-1', role: 'member' })

    const result = await jitProvision(makeContext(), makeAssertion({ emailVerified: true }))

    expect(result.provisioned).toBe(false)
    expect(result.userId).toBe('user-email-match')
    expect(mockUsersInsert).not.toHaveBeenCalled()
  })

  it('分支 B 失败:email 存在但未验证 -> 抛 invalid_credentials', async () => {
    mockSsoConnectionsFindOne.mockResolvedValue(makeConnection())
    mockUserIdentitiesFindOne.mockResolvedValue(undefined)
    mockUserEmailsFindOne.mockResolvedValue({ id: 'email-1', userId: 'user-unverified' })

    await expect(
      jitProvision(makeContext(), makeAssertion({ emailVerified: false })),
    ).rejects.toSatisfy(
      (err: unknown) =>
        isAppError(err) && err.code === 'invalid_credentials' && err.longMessage === undefined,
    )
  })
})

describe('jitProvision -- 分支 C', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fakeAuditQueue.send.mockResolvedValue(undefined)
  })

  it('分支 C:JIT 关闭且无已存在用户 -> 抛 provisioning_disabled', async () => {
    mockSsoConnectionsFindOne.mockResolvedValue(makeConnection({ jitEnabled: false }))
    mockUserIdentitiesFindOne.mockResolvedValue(undefined)
    mockUserEmailsFindOne.mockResolvedValue(undefined)

    await expect(jitProvision(makeContext(), makeAssertion())).rejects.toSatisfy(
      (err: unknown) => isAppError(err) && err.code === 'provisioning_disabled',
    )
    expect(mockUsersInsert).not.toHaveBeenCalled()
  })

  it('connection 不存在 -> 抛 connection_not_found', async () => {
    mockSsoConnectionsFindOne.mockResolvedValue(undefined)

    await expect(jitProvision(makeContext(), makeAssertion())).rejects.toSatisfy(
      (err: unknown) => isAppError(err) && err.code === 'connection_not_found',
    )
  })
})

describe('jitProvision -- 分支 D', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fakeAuditQueue.send.mockResolvedValue(undefined)
  })

  // 设置新建用户路径所需 mock(不设 connection,由调用方设置)。
  function setupNewUserDeps(newUserId: string) {
    mockUserIdentitiesFindOne.mockResolvedValue(undefined)
    mockUserEmailsFindOne.mockResolvedValue(undefined)
    mockUsersInsert.mockResolvedValue({ id: newUserId })
    mockUserEmailsInsert.mockResolvedValue({})
    mockUsersUpdate.mockResolvedValue([])
    mockUserIdentitiesInsert.mockResolvedValue({})
    mockMembershipsFindOne.mockResolvedValue(undefined)
    mockMembershipsInsert.mockResolvedValue({})
  }

  it('分支 D:全新用户 -> 新建并标 provisionedBy=jit_sso', async () => {
    const newUserId = 'new-user-uuid'
    vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce(
      newUserId as unknown as `${string}-${string}-${string}-${string}-${string}`,
    )
    mockSsoConnectionsFindOne.mockResolvedValue(makeConnection())
    setupNewUserDeps(newUserId)

    const result = await jitProvision(makeContext(), makeAssertion())

    expect(result.provisioned).toBe(true)
    const insertCall = mockUsersInsert.mock.calls[0]?.[0] as Record<string, unknown>
    expect(insertCall['provisionedBy']).toBe('jit_sso')
    expect(fakeAuditQueue.send).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'user.created',
        payload: expect.objectContaining({ provisionedBy: 'jit_sso' }),
      }),
    )
  })

  it('roleMapping 命中 group -> 正确 role 写入 membership', async () => {
    mockSsoConnectionsFindOne.mockResolvedValue(
      makeConnection({ roleMapping: { Engineering: 'admin' } }),
    )
    setupNewUserDeps('u1')
    await jitProvision(makeContext(), makeAssertion({ groups: ['Engineering'] }))
    const insertCall = mockMembershipsInsert.mock.calls[0]?.[0] as Record<string, unknown>
    expect(insertCall['role']).toBe('admin')
  })

  it('enterprise SSO JIT user creation disabled -> 不创建用户并写策略拒绝审计', async () => {
    mockSsoConnectionsFindOne.mockResolvedValue(makeConnection({ jitEnabled: true }))
    setupNewUserDeps('u1')

    await expect(
      jitProvision(
        makeContext(
          'tenant-1',
          makeHostedAuthPolicy({
            enterpriseSso: {
              enabled: true,
              allowLogin: true,
              allowJitUserCreation: false,
              domainDiscovery: true,
              allowedEmailDomains: [],
              blockedEmailDomains: [],
            },
          }),
        ),
        makeAssertion(),
      ),
    ).rejects.toSatisfy((err: unknown) => isAppError(err) && err.code === 'invalid_credentials')

    expect(mockUsersInsert).not.toHaveBeenCalled()
    expect(fakeAuditQueue.send).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        action: 'auth.policy_denied',
        payload: expect.objectContaining({
          method: 'enterpriseSso',
          action: 'user_creation',
          reason: 'enterprise_sso_jit_user_creation_disabled',
          identifierType: 'email',
          emailDomain: 'corp.example.com',
        }),
      }),
    )
    expect(JSON.stringify(fakeAuditQueue.send.mock.calls[0])).not.toContain(
      'alice@corp.example.com',
    )
  })

  it('enterprise SSO blocked domain -> 不创建用户并写策略拒绝审计', async () => {
    mockSsoConnectionsFindOne.mockResolvedValue(makeConnection())
    setupNewUserDeps('u1')

    await expect(
      jitProvision(
        makeContext(
          'tenant-1',
          makeHostedAuthPolicy({
            enterpriseSso: {
              enabled: true,
              allowLogin: true,
              allowJitUserCreation: true,
              domainDiscovery: true,
              allowedEmailDomains: [],
              blockedEmailDomains: ['corp.example.com'],
            },
          }),
        ),
        makeAssertion(),
      ),
    ).rejects.toSatisfy((err: unknown) => isAppError(err) && err.code === 'invalid_credentials')

    expect(mockUsersInsert).not.toHaveBeenCalled()
    expect(fakeAuditQueue.send).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.policy_denied',
        payload: expect.objectContaining({
          method: 'enterpriseSso',
          action: 'user_creation',
          reason: 'enterprise_sso_email_domain_blocked',
          identifierType: 'email',
          emailDomain: 'corp.example.com',
        }),
      }),
    )
  })

  it('全局 blockedEmailDomains 拒绝 OIDC JIT 创建并写策略拒绝审计', async () => {
    mockSsoConnectionsFindOne.mockResolvedValue(makeConnection())
    setupNewUserDeps('u1')

    await expect(
      jitProvision(
        makeContext(
          'tenant-1',
          makeHostedAuthPolicy({
            blockedEmailDomains: ['corp.example.com'],
          }),
        ),
        makeAssertion(),
      ),
    ).rejects.toSatisfy((err: unknown) => isAppError(err) && err.code === 'invalid_credentials')

    expect(mockUsersInsert).not.toHaveBeenCalled()
    expect(fakeAuditQueue.send).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.policy_denied',
        payload: expect.objectContaining({
          method: 'enterpriseSso',
          action: 'user_creation',
          reason: 'email_domain_blocked',
          identifierType: 'email',
          emailDomain: 'corp.example.com',
        }),
      }),
    )
    expect(JSON.stringify(fakeAuditQueue.send.mock.calls[0])).not.toContain(
      'alice@corp.example.com',
    )
  })

  it('全局 allowedEmailDomains 拒绝 OIDC JIT 创建并写策略拒绝审计', async () => {
    mockSsoConnectionsFindOne.mockResolvedValue(makeConnection())
    setupNewUserDeps('u1')

    await expect(
      jitProvision(
        makeContext(
          'tenant-1',
          makeHostedAuthPolicy({
            allowedEmailDomains: ['allowed.example.com'],
          }),
        ),
        makeAssertion(),
      ),
    ).rejects.toSatisfy((err: unknown) => isAppError(err) && err.code === 'invalid_credentials')

    expect(mockUsersInsert).not.toHaveBeenCalled()
    expect(fakeAuditQueue.send).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.policy_denied',
        payload: expect.objectContaining({
          method: 'enterpriseSso',
          action: 'user_creation',
          reason: 'email_domain_not_allowed',
          identifierType: 'email',
          emailDomain: 'corp.example.com',
        }),
      }),
    )
  })

  it('enterprise SSO login disabled -> 已有 identity 也不能登录并写策略拒绝审计', async () => {
    mockSsoConnectionsFindOne.mockResolvedValue(makeConnection())
    mockUserIdentitiesFindOne.mockResolvedValue({ id: 'identity-1', userId: 'user-existing' })

    await expect(
      jitProvision(
        makeContext(
          'tenant-1',
          makeHostedAuthPolicy({
            enterpriseSso: {
              enabled: true,
              allowLogin: false,
              allowJitUserCreation: true,
              domainDiscovery: true,
              allowedEmailDomains: [],
              blockedEmailDomains: [],
            },
          }),
        ),
        makeAssertion(),
      ),
    ).rejects.toSatisfy((err: unknown) => isAppError(err) && err.code === 'invalid_credentials')

    expect(mockUsersUpdate).not.toHaveBeenCalled()
    expect(mockMembershipsInsert).not.toHaveBeenCalled()
    expect(fakeAuditQueue.send).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.policy_denied',
        payload: expect.objectContaining({
          method: 'enterpriseSso',
          action: 'login',
          reason: 'enterprise_sso_login_disabled',
          identifierType: 'email',
          emailDomain: 'corp.example.com',
        }),
      }),
    )
  })
})

describe('jitProvision -- orgId 权威性(越权防护)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fakeAuditQueue.send.mockResolvedValue(undefined)
  })

  it('assertion.orgId 与 connection.orgId 不一致 -> 拒绝,不写 membership/audit', async () => {
    // connection 归属 org-1,assertion 伪称 org-victim,必须拒绝(防跨 org 越权)。
    mockSsoConnectionsFindOne.mockResolvedValue(makeConnection({ orgId: 'org-1' }))
    mockUserIdentitiesFindOne.mockResolvedValue({ id: 'identity-1', userId: 'user-existing' })

    await expect(
      jitProvision(makeContext(), makeAssertion({ orgId: 'org-victim' })),
    ).rejects.toSatisfy((err: unknown) => isAppError(err) && err.code === 'invalid_credentials')
    expect(mockMembershipsInsert).not.toHaveBeenCalled()
    expect(mockMembershipsUpdate).not.toHaveBeenCalled()
    expect(fakeAuditQueue.send).not.toHaveBeenCalled()
  })

  it('membership/audit 用 connection.orgId 而非 assertion.orgId', async () => {
    // 两者一致(权威 = connection),membership 与 audit 都落到 connection.orgId。
    mockSsoConnectionsFindOne.mockResolvedValue(makeConnection({ orgId: 'org-auth' }))
    mockUserIdentitiesFindOne.mockResolvedValue(undefined)
    mockUserEmailsFindOne.mockResolvedValue(undefined)
    mockUsersInsert.mockResolvedValue({ id: 'u-new' })
    mockUserEmailsInsert.mockResolvedValue({})
    mockUsersUpdate.mockResolvedValue([])
    mockUserIdentitiesInsert.mockResolvedValue({})
    mockMembershipsFindOne.mockResolvedValue(undefined)
    mockMembershipsInsert.mockResolvedValue({})

    await jitProvision(makeContext(), makeAssertion({ orgId: 'org-auth' }))

    const memInsert = mockMembershipsInsert.mock.calls[0]?.[0] as Record<string, unknown>
    expect(memInsert['orgId']).toBe('org-auth')
    expect(fakeAuditQueue.send).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 'org-auth', action: 'user.created' }),
    )
  })
})
