// GET /v1/me:account portal 聚合上下文(auth-context.tsx MeResponse 冻结契约,camelCase)。
// user(primary email/name/avatar/mfa)+ activeOrg + organizations + session 视图。
// 认证:cookie session(requireSession);租户隔离:createTenantDb;permissions 经 RBAC 解析。
// 见 docs/design/05-users-sessions.md、02 章 RBAC、tenant-isolation rule。

import { createTenantDb, schema } from '@xid-kit/db'
import type {
  BrowserAuthOrganization,
  BrowserAuthSession,
  BrowserAuthUser,
  BrowserManagerAssignment,
  BrowserMeResponse,
} from '@xid-kit/types'
import { and, asc, eq, gt, inArray, isNull } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { AppError } from '../lib/errors'
import { readBrowserSessions } from '../lib/session'
import type { SessionData, XidHonoEnv } from '../lib/types'
import { smsDeliveryReady } from '../auth/delivery-channels'
import { loadPrimaryEmail, readAllById, resolveActiveSession } from './shared'

type AuthOrg = BrowserAuthOrganization

type MeUser = Omit<BrowserAuthUser, 'provisioned_by'> & {
  // guest 判定契约字段(snake_case,与 SPA auth-context.tsx / packages/core api-client 对齐)。
  provisioned_by: string | null
}

type MeResponse = BrowserMeResponse

// users.displayName 优先;缺失回退 "first last"(任一为空则取非空者);全空回退 null。
function resolveName(row: typeof schema.users.$inferSelect): string | null {
  if (row.displayName) return row.displayName
  const parts = [row.firstName, row.lastName].filter((p): p is string => Boolean(p))
  return parts.length > 0 ? parts.join(' ') : null
}

// hasMfa:存在 active mfa_factors(含 passkey)、未撤销 passkey 凭证,或 verified phone + SMS ready。
async function hasMfaEnabled(c: Context<XidHonoEnv>, userId: string): Promise<boolean> {
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const [factor, passkey] = await Promise.all([
    db.mfaFactors.findOne(
      and(eq(schema.mfaFactors.userId, userId), eq(schema.mfaFactors.status, 'active')),
    ),
    db.passkeyCredentials.findOne(
      and(
        eq(schema.passkeyCredentials.userId, userId),
        isNull(schema.passkeyCredentials.revokedAt),
      ),
    ),
  ])
  if (factor || passkey) return true
  if (!smsDeliveryReady(c.get('tenant'), c.env)) return false
  const phone = await db.userPhones.findOne(
    and(eq(schema.userPhones.userId, userId), eq(schema.userPhones.verified, true)),
  )
  return Boolean(phone)
}

async function isInstanceManager(c: Context<XidHonoEnv>, userId: string): Promise<boolean> {
  const db = drizzle(c.env.DB, { schema })
  const rows = await db
    .select({ id: schema.managerAssignments.id })
    .from(schema.managerAssignments)
    .where(
      and(
        eq(schema.managerAssignments.userId, userId),
        eq(schema.managerAssignments.managerRole, 'instance_manager'),
        eq(schema.managerAssignments.scopeType, 'instance'),
      ),
    )
    .limit(1)
  return rows.length > 0
}

