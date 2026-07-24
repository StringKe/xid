// 租户查询层(P0 隔离控制点,见 tenant-isolation rule、08 章 9.5):
// createTenantDb(d1, ctx) 返回的句柄对每张租户表只暴露已注入 WHERE tenant_id=? 的安全 CRUD;
// org 级实体再注入 org_id。不暴露不带租户过滤的裸 query builder。
// tenant_id 取自 TenantContext(见 tenant-context rule),不信任请求 body。

import type { TenantContext } from '@xid-kit/types'
import type { InferInsertModel, InferSelectModel, SQL } from 'drizzle-orm'
import { and, eq, sql } from 'drizzle-orm'
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from './schema'

// 任意带 tenant_id 列的 SQLite 表(租户隔离的最小结构约束)。
type TenantTable = SQLiteTable & {
  tenantId: SQLiteColumn
}

// 带 org_id 的租户表(org 级实体,查询再注入 org_id)。
type OrgTable = TenantTable & {
  orgId: SQLiteColumn
}

type Row<T extends TenantTable> = InferSelectModel<T>
type Insert<T extends TenantTable> = InferInsertModel<T>

type TenantOrderBy = SQLiteColumn | SQL

export type TenantFindManyOptions = {
  limit?: number
  offset?: number
  orderBy?: TenantOrderBy | readonly TenantOrderBy[]
}

function orderByList(value: TenantFindManyOptions['orderBy']): readonly TenantOrderBy[] {
  if (value === undefined) return []
  if (Array.isArray(value)) return value as readonly TenantOrderBy[]
  return [value as TenantOrderBy]
}

// 已绑定 tenant_id(及可选 org_id)的单表安全访问器。
// 所有方法在 WHERE 链首注入租户谓词,调用方传的额外条件只能收窄不能绕过。
export type TenantScoped<T extends TenantTable> = {
  findMany: (where?: SQL, options?: TenantFindManyOptions) => Promise<Row<T>[]>
  findOne: (where?: SQL) => Promise<Row<T> | undefined>
  count: (where?: SQL) => Promise<number>
  countDistinct: (column: SQLiteColumn, where?: SQL) => Promise<number>
  countBy: (column: SQLiteColumn, where?: SQL) => Promise<ReadonlyMap<string, number>>
  insert: (values: Insert<T>) => Promise<Row<T>>
  insertMany: (values: Insert<T>[]) => Promise<Row<T>[]>
  insertManyIgnore: (values: Insert<T>[]) => Promise<Row<T>[]>
  update: (values: Partial<Insert<T>>, where?: SQL) => Promise<Row<T>[]>
  hardDelete: (where?: SQL) => Promise<void>
}

type Db = ReturnType<typeof drizzle<typeof schema>>

// 组合租户谓词与调用方附加条件(附加条件只能收窄)。
function scopedWhere(base: SQL, extra?: SQL): SQL {
  return extra ? (and(base, extra) as SQL) : base
}

