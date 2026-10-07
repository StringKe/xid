// /v1/users 列表与导出共用的筛选和行展开。
// 筛选子查询都按外层 users.tenant_id 关联,外层由 createTenantDb 注入租户谓词,子查询不会越出租户。

import { createTenantDb, schema } from '@xid-kit/db'
import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, lte, ne, or, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core'
import * as v from 'valibot'
import { AppError } from '../lib/errors'
import { ORG_LIST_BATCH_SIZE, readAllByIds, toIso } from './org-shared'
import { canManageOwners, type OrgScopedAuth } from './shared'

type TenantDb = ReturnType<typeof createTenantDb>
type UserRow = typeof schema.users.$inferSelect

export const USER_STATUS_FILTERS = ['active', 'banned', 'deleted'] as const
export const SIGN_IN_METHOD_FILTERS = ['password', 'passkey', 'social', 'sso', 'guest'] as const

const GUEST_PROVISIONER = 'anonymous'
const SEARCH_MAX_LENGTH = 200

const instantSchema = v.pipe(
  v.string(),
  v.maxLength(40),
  v.check((value) => !Number.isNaN(Date.parse(value))),
  v.transform((value) => new Date(value)),
)

export const userListQuerySchema = v.object({
  search: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(SEARCH_MAX_LENGTH))),
  provisioned_by: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(64))),
  status: v.optional(v.picklist(USER_STATUS_FILTERS)),
  sign_in_method: v.optional(v.picklist(SIGN_IN_METHOD_FILTERS)),
  created_from: v.optional(instantSchema),
  created_to: v.optional(instantSchema),
  last_sign_in_from: v.optional(instantSchema),
  last_sign_in_to: v.optional(instantSchema),
})

export type UserListQuery = v.InferOutput<typeof userListQuerySchema>

export function readUserListQuery(query: Record<string, string>): Record<string, string> {
  const picked: Record<string, string> = {}
  for (const key of Object.keys(userListQuerySchema.entries)) {
    const value = query[key]
    if (value !== undefined && value !== '') picked[key] = value
  }
  return picked
}

// 与 memberships.ts 的 owner 保护对等:admin 不能暂停、删除或重置 owner 级用户(任一组织 active owner,
// 或 instance_manager / org_manager);cookie 调用方也不能对自己执行这些操作,避免把自己锁在外面。
export async function assertUserActionAllowed(
  db: TenantDb,
  auth: OrgScopedAuth,
  userId: string,
): Promise<void> {
  if (auth.kind !== 'org_console') return
  if (auth.session.userId === userId) throw new AppError('forbidden', { httpStatus: 403 })
  if (canManageOwners(auth)) return
  const [ownerMembership, ownerLevelAssignment] = await Promise.all([
    db.memberships.findOne(
      and(
        eq(schema.memberships.userId, userId),
        eq(schema.memberships.role, 'owner'),
        eq(schema.memberships.status, 'active'),
      ),
    ),
    db.managerAssignments.findOne(
      and(
        eq(schema.managerAssignments.userId, userId),
        inArray(schema.managerAssignments.managerRole, ['instance_manager', 'org_manager']),
      ),
    ),
  ])
  if (ownerMembership || ownerLevelAssignment) {
    throw new AppError('forbidden', { httpStatus: 403 })
  }
}

export function notDeletedUser(): SQL {
  return and(ne(schema.users.status, 'deleted'), isNull(schema.users.deletedAt)) as SQL
}

function deletedUser(): SQL {
  return or(eq(schema.users.status, 'deleted'), isNotNull(schema.users.deletedAt)) as SQL
}

export function statusFilter(status: UserListQuery['status']): SQL {
  if (status === 'deleted') return deletedUser()
  if (status === undefined) return notDeletedUser()
  return and(eq(schema.users.status, status), isNull(schema.users.deletedAt)) as SQL
}

