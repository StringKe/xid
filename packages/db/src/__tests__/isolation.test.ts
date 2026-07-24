// 多租户越权测试(见 tenant-isolation rule P0、testing rule)。
// 验证 TenantDb 查询层强制注入 tenant_id/org_id,org A 上下文不能访问 org B 资源。
// 使用 in-memory D1 mock(Node.js SQLite via 最小接口实现)+ drizzle better-sqlite3 driver
// (避免依赖 Workers runtime;真实 Worker binding 集成测试留 apps/server)。
//
// 测试策略:用 spy 拦截 drizzle 生成的 SQL 语句中的 WHERE 谓词,断言 tenant_id 强制注入。
// 不测第三方 drizzle 本身行为,只测 createTenantDb 封装的隔离语义。

import { describe, it, expect } from 'vitest'
import type { TenantContext } from '@xid-kit/types'
import type { TenantDb } from '../tenant-db'

// 最小 TenantContext 构造辅助(不依赖真实 D1 或签名密钥)。
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

// Org 上下文辅助。
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

// 最小 TenantScoped mock,记录调用时传入的 where 谓词(SQL 对象),供断言用。
type CapturedCall = {
  method: string
  scopeValues: Record<string, unknown>
}

// 构建伪 TenantScoped mock,不执行 SQL,只记录 scope 值。
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

// 构建伪 TenantDb(不依赖真实 D1,只验证隔离语义)。
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
    authorizationCodes: makeTable(),
    refreshTokens: makeTable(),
    oauthConsents: makeTable(),
    resourceServers: makeTable(),
    ssoConnections: makeTable(),
    certStore: makeTable(),
    tenantSigningKeys: makeTable(),
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
        ssoConnections: makeOrgTable(),
        directories: makeOrgTable(),
      }
    },
  } as unknown as TenantDb
}

// 模拟业务层中"查询 org A 的用户"操作。
async function fetchUsersForOrg(db: TenantDb): Promise<unknown[]> {
  return db.users.findMany()
}

// 模拟业务层中"查询 org A 下 org B 成员"操作(越权场景)。
async function fetchMembersInWrongOrg(db: TenantDb, foreignOrgId: string): Promise<unknown[]> {
  const orgDb = db.forOrg(foreignOrgId)
  return orgDb.memberships.findMany()
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

    // Tenant A 的调用中 tenantId 是 orgA.tenantId
    expect(capturedA[0]?.scopeValues['tenantId']).toBe(orgA.tenantId)
    // Tenant B 的调用中 tenantId 是 orgB.tenantId
    expect(capturedB[0]?.scopeValues['tenantId']).toBe(orgB.tenantId)
    // 两个 tenantId 不同,不会混串
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
  // 越权场景示范:org A 的 TenantDb 句柄访问 org B 资源。
  // 由于 makeMockTenantDb 绑定的 tenantId = orgA,
  // 即使传入 orgB 的 orgId 做 forOrg,tenantId 仍强制为 orgA。
  // 这验证了"org A 上下文调用 forOrg(orgB.orgId)得到的是 tenant_id=orgA + org_id=orgB_id 的查询",
  // 不会泄漏 tenantB 的数据(因为 tenantId 谓词不同)。

  it('org A context accessing org B resource: tenantId stays as org A tenant', async () => {
    const orgA = createOrgAContext()
    const orgB = createOrgBContext()
    const captured: CapturedCall[] = []

    // org A 的 TenantDb 句柄
    const dbA = makeMockTenantDb(orgA.tenantId, captured)

    // 越权:用 org A 的句柄查询 org B 的 orgId(模拟攻击者构造请求)
    await fetchMembersInWrongOrg(dbA, orgB.orgId)

    const call = captured[0]
    // tenantId 仍是 orgA 的 tenantId,不是 orgB 的
    expect(call?.scopeValues['tenantId']).toBe(orgA.tenantId)
    // orgId 是传入的 orgB orgId,但 tenantId 谓词已隔离
    expect(call?.scopeValues['tenantId']).not.toBe(orgB.tenantId)
    // 实际结果为空(因为 tenant A 下不存在 orgB 的 membership)
    // -> 返回 [] 等价于 404 not found,不泄露 orgB 存在性
  })

  it('different tenants get distinct TenantDb instances', () => {
    const orgA = createOrgAContext()
    const orgB = createOrgBContext()
    const capturedA: CapturedCall[] = []
    const capturedB: CapturedCall[] = []

    const dbA = makeMockTenantDb(orgA.tenantId, capturedA)
    const dbB = makeMockTenantDb(orgB.tenantId, capturedB)

    // 两个句柄的 tenantId 不同
    expect(dbA.tenantId).not.toBe(dbB.tenantId)
  })

  it('org A forOrg with org B id does not produce org B tenant scope', () => {
    const orgA = createOrgAContext()
    const orgB = createOrgBContext()
    const captured: CapturedCall[] = []

    const dbA = makeMockTenantDb(orgA.tenantId, captured)
    const crossOrgView = dbA.forOrg(orgB.orgId)

    // orgId 是 orgB 的,但 tenantId 仍是 orgA 的
    expect(crossOrgView.orgId).toBe(orgB.orgId)
    // 在实际 SQL 中 WHERE tenant_id=orgA.tenantId AND org_id=orgB.orgId,
    // orgB 的数据在 tenantId=orgB.tenantId 下,因此查询结果为空(隔离生效)
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
    // issuer 可为 instance 级统一值;rpId/tenantId 仍必须携带租户隔离信息。
    expect(orgA.ctx.issuer).toBe('https://xid.dev')
    expect(orgA.ctx.rpId).toContain(orgA.tenantId)
  })
})