function makeScoped<T extends TenantTable>(
  db: Db,
  table: T,
  scopePredicate: SQL,
  scopeValues: Record<string, unknown>,
): TenantScoped<T> {
  return {
    findMany: async (where, options) => {
      const base = db.select().from(table).where(scopedWhere(scopePredicate, where))
      const orderBy = orderByList(options?.orderBy)
      const ordered = orderBy.length === 0 ? base : base.orderBy(...orderBy)
      const limited = options?.limit === undefined ? ordered : ordered.limit(options.limit)
      const offset = options?.offset === undefined ? limited : limited.offset(options.offset)
      return offset as unknown as Row<T>[]
    },
    findOne: async (where) => {
      const rows = (await db
        .select()
        .from(table)
        .where(scopedWhere(scopePredicate, where))
        .limit(1)) as Row<T>[]
      return rows[0]
    },
    count: async (where) => {
      const rows = await db
        .select({ value: sql<number>`count(*)` })
        .from(table)
        .where(scopedWhere(scopePredicate, where))
      return rows[0]?.value ?? 0
    },
    countDistinct: async (column, where) => {
      const rows = await db
        .select({ value: sql<number>`count(distinct ${column})` })
        .from(table)
        .where(scopedWhere(scopePredicate, where))
      return rows[0]?.value ?? 0
    },
    countBy: async (column, where) => {
      const rows = await db
        .select({ key: column, value: sql<number>`count(*)` })
        .from(table)
        .where(scopedWhere(scopePredicate, where))
        .groupBy(column)
      return new Map(rows.map((row) => [String(row.key), row.value]))
    },
    insert: async (values) => {
      const rows = (await db
        .insert(table)
        .values({ ...values, ...scopeValues } as T['$inferInsert'])
        .returning()) as Row<T>[]
      return rows[0] as Row<T>
    },
    insertMany: (values) =>
      db
        .insert(table)
        .values(values.map((v) => ({ ...v, ...scopeValues })) as T['$inferInsert'][])
        .returning() as Promise<Row<T>[]>,
    insertManyIgnore: (values) =>
      db
        .insert(table)
        .values(values.map((v) => ({ ...v, ...scopeValues })) as T['$inferInsert'][])
        .onConflictDoNothing()
        .returning() as Promise<Row<T>[]>,
    update: (values, where) =>
      db
        .update(table)
        .set(values as Partial<T['$inferInsert']>)
        .where(scopedWhere(scopePredicate, where))
        .returning() as Promise<Row<T>[]>,
    hardDelete: async (where) => {
      await db.delete(table).where(scopedWhere(scopePredicate, where))
    },
  }
}

// 仅按 tenant_id 隔离的表访问器。
function tenantScoped<T extends TenantTable>(
  db: Db,
  table: T,
  tenantIdValue: string,
): TenantScoped<T> {
  return makeScoped(db, table, eq(table.tenantId, tenantIdValue) as SQL, {
    tenantId: tenantIdValue,
  })
}

// 按 tenant_id + org_id 双重隔离的 org 级表访问器(见 tenant-isolation rule org 级实体)。
function orgScoped<T extends OrgTable>(
  db: Db,
  table: T,
  tenantIdValue: string,
  orgIdValue: string,
): TenantScoped<T> {
  return makeScoped(
    db,
    table,
    and(eq(table.tenantId, tenantIdValue), eq(table.orgId, orgIdValue)) as SQL,
    { tenantId: tenantIdValue, orgId: orgIdValue },
  )
}

// 租户查询句柄:每张租户表一个已注入隔离谓词的访问器(键来自 TENANT_TABLES,见下)。
// org 级实体需显式 forOrg(orgId) 再细分,避免误用全租户视图。
export type TenantDb = ScopedTableMap & {
  tenantId: string
  // org 级二次隔离:传 orgId 得到再注入 org_id 的视图(见 tenant-isolation rule)。
  forOrg: (orgId: string) => OrgScopedDb
}

// org 级实体在确定 active org 后的二次隔离视图(tenant_id + org_id 双注入)。
// 仅含直接带 org_id 列的表;applications 经 project_id 间接归属 org(见 08 章 10.4),不在此列。
export type OrgScopedDb = {
  orgId: string
  projects: TenantScoped<typeof schema.projects>
  orgPolicies: TenantScoped<typeof schema.orgPolicies>
  memberships: TenantScoped<typeof schema.memberships>
  invitations: TenantScoped<typeof schema.invitations>
  organizationDomains: TenantScoped<typeof schema.organizationDomains>
  ssoConnections: TenantScoped<typeof schema.ssoConnections>
  directories: TenantScoped<typeof schema.directories>
  scimTargets: TenantScoped<typeof schema.scimTargets>
}

