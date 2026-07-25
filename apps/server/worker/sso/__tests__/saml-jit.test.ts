import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { SamlAttributes, SamlSubject } from '@xid-kit/types'
import type { SamlConnection } from '../saml-connection'

const mockUserIdentitiesFindOne = vi.fn()
const mockUserIdentitiesUpdate = vi.fn()
const mockUserIdentitiesInsert = vi.fn()
const mockUserEmailsFindOne = vi.fn()
const mockUserEmailsInsert = vi.fn()
const mockUsersInsert = vi.fn()
const mockUsersUpdate = vi.fn()
const mockMembershipsFindOne = vi.fn()
const mockMembershipsUpdate = vi.fn()
const mockMembershipsInsert = vi.fn()

vi.mock('@xid-kit/db', () => ({
  createTenantDb: vi.fn(() => ({
    userIdentities: {
      findOne: mockUserIdentitiesFindOne,
      update: mockUserIdentitiesUpdate,
      insert: mockUserIdentitiesInsert,
    },
    userEmails: { findOne: mockUserEmailsFindOne, insert: mockUserEmailsInsert },
    users: { insert: mockUsersInsert, update: mockUsersUpdate },
    forOrg: () => ({
      memberships: {
        findOne: mockMembershipsFindOne,
        update: mockMembershipsUpdate,
        insert: mockMembershipsInsert,
      },
    }),
  })),
  schema: {
    userIdentities: {
      provider: 'provider',
      providerUserId: 'provider_user_id',
      id: 'id',
    },
    userEmails: { email: 'email', verified: 'verified', userId: 'user_id' },
    users: { id: 'id' },
    memberships: { userId: 'user_id' },
  },
}))

import { isAppError } from '../../lib/errors'
import { provisionUser } from '../saml-jit'

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

const fakeAuditQueue = { send: vi.fn().mockResolvedValue(undefined) }
const fakeEnv = { DB: {}, AUDIT_QUEUE: fakeAuditQueue } as unknown as Env

function makeContext(hostedAuth = makeHostedAuthPolicy()) {
  return {
    env: fakeEnv,
    req: { url: 'https://tenant-1.xid.dev/sso/saml/conn-1/acs', header: () => null },
    get: (key: string) => {
      if (key === 'tenant') {
        return {
          tenantId: 'tenant-1',
          issuer: 'https://tenant-1.xid.dev',
          rpId: 'tenant-1.xid.dev',
          signingKeys: { activeKid: 'k1', defaultAlg: 'ES256', keys: [] },
          policy: { hostedAuth },
        }
      }
      return null
    },
  } as unknown as import('hono').Context<import('../../lib/types').XidHonoEnv>
}

function makeConnection(overrides: Partial<SamlConnection> = {}): SamlConnection {
  return {
    id: 'conn-1',
    tenantId: 'tenant-1',
    orgId: 'org-1',
    protocol: 'saml',
    status: 'active',
    slug: 'okta',
    displayName: 'Okta',
    idpEntityId: 'https://idp.example.com',
    idpSsoUrl: 'https://idp.example.com/sso',
    idpCertificates: ['CERT'],
    wantAuthnResponseSigned: true,
    wantAssertionsSigned: true,
    attributeMapping: {},
    roleMapping: {},
    jitEnabled: true,
    spCertId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  } as SamlConnection
}

function makeSubject(): SamlSubject {
  return {
    nameId: 'idp-user-1',
    nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
  }
}

function makeAttributes(overrides: Partial<SamlAttributes> = {}): SamlAttributes {
  return {
    email: 'alice@corp.example.com',
    firstName: 'Alice',
    lastName: 'Smith',
    groups: [],
    custom: {},
    ...overrides,
  }
}

function setupNewUserDeps(): void {
  mockUserIdentitiesFindOne.mockResolvedValue(undefined)
  mockUserEmailsFindOne.mockResolvedValue(undefined)
  mockUsersInsert.mockResolvedValue({})
  mockUserEmailsInsert.mockResolvedValue({})
  mockUsersUpdate.mockResolvedValue([])
  mockUserIdentitiesInsert.mockResolvedValue({})
  mockMembershipsFindOne.mockResolvedValue(undefined)
  mockMembershipsInsert.mockResolvedValue({})
}