// 一次性预取全部项目的 userGrant -> rolePermission -> permission,再按 org 聚合。
// RBAC 解析的 grant 过滤与单项目 resolveUserPermissions 完全一致,避免组织数和项目数放大 D1 往返。
async function resolveOrganizationPermissions(
  c: Context<XidHonoEnv>,
  userId: string,
  projects: readonly (typeof schema.projects.$inferSelect)[],
): Promise<ReadonlyMap<string, readonly string[]>> {
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const projectIds = projects.map((project) => project.id)
  const permissionsByOrg = new Map<string, Set<string>>()
  for (const project of projects) permissionsByOrg.set(project.orgId, new Set())
  if (projectIds.length === 0) {
    return new Map([...permissionsByOrg].map(([orgId, keys]) => [orgId, [...keys]]))
  }

  const grants = await readPagedByIdChunks(projectIds, (batch, cursor, limit) => {
    const filter = and(
      eq(schema.userGrants.userId, userId),
      inArray(schema.userGrants.projectId, batch),
      isNull(schema.userGrants.revokedAt),
      isNull(schema.userGrants.grantedViaGrantId),
    )
    return db.userGrants.findMany(cursor ? and(filter, gt(schema.userGrants.id, cursor)) : filter, {
      orderBy: asc(schema.userGrants.id),
      limit,
    })
  })
  const roleIds = [...new Set(grants.map((grant) => grant.roleId))]
  if (roleIds.length === 0) {
    return new Map([...permissionsByOrg].map(([orgId, keys]) => [orgId, [...keys]]))
  }

  const rolePermissions = await readPagedByIdChunks(roleIds, (batch, cursor, limit) => {
    const filter = inArray(schema.rolePermissions.roleId, batch)
    return db.rolePermissions.findMany(
      cursor ? and(filter, gt(schema.rolePermissions.id, cursor)) : filter,
      { orderBy: asc(schema.rolePermissions.id), limit },
    )
  })
  const permissionIds = [
    ...new Set(rolePermissions.map((rolePermission) => rolePermission.permissionId)),
  ]
  if (permissionIds.length === 0) {
    return new Map([...permissionsByOrg].map(([orgId, keys]) => [orgId, [...keys]]))
  }

  const permissions = await readByIdChunks(permissionIds, (batch) =>
    db.permissions.findMany(inArray(schema.permissions.id, batch), { limit: batch.length }),
  )
  const permissionKeyById = new Map(
    permissions.map((permission) => [permission.id, permission.key]),
  )
  const permissionIdsByRole = new Map<string, readonly string[]>()
  for (const roleId of roleIds) {
    permissionIdsByRole.set(
      roleId,
      rolePermissions
        .filter((rolePermission) => rolePermission.roleId === roleId)
        .map((rolePermission) => rolePermission.permissionId),
    )
  }
  const orgIdByProjectId = new Map(projects.map((project) => [project.id, project.orgId]))
  for (const grant of grants) {
    const orgId = orgIdByProjectId.get(grant.projectId)
    const keys = orgId ? permissionsByOrg.get(orgId) : undefined
    if (!keys) continue
    for (const permissionId of permissionIdsByRole.get(grant.roleId) ?? []) {
      const key = permissionKeyById.get(permissionId)
      if (key) keys.add(key)
    }
  }
  return new Map([...permissionsByOrg].map(([orgId, keys]) => [orgId, [...keys]]))
}

async function readByIdChunks<T>(
  ids: readonly string[],
  read: (batch: readonly string[]) => Promise<T[]>,
): Promise<T[]> {
  const rows: T[] = []
  for (let offset = 0; offset < ids.length; offset += ACCOUNT_DB_BATCH_SIZE) {
    rows.push(...(await read(ids.slice(offset, offset + ACCOUNT_DB_BATCH_SIZE))))
  }
  return rows
}

async function readPagedByIdChunks<T extends { id: string }>(
  ids: readonly string[],
  readPage: (batch: readonly string[], cursor: string | null, limit: number) => Promise<T[]>,
): Promise<T[]> {
  const rows: T[] = []
  for (let offset = 0; offset < ids.length; offset += ACCOUNT_DB_BATCH_SIZE) {
    const batch = ids.slice(offset, offset + ACCOUNT_DB_BATCH_SIZE)
    rows.push(...(await readAllById((cursor, limit) => readPage(batch, cursor, limit))))
  }
  return rows
}