function buildOrgScoped(db: Db, tenantId: string, orgId: string): OrgScopedDb {
  return {
    orgId,
    projects: orgScoped(db, schema.projects, tenantId, orgId),
    orgPolicies: orgScoped(db, schema.orgPolicies, tenantId, orgId),
    memberships: orgScoped(db, schema.memberships, tenantId, orgId),
    invitations: orgScoped(db, schema.invitations, tenantId, orgId),
    organizationDomains: orgScoped(db, schema.organizationDomains, tenantId, orgId),
    ssoConnections: orgScoped(db, schema.ssoConnections, tenantId, orgId),
    directories: orgScoped(db, schema.directories, tenantId, orgId),
    scimTargets: orgScoped(db, schema.scimTargets, tenantId, orgId),
  }
}

// 顶层租户表清单(键 = TenantDb 属性名 = schema 导出名;值即对应表)。
// 全部直接带 tenant_id 列,顶层访问器只按 tenant_id 隔离;org 级精确隔离走 forOrg(orgId)。
const TENANT_TABLES = {
  users: schema.users,
  userEmails: schema.userEmails,
  userPhones: schema.userPhones,
  userIdentities: schema.userIdentities,
  gdprConsents: schema.gdprConsents,
  passwords: schema.passwords,
  passwordHistory: schema.passwordHistory,
  passwordResetTokens: schema.passwordResetTokens,
  verificationTokens: schema.verificationTokens,
  passkeyCredentials: schema.passkeyCredentials,
  mfaFactors: schema.mfaFactors,
  backupCodes: schema.backupCodes,
  trustedDevices: schema.trustedDevices,
  meteringOutbox: schema.meteringOutbox,
  organizations: schema.organizations,
  projects: schema.projects,
  applications: schema.applications,
  projectGrants: schema.projectGrants,
  orgPolicies: schema.orgPolicies,
  roles: schema.roles,
  permissions: schema.permissions,
  rolePermissions: schema.rolePermissions,
  userGrants: schema.userGrants,
  managerAssignments: schema.managerAssignments,
  memberships: schema.memberships,
  invitations: schema.invitations,
  organizationDomains: schema.organizationDomains,
  authorizationCodes: schema.authorizationCodes,
  refreshTokens: schema.refreshTokens,
  accessTokenRevocations: schema.accessTokenRevocations,
  accessTokenIssuances: schema.accessTokenIssuances,
  oauthConsents: schema.oauthConsents,
  resourceServers: schema.resourceServers,
  ssoConnections: schema.ssoConnections,
  certStore: schema.certStore,
  tenantSigningKeys: schema.tenantSigningKeys,
  samlServiceProviders: schema.samlServiceProviders,
  samlSessionBindings: schema.samlSessionBindings,
  directories: schema.directories,
  scimTargets: schema.scimTargets,
  directoryUsers: schema.directoryUsers,
  directoryGroups: schema.directoryGroups,
  directoryGroupMembers: schema.directoryGroupMembers,
  directoryPendingMembers: schema.directoryPendingMembers,
  sessions: schema.sessions,
  auditEvents: schema.auditEvents,
  usageDaily: schema.usageDaily,
  usageMonthly: schema.usageMonthly,
  webhooks: schema.webhooks,
  webhookDeliveries: schema.webhookDeliveries,
  apiKeys: schema.apiKeys,
} as const

type TenantTableMap = typeof TENANT_TABLES
type ScopedTableMap = { [K in keyof TenantTableMap]: TenantScoped<TenantTableMap[K]> }

function buildScopedTables(db: Db, tid: string): ScopedTableMap {
  const out = {} as Record<string, unknown>
  for (const [name, table] of Object.entries(TENANT_TABLES)) {
    out[name] = tenantScoped(db, table as TenantTable, tid)
  }
  return out as ScopedTableMap
}

// 工厂:绑定 D1 binding 与 TenantContext,产出全表已隔离的租户查询句柄。
export function createTenantDb(d1: D1Database, ctx: TenantContext): TenantDb {
  const db = drizzle(d1, { schema })
  const tid = ctx.tenantId
  return {
    tenantId: tid,
    ...buildScopedTables(db, tid),
    forOrg: (orgId) => buildOrgScoped(db, tid, orgId),
  }
}
