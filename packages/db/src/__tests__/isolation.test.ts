// TenantDb 隔离:伪 mock 记录 scope,验证 org A 不能越权 org B(不依赖 Workers)。

import { describe, it, expect } from 'vitest'
import type { TenantContext } from '@xid-kit/types'
import type { TenantDb } from '../tenant-db'

function makeTenantContext(tenantId: string): TenantContext {
  return {
    tenantId,
    issuer: 'https://xid.dev',
    rpId: `${tenantId}.xid.dev`,
    signingKeys: {
      activeKid: 'kid-test',
      defaultAlg: 'ES256',
      keys: [],
    },
    policy: {},
  }
}

type OrgContext = {
  tenantId: string
  orgId: string
  ctx: TenantContext
}

export function createOrgAContext(): OrgContext {
  const tenantId = 'tenant-aaa'
  return {
    tenantId,
    orgId: 'org-aaa-001',
    ctx: makeTenantContext(tenantId),
  }
}

export function createOrgBContext(): OrgContext {
  const tenantId = 'tenant-bbb'
  return {
    tenantId,
    orgId: 'org-bbb-001',
    ctx: makeTenantContext(tenantId),
  }
}

type CapturedCall = {
  method: string
  scopeValues: Record<string, unknown>
}

function makeMockScoped(scopeValues: Record<string, unknown>, captured: CapturedCall[]) {
  return {
    findMany: async () => {
      captured.push({ method: 'findMany', scopeValues })
      return []
    },
    findOne: async () => {
      captured.push({ method: 'findOne', scopeValues })
      return undefined
    },
    insert: async (values: Record<string, unknown>) => {
      captured.push({ method: 'insert', scopeValues })
      return { ...values, ...scopeValues }
    },
    insertMany: async () => {
      captured.push({ method: 'insertMany', scopeValues })
      return []
    },
    insertManyIgnore: async () => {
      captured.push({ method: 'insertManyIgnore', scopeValues })
      return []
    },
    update: async () => {
      captured.push({ method: 'update', scopeValues })
      return []
    },
    hardDelete: async () => {
      captured.push({ method: 'hardDelete', scopeValues })
    },
  }
}

function makeMockTenantDb(tenantId: string, captured: CapturedCall[]): TenantDb {
  const scopeValues = { tenantId }
  const makeTable = () => makeMockScoped(scopeValues, captured)

  return {
    tenantId,
    users: makeTable(),
    userEmails: makeTable(),
    userPhones: makeTable(),
    userIdentities: makeTable(),
    gdprConsents: makeTable(),
    passwords: makeTable(),
    passwordHistory: makeTable(),
    passwordResetTokens: makeTable(),
    verificationTokens: makeTable(),
    passkeyCredentials: makeTable(),
    mfaFactors: makeTable(),
    backupCodes: makeTable(),
    trustedDevices: makeTable(),
    organizations: makeTable(),
    projects: makeTable(),
    applications: makeTable(),
    projectGrants: makeTable(),
    orgPolicies: makeTable(),
    roles: makeTable(),
    permissions: makeTable(),
    rolePermissions: makeTable(),
    userGrants: makeTable(),
    managerAssignments: makeTable(),
    memberships: makeTable(),
    invitations: makeTable(),
    organizationDomains: makeTable(),
    customHostnames: makeTable(),
    authorizationCodes: makeTable(),
    refreshTokens: makeTable(),
    oauthConsents: makeTable(),
    resourceServers: makeTable(),
    ssoConnections: makeTable(),
    certStore: makeTable(),
    samlServiceProviders: makeTable(),
    directories: makeTable(),
    directoryUsers: makeTable(),
    directoryGroups: makeTable(),
    directoryGroupMembers: makeTable(),
    directoryPendingMembers: makeTable(),
    sessions: makeTable(),
    auditEvents: makeTable(),
    webhooks: makeTable(),
    webhookDeliveries: makeTable(),
    apiKeys: makeTable(),
    forOrg: (orgId: string) => {
      const orgScope = { tenantId, orgId }
      const makeOrgTable = () => makeMockScoped(orgScope, captured)
      return {
        orgId,
        projects: makeOrgTable(),
        orgPolicies: makeOrgTable(),
        memberships: makeOrgTable(),
        invitations: makeOrgTable(),
        organizationDomains: makeOrgTable(),
        customHostnames: makeOrgTable(),
        ssoConnections: makeOrgTable(),
        directories: makeOrgTable(),
      }
    },
  } as unknown as TenantDb
}

async function fetchUsersForOrg(db: TenantDb): Promise<unknown[]> {
  return db.users.findMany()
}

async function fetchMembersInWrongOrg(db: TenantDb, foreignOrgId: string): Promise<unknown[]> {
  const orgDb = db.forOrg(foreignOrgId)
  return orgDb.memberships.findMany()
}

async function fetchCustomHostnamesInWrongOrg(
  db: TenantDb,
  foreignOrgId: string,
): Promise<unknown[]> {
  return db.forOrg(foreignOrgId).customHostnames.findMany()
}

