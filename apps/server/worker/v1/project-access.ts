// Project/ProjectGrant 管理路径的共享授权边界。
// API key 仍按 resource scope 授权;cookie session 只获得精确 project/grant scope,
// project_manager/project_grant_manager 永不提升为 Organization Admin。

import { createTenantDb, schema } from '@xid-kit/db'
import type { TenantManagerRoleScope } from '@xid-kit/types'
import { and, eq } from 'drizzle-orm'
import type { Context } from 'hono'
import type { SessionData, XidHonoEnv } from '../lib/types'
import { AppError } from '../lib/errors'
import { requireVerifiedManagementMutation } from '../lib/management-access'
import { readSession } from '../lib/session'
import type { ApiKeyScope } from './shared'
import { requireApiKey } from './shared'

export type ProjectAccessActor =
  | { kind: 'api_key'; apiKeyId: string; scopes: string[] }
  | { kind: 'session'; session: SessionData }

type ProjectRow = typeof schema.projects.$inferSelect
type ProjectGrantRow = typeof schema.projectGrants.$inferSelect

function hasApiKeyBearer(c: Context<XidHonoEnv>): boolean {
  const auth = c.req.header('Authorization') ?? ''
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  return bearer.startsWith('sk_live_') || bearer.startsWith('sk_test_')
}

export async function requireProjectAccessActor(
  c: Context<XidHonoEnv>,
  requiredScope: ApiKeyScope | ApiKeyScope[],
): Promise<ProjectAccessActor> {
  if (hasApiKeyBearer(c)) {
    const key = await requireApiKey(c, requiredScope)
    return { kind: 'api_key', apiKeyId: key.id, scopes: key.scopes }
  }

  const session = c.get('session') ?? (await readSession(c))
  if (!session) throw new AppError('unauthorized', { httpStatus: 401 })
  return { kind: 'session', session }
}

export async function findProject(c: Context<XidHonoEnv>, projectId: string): Promise<ProjectRow> {
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const project = await db.projects.findOne(
    and(eq(schema.projects.id, projectId), eq(schema.projects.status, 'active')),
  )
  if (!project) throw new AppError('not_found', { httpStatus: 404 })
  return project
}

export async function hasManagerAssignment(
  c: Context<XidHonoEnv>,
  session: SessionData,
  input: TenantManagerRoleScope & { scopeId: string },
): Promise<boolean> {
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const assignment = await db.managerAssignments.findOne(
    and(
      eq(schema.managerAssignments.userId, session.userId),
      eq(schema.managerAssignments.managerRole, input.managerRole),
      eq(schema.managerAssignments.scopeType, input.scopeType),
      eq(schema.managerAssignments.scopeId, input.scopeId),
    ),
  )
  return Boolean(assignment)
}

export async function hasOrganizationAdminAccess(
  c: Context<XidHonoEnv>,
  session: SessionData,
  orgId: string,
): Promise<boolean> {
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const membership = await db.memberships.findOne(
    and(
      eq(schema.memberships.userId, session.userId),
      eq(schema.memberships.orgId, orgId),
      eq(schema.memberships.status, 'active'),
    ),
  )
  if (membership?.role === 'owner' || membership?.role === 'admin') return true
  return hasManagerAssignment(c, session, {
    managerRole: 'org_manager',
    scopeType: 'org',
    scopeId: orgId,
  })
}

export async function hasProjectOwnerAccess(
  c: Context<XidHonoEnv>,
  session: SessionData,
  project: ProjectRow,
): Promise<boolean> {
  if (
    await hasManagerAssignment(c, session, {
      managerRole: 'project_manager',
      scopeType: 'project',
      scopeId: project.id,
    })
  ) {
    return true
  }
  return hasOrganizationAdminAccess(c, session, project.orgId)
}

export async function authorizeProjectManagement(
  c: Context<XidHonoEnv>,
  actor: ProjectAccessActor,
  projectId: string,
): Promise<ProjectRow> {
  const project = await findProject(c, projectId)
  if (actor.kind === 'api_key') return project
  if (!(await hasProjectOwnerAccess(c, actor.session, project))) {
    throw new AppError('forbidden', { httpStatus: 403 })
  }
  await requireVerifiedManagementMutation(c, actor.session)
  return project
}