describe('SAML JIT Hosted Auth policy', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fakeAuditQueue.send.mockResolvedValue(undefined)
  })

  it('enterprise SSO JIT user creation disabled -> 不创建用户并写策略拒绝审计', async () => {
    setupNewUserDeps()

    await expect(
      provisionUser({
        c: makeContext(
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
        connection: makeConnection(),
        subject: makeSubject(),
        attributes: makeAttributes(),
      }),
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

  it('enterprise SSO allowed domains mismatch -> 不创建用户并写策略拒绝审计', async () => {
    setupNewUserDeps()

    await expect(
      provisionUser({
        c: makeContext(
          makeHostedAuthPolicy({
            enterpriseSso: {
              enabled: true,
              allowLogin: true,
              allowJitUserCreation: true,
              domainDiscovery: true,
              allowedEmailDomains: ['allowed.example.com'],
              blockedEmailDomains: [],
            },
          }),
        ),
        connection: makeConnection(),
        subject: makeSubject(),
        attributes: makeAttributes(),
      }),
    ).rejects.toSatisfy((err: unknown) => isAppError(err) && err.code === 'invalid_credentials')

    expect(mockUsersInsert).not.toHaveBeenCalled()
    expect(fakeAuditQueue.send).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.policy_denied',
        payload: expect.objectContaining({
          method: 'enterpriseSso',
          action: 'user_creation',
          reason: 'enterprise_sso_email_domain_not_allowed',
          identifierType: 'email',
          emailDomain: 'corp.example.com',
        }),
      }),
    )
  })

  it('全局 allowedEmailDomains 拒绝 SAML JIT 创建并写策略拒绝审计', async () => {
    setupNewUserDeps()

    await expect(
      provisionUser({
        c: makeContext(makeHostedAuthPolicy({ allowedEmailDomains: ['allowed.example.com'] })),
        connection: makeConnection(),
        subject: makeSubject(),
        attributes: makeAttributes(),
      }),
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

  it('全局 blockedEmailDomains 拒绝 SAML JIT 登录并写策略拒绝审计', async () => {
    mockUserIdentitiesFindOne.mockResolvedValue({ id: 'identity-1', userId: 'user-existing' })

    await expect(
      provisionUser({
        c: makeContext(makeHostedAuthPolicy({ blockedEmailDomains: ['corp.example.com'] })),
        connection: makeConnection(),
        subject: makeSubject(),
        attributes: makeAttributes(),
      }),
    ).rejects.toSatisfy((err: unknown) => isAppError(err) && err.code === 'invalid_credentials')

    expect(mockUsersUpdate).not.toHaveBeenCalled()
    expect(mockMembershipsInsert).not.toHaveBeenCalled()
    expect(fakeAuditQueue.send).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.policy_denied',
        payload: expect.objectContaining({
          method: 'enterpriseSso',
          action: 'login',
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

  it('enterprise SSO blocked domain -> 已有 identity 也不能登录并写策略拒绝审计', async () => {
    mockUserIdentitiesFindOne.mockResolvedValue({ id: 'identity-1', userId: 'user-existing' })

    await expect(
      provisionUser({
        c: makeContext(
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
        connection: makeConnection(),
        subject: makeSubject(),
        attributes: makeAttributes(),
      }),
    ).rejects.toSatisfy((err: unknown) => isAppError(err) && err.code === 'invalid_credentials')

    expect(mockUsersUpdate).not.toHaveBeenCalled()
    expect(mockMembershipsInsert).not.toHaveBeenCalled()
    expect(fakeAuditQueue.send).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.policy_denied',
        payload: expect.objectContaining({
          method: 'enterpriseSso',
          action: 'login',
          reason: 'enterprise_sso_email_domain_blocked',
          identifierType: 'email',
          emailDomain: 'corp.example.com',
        }),
      }),
    )
  })
})
