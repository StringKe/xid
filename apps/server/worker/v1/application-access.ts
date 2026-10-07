// /v1/applications 的授权边界。
// API key:按 applications:read / write scope 访问全租户应用。
// cookie 会话:顶层组织 owner / admin / org_manager 访问全租户应用;Project Manager 与项目所属组织管理员
// 只访问挂在其项目下的应用,越项目或未归属项目的应用一律 404,不泄露存在性。

import { createTenantDb, schema } from '@xid-kit/db'
import { and, eq } from 'drizzle-orm'
import type { Context } from 'hono'
import { AppError } from '../lib/errors'
import { requireVerifiedManagementMutation } from '../lib/management-access'
import type { XidHonoEnv } from '../lib/types'
import {
  hasOrganizationAdminAccess,
  hasProjectOwnerAccess,
  requireProjectAccessActor,
  type ProjectAccessActor,
} from './project-access'

type ApplicationRow = typeof schema.applications.$inferSelect

export type ApplicationAccess = {
  actor: ProjectAccessActor
  actorId: string
  tenantWide: boolean
}

async function activeProject(
  c: Context<XidHonoEnv>,
  projectId: string,
): Promise<typeof schema.projects.$inferSelect | undefined> {
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  return db.projects.findOne(
    and(eq(schema.projects.id, projectId), eq(schema.projects.status, 'active')),
  )
}

export async function resolveApplicationAccess(
  c: Context<XidHonoEnv>,
  scope: 'applications:read' | 'applications:write',
): Promise<ApplicationAccess> {
  const actor = await requireProjectAccessActor(c, scope)
  if (actor.kind === 'api_key') return { actor, actorId: actor.apiKeyId, tenantWide: true }
  const tenantWide = await hasOrganizationAdminAccess(c, actor.session, c.get('tenant').tenantId)
  await requireVerifiedManagementMutation(c, actor.session)
  return { actor, actorId: actor.session.userId, tenantWide }
}

// 项目必须属于当前租户且 active;项目范围的调用方还必须能管理该项目。
export async function assertProjectAssignable(
  c: Context<XidHonoEnv>,
  access: ApplicationAccess,
  projectId: string,
): Promise<void> {
  const project = await activeProject(c, projectId)
  if (!project) {
    throw new AppError('validation_failed', { httpStatus: 422, meta: { paramName: 'project_id' } })
  }
  if (access.tenantWide || access.actor.kind === 'api_key') return
  if (!(await hasProjectOwnerAccess(c, access.actor.session, project))) {
    throw new AppError('validation_failed', { httpStatus: 422, meta: { paramName: 'project_id' } })
  }
}

export async function assertProjectListable(
  c: Context<XidHonoEnv>,
  access: ApplicationAccess,
  projectId: string | undefined,
): Promise<void> {
  if (access.tenantWide) return
  if (!projectId || access.actor.kind !== 'session') {
    throw new AppError('forbidden', { httpStatus: 403 })
  }
  const project = await activeProject(c, projectId)
  if (!project || !(await hasProjectOwnerAccess(c, access.actor.session, project))) {
    throw new AppError('forbidden', { httpStatus: 403 })
  }
}

export async function assertApplicationVisible(
  c: Context<XidHonoEnv>,
  access: ApplicationAccess,
  row: ApplicationRow,
): Promise<void> {
  if (access.tenantWide) return
  if (access.actor.kind !== 'session' || !row.projectId) {
    throw new AppError('not_found', { httpStatus: 404 })
  }
  const project = await activeProject(c, row.projectId)
  if (!project || !(await hasProjectOwnerAccess(c, access.actor.session, project))) {
    throw new AppError('not_found', { httpStatus: 404 })
  }
}