export function guestFilter(): SQL {
  return eq(schema.users.provisionedBy, GUEST_PROVISIONER)
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`)
}

function searchFilter(search: string): SQL {
  const pattern = `%${escapeLike(search)}%`
  const contains = (column: SQLiteColumn) => sql`${column} LIKE ${pattern} ESCAPE '\\'`
  return or(
    eq(schema.users.id, search),
    eq(schema.users.externalId, search),
    contains(schema.users.username),
    contains(schema.users.firstName),
    contains(schema.users.lastName),
    contains(schema.users.displayName),
    sql`EXISTS (SELECT 1 FROM user_emails ue WHERE ue.tenant_id = ${schema.users.tenantId}
      AND ue.user_id = ${schema.users.id} AND ue.email LIKE ${pattern} ESCAPE '\\')`,
    sql`EXISTS (SELECT 1 FROM user_phones up WHERE up.tenant_id = ${schema.users.tenantId}
      AND up.user_id = ${schema.users.id} AND up.phone LIKE ${pattern} ESCAPE '\\')`,
  ) as SQL
}

function signInMethodFilter(method: (typeof SIGN_IN_METHOD_FILTERS)[number]): SQL {
  switch (method) {
    case 'password':
      return sql`EXISTS (SELECT 1 FROM passwords p WHERE p.tenant_id = ${schema.users.tenantId}
        AND p.user_id = ${schema.users.id})`
    case 'passkey':
      return sql`EXISTS (SELECT 1 FROM passkey_credentials pk WHERE pk.tenant_id = ${schema.users.tenantId}
        AND pk.user_id = ${schema.users.id} AND pk.revoked_at IS NULL)`
    case 'social':
      return sql`EXISTS (SELECT 1 FROM user_identities ui WHERE ui.tenant_id = ${schema.users.tenantId}
        AND ui.user_id = ${schema.users.id} AND ui.identity_type = 'oauth' AND ui.revoked_at IS NULL)`
    case 'sso':
      return sql`EXISTS (SELECT 1 FROM user_identities ui WHERE ui.tenant_id = ${schema.users.tenantId}
        AND ui.user_id = ${schema.users.id} AND ui.identity_type IN ('sso', 'saml') AND ui.revoked_at IS NULL)`
    case 'guest':
      return guestFilter()
  }
}

// 除 status 外的全部筛选:计数按状态分组时复用。
export function userFiltersWithoutStatus(query: UserListQuery): SQL[] {
  const filters: (SQL | undefined)[] = [
    query.search ? searchFilter(query.search) : undefined,
    query.provisioned_by ? eq(schema.users.provisionedBy, query.provisioned_by) : undefined,
    query.sign_in_method ? signInMethodFilter(query.sign_in_method) : undefined,
    query.created_from ? gte(schema.users.createdAt, query.created_from) : undefined,
    query.created_to ? lte(schema.users.createdAt, query.created_to) : undefined,
    query.last_sign_in_from ? gte(schema.users.lastLoginAt, query.last_sign_in_from) : undefined,
    query.last_sign_in_to ? lte(schema.users.lastLoginAt, query.last_sign_in_to) : undefined,
  ]
  return filters.filter((filter): filter is SQL => filter !== undefined)
}

export async function countUsersByStatus(
  db: TenantDb,
  base: readonly SQL[],
): Promise<{ active: number; banned: number; deleted: number; guest: number }> {
  const [active, banned, deleted, guest] = await Promise.all([
    db.users.count(and(...base, statusFilter('active'))),
    db.users.count(and(...base, statusFilter('banned'))),
    db.users.count(and(...base, statusFilter('deleted'))),
    db.users.count(and(...base, notDeletedUser(), guestFilter())),
  ])
  return { active, banned, deleted, guest }
}

export type SignInMethodSummary = {
  type: 'password' | 'passkey' | 'social' | 'sso' | 'guest'
  provider?: string
}

export type UserSummaryExtras = {
  primaryEmail: string | null
  primaryPhone: string | null
  signInMethods: SignInMethodSummary[]
  organizations: { id: string; name: string }[]
}

function pickPrimary<T extends { id: string; isPrimary: boolean }>(
  candidates: readonly T[] | undefined,
  primaryId: string | null,
): T | undefined {
  if (!candidates || candidates.length === 0) return undefined
  return (
    candidates.find((row) => row.id === primaryId) ??
    candidates.find((row) => row.isPrimary) ??
    candidates[0]
  )
}

function groupByUser<T extends { userId: string }>(rows: readonly T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>()
  for (const row of rows) grouped.set(row.userId, [...(grouped.get(row.userId) ?? []), row])
  return grouped
}

function readByUserIds<T extends { id: string }>(
  userIds: readonly string[],
  read: (batch: readonly string[], cursor: string | null) => Promise<T[]>,
): Promise<T[]> {
  return readAllByIds(userIds, read)
}

async function loadUserRelations(db: TenantDb, userIds: readonly string[]) {
  const after = (column: SQLiteColumn, cursor: string | null) =>
    cursor ? [gt(column, cursor)] : []
  const page = { limit: ORG_LIST_BATCH_SIZE }
  return Promise.all([
    readByUserIds(userIds, (batch, cursor) =>
      db.userEmails.findMany(
        and(inArray(schema.userEmails.userId, batch), ...after(schema.userEmails.id, cursor)),
        { ...page, orderBy: asc(schema.userEmails.id) },
      ),
    ),
    readByUserIds(userIds, (batch, cursor) =>
      db.userPhones.findMany(
        and(inArray(schema.userPhones.userId, batch), ...after(schema.userPhones.id, cursor)),
        { ...page, orderBy: asc(schema.userPhones.id) },
      ),
    ),
    readByUserIds(userIds, (batch, cursor) =>
      db.passwords.findMany(
        and(inArray(schema.passwords.userId, batch), ...after(schema.passwords.id, cursor)),
        { ...page, orderBy: asc(schema.passwords.id) },
      ),
    ),
    readByUserIds(userIds, (batch, cursor) =>
      db.passkeyCredentials.findMany(
        and(
          inArray(schema.passkeyCredentials.userId, batch),
          isNull(schema.passkeyCredentials.revokedAt),
          ...after(schema.passkeyCredentials.id, cursor),
        ),
        { ...page, orderBy: asc(schema.passkeyCredentials.id) },
      ),
    ),
    readByUserIds(userIds, (batch, cursor) =>
      db.userIdentities.findMany(
        and(
          inArray(schema.userIdentities.userId, batch),
          isNull(schema.userIdentities.revokedAt),
          ...after(schema.userIdentities.id, cursor),
        ),
        { ...page, orderBy: asc(schema.userIdentities.id) },
      ),
    ),
    readByUserIds(userIds, (batch, cursor) =>
      db.memberships.findMany(
        and(
          inArray(schema.memberships.userId, batch),
          eq(schema.memberships.status, 'active'),
          ...after(schema.memberships.id, cursor),
        ),
        { ...page, orderBy: asc(schema.memberships.id) },
      ),
    ),
  ])
}

async function loadOrganizationNames(
  db: TenantDb,
  orgIds: readonly string[],
): Promise<Map<string, string>> {
  const rows = await readAllByIds(orgIds, (batch, cursor) =>
    db.organizations.findMany(
      and(
        inArray(schema.organizations.id, batch),
        ne(schema.organizations.status, 'deleted'),
        ...(cursor ? [gt(schema.organizations.id, cursor)] : []),
      ),
      { limit: ORG_LIST_BATCH_SIZE, orderBy: asc(schema.organizations.id) },
    ),
  )
  return new Map(rows.map((row) => [row.id, row.name]))
}

function identityMethod(row: typeof schema.userIdentities.$inferSelect): SignInMethodSummary {
  const type = row.identityType === 'oauth' ? 'social' : 'sso'
  return row.provider ? { type, provider: row.provider } : { type }
}

export async function summarizeUsers(
  db: TenantDb,
  users: readonly UserRow[],
): Promise<Map<string, UserSummaryExtras>> {
  const userIds = users.map((user) => user.id)
  if (userIds.length === 0) return new Map()
  const [emails, phones, passwords, passkeys, identities, memberships] = await loadUserRelations(
    db,
    userIds,
  )
  const orgNames = await loadOrganizationNames(db, [
    ...new Set(memberships.map((row) => row.orgId)),
  ])
  const emailsByUser = groupByUser(emails)
  const phonesByUser = groupByUser(phones)
  const identitiesByUser = groupByUser(identities)
  const membershipsByUser = groupByUser(memberships)
  const hasPassword = new Set(passwords.map((row) => row.userId))
  const hasPasskey = new Set(passkeys.map((row) => row.userId))

  return new Map(
    users.map((user) => {
      const methods: SignInMethodSummary[] = []
      if (user.provisionedBy === GUEST_PROVISIONER) methods.push({ type: 'guest' })
      if (hasPasskey.has(user.id)) methods.push({ type: 'passkey' })
      if (hasPassword.has(user.id)) methods.push({ type: 'password' })
      methods.push(...(identitiesByUser.get(user.id) ?? []).map(identityMethod))
      const organizations = (membershipsByUser.get(user.id) ?? [])
        .map((row) => ({ id: row.orgId, name: orgNames.get(row.orgId) }))
        .filter((org): org is { id: string; name: string } => org.name !== undefined)
      return [
        user.id,
        {
          primaryEmail: pickPrimary(emailsByUser.get(user.id), user.primaryEmailId)?.email ?? null,
          primaryPhone: pickPrimary(phonesByUser.get(user.id), user.primaryPhoneId)?.phone ?? null,
          signInMethods: methods,
          organizations,
        },
      ]
    }),
  )
}

const CSV_COLUMNS = [
  'id',
  'name',
  'primary_email',
  'primary_phone',
  'status',
  'organizations',
  'created_at',
  'last_sign_in_at',
] as const

// 以 = + - @ 制表符或回车开头的单元格会被电子表格当公式执行,前置单引号按文本处理。
function csvCell(value: string | null): string {
  if (value === null) return ''
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe
}

export function csvHeader(): string {
  return `${CSV_COLUMNS.join(',')}\r\n`
}

export function userDisplayName(user: UserRow): string | null {
  if (user.displayName) return user.displayName
  const parts = [user.firstName, user.lastName].filter((part): part is string => Boolean(part))
  return parts.length > 0 ? parts.join(' ') : null
}

export function userStatus(user: UserRow): string {
  return user.deletedAt !== null ? 'deleted' : user.status
}

export function csvRow(user: UserRow, extras: UserSummaryExtras | undefined): string {
  const cells = [
    user.id,
    userDisplayName(user),
    extras?.primaryEmail ?? null,
    extras?.primaryPhone ?? null,
    userStatus(user),
    (extras?.organizations ?? []).map((org) => org.name).join('; ') || null,
    toIso(user.createdAt),
    toIso(user.lastLoginAt),
  ]
  return `${cells.map(csvCell).join(',')}\r\n`
}