export async function authorizeProjectRowManagement(
  c: Context<XidHonoEnv>,
  actor: ProjectAccessActor,
  project: ProjectRow,
): Promise<void> {
  if (actor.kind === 'api_key') return
  if (!(await hasProjectOwnerAccess(c, actor.session, project))) {
    throw new AppError('forbidden', { httpStatus: 403 })
  }
  await requireVerifiedManagementMutation(c, actor.session)
}

export async function authorizeOrganizationManagement(
  c: Context<XidHonoEnv>,
  actor: ProjectAccessActor,
  orgId: string,
): Promise<void> {
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const org = await db.organizations.findOne(eq(schema.organizations.id, orgId))
  if (!org || org.status === 'deleted') {
    throw new AppError('org_not_found', { httpStatus: 404 })
  }
  if (org.status === 'suspended') {
    throw new AppError('org_suspended', { httpStatus: 403 })
  }
  if (actor.kind === 'api_key') return
  if (!(await hasOrganizationAdminAccess(c, actor.session, orgId))) {
    throw new AppError('forbidden', { httpStatus: 403 })
  }
  await requireVerifiedManagementMutation(c, actor.session)
}

async function assertGrantMatchesProject(
  c: Context<XidHonoEnv>,
  grantId: string,
  projectId: string,
): Promise<ProjectGrantRow> {
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const grant = await db.projectGrants.findOne(
    and(
      eq(schema.projectGrants.id, grantId),
      eq(schema.projectGrants.grantedProjectId, projectId),
      eq(schema.projectGrants.status, 'active'),
    ),
  )
  if (!grant) throw new AppError('not_found', { httpStatus: 404 })
  return grant
}

// Grant-scoped manager and recipient-org admin get read access to the granted Project's role model.
// Only the Project owner path can mutate Role/Permission definitions.
export async function authorizeProjectRead(
  c: Context<XidHonoEnv>,
  actor: ProjectAccessActor,
  projectId: string,
  grantId?: string,
): Promise<ProjectRow> {
  const project = await findProject(c, projectId)
  if (actor.kind === 'api_key') return project
  if (await hasProjectOwnerAccess(c, actor.session, project)) return project
  if (!grantId) throw new AppError('forbidden', { httpStatus: 403 })

  const grant = await assertGrantMatchesProject(c, grantId, projectId)
  const grantManager = await hasManagerAssignment(c, actor.session, {
    managerRole: 'project_grant_manager',
    scopeType: 'grant',
    scopeId: grant.id,
  })
  const recipientAdmin = await hasOrganizationAdminAccess(c, actor.session, grant.grantedToOrgId)
  if (!grantManager && !recipientAdmin) throw new AppError('forbidden', { httpStatus: 403 })
  return project
}

export async function authorizeProjectGrantRead(
  c: Context<XidHonoEnv>,
  actor: ProjectAccessActor,
  grant: ProjectGrantRow,
): Promise<void> {
  const project = await findProject(c, grant.grantedProjectId)
  if (actor.kind === 'api_key') return
  if (await hasProjectOwnerAccess(c, actor.session, project)) return

  const grantManager = await hasManagerAssignment(c, actor.session, {
    managerRole: 'project_grant_manager',
    scopeType: 'grant',
    scopeId: grant.id,
  })
  const recipientAdmin = await hasOrganizationAdminAccess(c, actor.session, grant.grantedToOrgId)
  if (!grantManager && !recipientAdmin) throw new AppError('forbidden', { httpStatus: 403 })
}

// UserGrant assignment is the one write capability explicitly shared with ProjectGrant Manager and
// the recipient Organization admin in chapter 02 section 7.4.
export async function authorizeProjectGrantAssignment(
  c: Context<XidHonoEnv>,
  actor: ProjectAccessActor,
  grant: ProjectGrantRow,
): Promise<void> {
  await authorizeProjectGrantRead(c, actor, grant)
  if (actor.kind === 'session') {
    await requireVerifiedManagementMutation(c, actor.session)
  }
}