async function listActiveManagerAssignments(
  db: ReturnType<typeof createTenantDb>,
  userId: string,
): Promise<readonly BrowserManagerAssignment[]> {
  const rows = await db.managerAssignments.findMany(eq(schema.managerAssignments.userId, userId))
  const tenantRows = rows.filter(
    (row) =>
      row.scopeId !== null &&
      ((row.managerRole === 'project_manager' && row.scopeType === 'project') ||
        (row.managerRole === 'project_grant_manager' && row.scopeType === 'grant')),
  )
  const directProjectIds = tenantRows.flatMap((row) =>
    row.managerRole === 'project_manager' && row.scopeType === 'project' && row.scopeId
      ? [row.scopeId]
      : [],
  )
  const grantIds = tenantRows.flatMap((row) =>
    row.managerRole === 'project_grant_manager' && row.scopeType === 'grant' && row.scopeId
      ? [row.scopeId]
      : [],
  )
  const grants =
    grantIds.length === 0
      ? []
      : await db.projectGrants.findMany(
          and(
            inArray(schema.projectGrants.id, grantIds),
            eq(schema.projectGrants.status, 'active'),
          ),
          { limit: grantIds.length },
        )
  const projectIds = [
    ...new Set([...directProjectIds, ...grants.map((grant) => grant.grantedProjectId)]),
  ]
  const projects =
    projectIds.length === 0
      ? []
      : await db.projects.findMany(inArray(schema.projects.id, projectIds), {
          limit: projectIds.length,
        })
  const directProjectOrgIds = projects
    .filter((project) => directProjectIds.includes(project.id))
    .map((project) => project.orgId)
  const activeOrganizations =
    directProjectOrgIds.length === 0
      ? []
      : await db.organizations.findMany(
          and(
            inArray(schema.organizations.id, directProjectOrgIds),
            eq(schema.organizations.status, 'active'),
          ),
          { limit: directProjectOrgIds.length },
        )
  const activeOrgIds = new Set(activeOrganizations.map((organization) => organization.id))
  const activeProjectIds = new Set(
    projects.filter((project) => project.status === 'active').map((project) => project.id),
  )
  const discoverableProjectById = new Map(
    projects
      .filter(
        (project) =>
          (project.status === 'active' || project.status === 'deleted') &&
          activeOrgIds.has(project.orgId),
      )
      .map((project) => [project.id, project]),
  )
  const activeGrantIds = new Set(
    grants.filter((grant) => activeProjectIds.has(grant.grantedProjectId)).map((grant) => grant.id),
  )
  return tenantRows.flatMap((row): BrowserManagerAssignment[] => {
    if (
      row.scopeId &&
      row.managerRole === 'project_manager' &&
      row.scopeType === 'project' &&
      discoverableProjectById.has(row.scopeId)
    ) {
      const project = discoverableProjectById.get(row.scopeId)!
      return [
        {
          id: row.id,
          managerRole: row.managerRole,
          scopeType: row.scopeType,
          scopeId: row.scopeId,
          scopeStatus: project.status as 'active' | 'deleted',
        },
      ]
    }
    if (
      row.scopeId &&
      row.managerRole === 'project_grant_manager' &&
      row.scopeType === 'grant' &&
      activeGrantIds.has(row.scopeId)
    ) {
      return [
        {
          id: row.id,
          managerRole: row.managerRole,
          scopeType: row.scopeType,
          scopeId: row.scopeId,
          scopeStatus: 'active',
        },
      ]
    }
    return []
  })
}

// org_manager 行是 membership 之外的第二个 organizations 来源，继续映射到 organizations，
// 不重复暴露在 managerAssignments。
async function listOrgManagerOrgIds(
  db: ReturnType<typeof createTenantDb>,
  userId: string,
): Promise<readonly string[]> {
  const rows = await db.managerAssignments.findMany(
    and(
      eq(schema.managerAssignments.userId, userId),
      eq(schema.managerAssignments.managerRole, 'org_manager'),
      eq(schema.managerAssignments.scopeType, 'org'),
    ),
  )
  return rows.flatMap((row) => (row.scopeId ? [row.scopeId] : []))
}

async function listActiveMemberships(
  db: ReturnType<typeof createTenantDb>,
  userId: string,
): Promise<(typeof schema.memberships.$inferSelect)[]> {
  const rows: (typeof schema.memberships.$inferSelect)[] = []
  let cursor: string | null = null
  while (true) {
    const after = cursor ? gt(schema.memberships.id, cursor) : undefined
    const page = await db.memberships.findMany(
      after
        ? and(eq(schema.memberships.userId, userId), eq(schema.memberships.status, 'active'), after)
        : and(eq(schema.memberships.userId, userId), eq(schema.memberships.status, 'active')),
      { orderBy: asc(schema.memberships.id), limit: ACCOUNT_DB_BATCH_SIZE },
    )
    if (page.length === 0) break
    rows.push(...page)
    cursor = page[page.length - 1]?.id ?? null
    if (page.length < ACCOUNT_DB_BATCH_SIZE) break
  }
  return rows
}

function toSessionView(session: SessionData): BrowserAuthSession {
  return {
    id: session.sessionId,
    status: session.status,
    expiresAt: session.expiresAt.toISOString(),
    isImpersonation: session.isImpersonation,
    userId: session.userId,
    activeOrganizationId: session.activeOrgId,
    lastActiveAt: session.lastActiveAt.toISOString(),
  }
}

const app = new Hono<XidHonoEnv>()
const ACCOUNT_DB_BATCH_SIZE = 100

const ANONYMOUS_ME: MeResponse = {
  user: null,
  activeOrg: null,
  organizations: [],
  managerAssignments: [],
  session: null,
  activeSessionId: null,
  sessions: [],
}

