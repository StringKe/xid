// P0 租户隔离:createTenantDb 只暴露已注入 WHERE tenant_id=? 的 CRUD;org 级再注入 org_id。
// tenant_id 只取 TenantContext,不信任请求 body;不暴露无租户谓词的裸 query builder。

import type { TenantContext } from '@xid-kit/types'
import type { InferInsertModel, InferSelectModel, SQL } from 'drizzle-orm'
import { and, eq, sql } from 'drizzle-orm'
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from './schema'

type TenantTable = SQLiteTable & {
  tenantId: SQLiteColumn
}

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

// WHERE 链首注入租户谓词,调用方附加条件只能收窄,不能绕过。
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

function tenantScoped<T extends TenantTable>(
  db: Db,
  table: T,
  tenantIdValue: string,
): TenantScoped<T> {
  return makeScoped(db, table, eq(table.tenantId, tenantIdValue) as SQL, {
    tenantId: tenantIdValue,
  })
}

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

// org 级须 forOrg(orgId) 再细分,避免误用全租户视图。
export type TenantDb = ScopedTableMap & {
  tenantId: string
  forOrg: (orgId: string) => OrgScopedDb
}

// 仅含直接带 org_id 的表;applications 经 project_id 间接归属 org,不在此列(08 章 10.4)。
export type OrgScopedDb = {
  orgId: string
  projects: TenantScoped<typeof schema.projects>
  orgPolicies: TenantScoped<typeof schema.orgPolicies>
  memberships: TenantScoped<typeof schema.memberships>
  accessRequests: TenantScoped<typeof schema.accessRequests>
  orgUnits: TenantScoped<typeof schema.orgUnits>
  orgUnitMembers: TenantScoped<typeof schema.orgUnitMembers>
  invitations: TenantScoped<typeof schema.invitations>
  organizationDomains: TenantScoped<typeof schema.organizationDomains>
  ssoConnections: TenantScoped<typeof schema.ssoConnections>
  directories: TenantScoped<typeof schema.directories>
  scimTargets: TenantScoped<typeof schema.scimTargets>
  scimTargetResources: TenantScoped<typeof schema.scimTargetResources>
  customHostnames: TenantScoped<typeof schema.customHostnames>
}

function buildOrgScoped(db: Db, tenantId: string, orgId: string): OrgScopedDb {
  return {
    orgId,
    projects: orgScoped(db, schema.projects, tenantId, orgId),
    orgPolicies: orgScoped(db, schema.orgPolicies, tenantId, orgId),
    memberships: orgScoped(db, schema.memberships, tenantId, orgId),
    accessRequests: orgScoped(db, schema.accessRequests, tenantId, orgId),
    orgUnits: orgScoped(db, schema.orgUnits, tenantId, orgId),
    orgUnitMembers: orgScoped(db, schema.orgUnitMembers, tenantId, orgId),
    invitations: orgScoped(db, schema.invitations, tenantId, orgId),
    organizationDomains: orgScoped(db, schema.organizationDomains, tenantId, orgId),
    ssoConnections: orgScoped(db, schema.ssoConnections, tenantId, orgId),
    directories: orgScoped(db, schema.directories, tenantId, orgId),
    scimTargets: orgScoped(db, schema.scimTargets, tenantId, orgId),
    scimTargetResources: orgScoped(db, schema.scimTargetResources, tenantId, orgId),
    customHostnames: orgScoped(db, schema.customHostnames, tenantId, orgId),
  }
}

// 顶层只按 tenant_id 隔离;org 级精确隔离走 forOrg(orgId)。
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
  magicLinkTokens: schema.magicLinkTokens,
  passkeyCredentials: schema.passkeyCredentials,
  mfaFactors: schema.mfaFactors,
  backupCodes: schema.backupCodes,
  trustedDevices: schema.trustedDevices,
  meteringOutbox: schema.meteringOutbox,
  organizations: schema.organizations,
  customHostnames: schema.customHostnames,
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
  accessRequests: schema.accessRequests,
  orgUnits: schema.orgUnits,
  orgUnitMembers: schema.orgUnitMembers,
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
  samlServiceProviders: schema.samlServiceProviders,
  samlSessionBindings: schema.samlSessionBindings,
  directories: schema.directories,
  scimTargets: schema.scimTargets,
  scimTargetResources: schema.scimTargetResources,
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
  queueDeadLetters: schema.queueDeadLetters,
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

export function createTenantDb(d1: D1Database, ctx: TenantContext): TenantDb {
  const db = drizzle(d1, { schema })
  const tid = ctx.tenantId
  return {
    tenantId: tid,
    ...buildScopedTables(db, tid),
    forOrg: (orgId) => buildOrgScoped(db, tid, orgId),
  }
}