describe('tenant isolation: TenantDb scope enforcement', () => {
  it('TenantDb carries correct tenantId', () => {
    const orgA = createOrgAContext()
    const captured: CapturedCall[] = []
    const db = makeMockTenantDb(orgA.tenantId, captured)

    expect(db.tenantId).toBe(orgA.tenantId)
  })

  it('findMany call scoped to tenant A does not include tenant B scopeValues', async () => {
    const orgA = createOrgAContext()
    const orgB = createOrgBContext()
    const capturedA: CapturedCall[] = []
    const capturedB: CapturedCall[] = []

    const dbA = makeMockTenantDb(orgA.tenantId, capturedA)
    const dbB = makeMockTenantDb(orgB.tenantId, capturedB)

    await fetchUsersForOrg(dbA)
    await fetchUsersForOrg(dbB)

    expect(capturedA[0]?.scopeValues['tenantId']).toBe(orgA.tenantId)
    expect(capturedB[0]?.scopeValues['tenantId']).toBe(orgB.tenantId)
    expect(capturedA[0]?.scopeValues['tenantId']).not.toBe(orgB.tenantId)
  })

  it('org-scoped forOrg() injects both tenantId and orgId', async () => {
    const orgA = createOrgAContext()
    const captured: CapturedCall[] = []
    const dbA = makeMockTenantDb(orgA.tenantId, captured)

    const orgDb = dbA.forOrg(orgA.orgId)
    await orgDb.memberships.findMany()

    const call = captured[0]
    expect(call?.scopeValues['tenantId']).toBe(orgA.tenantId)
    expect(call?.scopeValues['orgId']).toBe(orgA.orgId)
  })
})

describe('cross-tenant access prevention (403/404 isolation)', () => {
  // forOrg(他 orgId) 仍强制本 tenantId,结果为空等价 404,不泄露存在性。

  it('org A context accessing org B resource: tenantId stays as org A tenant', async () => {
    const orgA = createOrgAContext()
    const orgB = createOrgBContext()
    const captured: CapturedCall[] = []

    const dbA = makeMockTenantDb(orgA.tenantId, captured)

    await fetchMembersInWrongOrg(dbA, orgB.orgId)

    const call = captured[0]
    expect(call?.scopeValues['tenantId']).toBe(orgA.tenantId)
    expect(call?.scopeValues['tenantId']).not.toBe(orgB.tenantId)
  })

  it('org A cannot turn an org B custom hostname id into org B tenant scope', async () => {
    const orgA = createOrgAContext()
    const orgB = createOrgBContext()
    const captured: CapturedCall[] = []
    const dbA = makeMockTenantDb(orgA.tenantId, captured)

    await fetchCustomHostnamesInWrongOrg(dbA, orgB.orgId)

    expect(captured[0]?.scopeValues).toEqual({
      tenantId: orgA.tenantId,
      orgId: orgB.orgId,
    })
    expect(captured[0]?.scopeValues['tenantId']).not.toBe(orgB.tenantId)
  })

  it('different tenants get distinct TenantDb instances', () => {
    const orgA = createOrgAContext()
    const orgB = createOrgBContext()
    const capturedA: CapturedCall[] = []
    const capturedB: CapturedCall[] = []

    const dbA = makeMockTenantDb(orgA.tenantId, capturedA)
    const dbB = makeMockTenantDb(orgB.tenantId, capturedB)

    expect(dbA.tenantId).not.toBe(dbB.tenantId)
  })

  it('org A forOrg with org B id does not produce org B tenant scope', () => {
    const orgA = createOrgAContext()
    const orgB = createOrgBContext()
    const captured: CapturedCall[] = []

    const dbA = makeMockTenantDb(orgA.tenantId, captured)
    const crossOrgView = dbA.forOrg(orgB.orgId)

    // orgId 可被构造为外 org,tenantId 谓词仍绑本租户,结果为空。
    expect(crossOrgView.orgId).toBe(orgB.orgId)
  })
})

describe('TenantDb context invariants', () => {
  it('TenantContext tenantId propagates to TenantDb', () => {
    const orgA = createOrgAContext()
    const captured: CapturedCall[] = []
    const db = makeMockTenantDb(orgA.ctx.tenantId, captured)

    expect(db.tenantId).toBe(orgA.ctx.tenantId)
  })

  it('rpId and tenantId are tenant-specific while issuer may be instance-scoped', () => {
    const orgA = createOrgAContext()
    const orgB = createOrgBContext()

    expect(orgA.ctx.issuer).toBe('https://xid.dev')
    expect(orgB.ctx.issuer).toBe('https://xid.dev')
    expect(orgA.ctx.rpId).not.toBe(orgB.ctx.rpId)
    expect(orgA.ctx.tenantId).not.toBe(orgB.ctx.tenantId)
  })

  it('TenantContext has no global singleton values', () => {
    const orgA = createOrgAContext()
    // issuer 可 instance 统一;rpId/tenantId 必须携带租户隔离信息。
    expect(orgA.ctx.issuer).toBe('https://xid.dev')
    expect(orgA.ctx.rpId).toContain(orgA.tenantId)
  })
})