// GET /v1/me
app.get('/', async (c) => {
  const session = await resolveActiveSession(c)
  if (!session) return c.json(ANONYMOUS_ME)
  const db = createTenantDb(c.env.DB, c.get('tenant'))

  const userRow = await db.users.findOne(
    and(
      eq(schema.users.id, session.userId),
      eq(schema.users.status, 'active'),
      isNull(schema.users.deletedAt),
    ),
  )
  // session 通过但 user 行缺失(数据不一致):按 401 处理,不外泄存在性(枚举防护)。
  if (!userRow) throw new AppError('unauthorized', { httpStatus: 401 })

  const [
    primaryEmail,
    hasMfa,
    instanceManager,
    memberships,
    orgManagerOrgIds,
    managerAssignments,
    browserSessions,
    passwordRow,
  ] = await Promise.all([
    loadPrimaryEmail(c, userRow.id, userRow.primaryEmailId),
    hasMfaEnabled(c, userRow.id),
    isInstanceManager(c, userRow.id),
    listActiveMemberships(db, userRow.id),
    listOrgManagerOrgIds(db, userRow.id),
    listActiveManagerAssignments(db, userRow.id),
    readBrowserSessions(c),
    db.passwords.findOne(eq(schema.passwords.userId, userRow.id)),
  ])

  const user: MeUser = {
    id: userRow.id,
    email: primaryEmail?.email ?? userRow.pendingEmail ?? '',
    emailVerified: primaryEmail?.verified ?? false,
    name: resolveName(userRow),
    imageUrl: userRow.avatarUrl ?? null,
    locale: userRow.locale ?? null,
    hasMfa,
    instanceManager,
    hasPassword: passwordRow !== null && passwordRow !== undefined,
    provisioned_by: userRow.provisionedBy ?? null,
  }

  const managedOrgIds = new Set(orgManagerOrgIds)
  const membershipOrgIds = new Set(memberships.map((membership) => membership.orgId))
  const orgIds = [...new Set([...membershipOrgIds, ...orgManagerOrgIds])]
  const [organizationRows, projects] = await Promise.all([
    readPagedByIdChunks(orgIds, (batch, cursor, limit) => {
      const filter = inArray(schema.organizations.id, batch)
      return db.organizations.findMany(
        cursor ? and(filter, gt(schema.organizations.id, cursor)) : filter,
        { orderBy: asc(schema.organizations.id), limit },
      )
    }),
    readPagedByIdChunks(orgIds, (batch, cursor, limit) => {
      const filter = and(
        inArray(schema.projects.orgId, batch),
        eq(schema.projects.status, 'active'),
      )
      return db.projects.findMany(cursor ? and(filter, gt(schema.projects.id, cursor)) : filter, {
        orderBy: asc(schema.projects.id),
        limit,
      })
    }),
  ])
  const permissionsByOrg = await resolveOrganizationPermissions(c, userRow.id, projects)
  const organizationById = new Map(
    organizationRows.map((organization) => [organization.id, organization]),
  )
  const organizations = memberships.flatMap((membership): AuthOrg[] => {
    const organization = organizationById.get(membership.orgId)
    if (!organization) return []
    // org_manager 管理能力等价 org admin 视角:membership 只是 member 但持有该 org 的
    // org_manager 行时 role 提升为 admin,与 requireOrgManager 放行语义对齐;owner/admin 不动。
    const role =
      membership.role === 'member' && managedOrgIds.has(membership.orgId)
        ? 'admin'
        : membership.role
    return [
      {
        id: organization.id,
        slug: organization.slug,
        name: organization.name,
        role,
        permissions: permissionsByOrg.get(organization.id) ?? [],
      },
    ]
  })
  // 无 membership 但持有 org_manager 行的 org 补登进列表(role admin),否则前端拿不到该 org 上下文。
  for (const orgId of orgManagerOrgIds) {
    if (membershipOrgIds.has(orgId)) continue
    const organization = organizationById.get(orgId)
    if (!organization) continue
    organizations.push({
      id: organization.id,
      slug: organization.slug,
      name: organization.name,
      role: 'admin',
      permissions: permissionsByOrg.get(organization.id) ?? [],
    })
  }
  const activeOrg = session.activeOrgId
    ? (organizations.find((organization) => organization.id === session.activeOrgId) ?? null)
    : null

  const sessionView = toSessionView(session)
  const sessionViews = [
    sessionView,
    ...browserSessions
      .filter((browserSession) => browserSession.sessionId !== session.sessionId)
      .map(toSessionView),
  ]
  const body: MeResponse = {
    user,
    activeOrg,
    organizations,
    managerAssignments,
    session: sessionView,
    activeSessionId: session.sessionId,
    sessions: sessionViews,
  }
  return c.json(body)
})

export function registerMeRoute(honoApp: Hono<XidHonoEnv>): void {
  honoApp.route('/v1/me', app)
}
