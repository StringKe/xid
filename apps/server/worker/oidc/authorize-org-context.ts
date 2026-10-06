// /authorize 组织与 RBAC 上下文:active org 复核、Project access policy、ProjectGrant 解析。

import { createTenantDb, schema } from '@xid-kit/db'
import { and, asc, eq, gt, inArray, isNull, or } from 'drizzle-orm'
import type { Result, XidError } from '@xid-kit/types'
import type { Context } from 'hono'
import type { SessionData, XidHonoEnv } from '../lib/types'
import { isGrantEffective } from './shared'
import type { ClientRow } from './shared'

const ACTIVE_ORG_LOOKUP_BATCH_SIZE = 100

export type AuthorizeRbacContext = {
  activeOrgId: string | null
  projectGrantId: string | null
}

function authzFail(
  code: XidError['code'],
  message: string,
  httpStatus = 400,
): Result<never, XidError> {
  return { ok: false, error: { code, message, httpStatus } }
}

async function loadActiveOrg(
  c: Context<XidHonoEnv>,
  session: SessionData,
): Promise<Result<{ id: string; slug: string } | null, XidError>> {
  if (!session.activeOrgId) return { ok: true, value: null }
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const org = await db.organizations.findOne(
    and(
      eq(schema.organizations.id, session.activeOrgId),
      eq(schema.organizations.status, 'active'),
    ),
  )
  if (!org) return authzFail('access_denied', 'active organization revoked or not found', 403)
  const membership = await db.memberships.findOne(
    and(
      eq(schema.memberships.userId, session.userId),
      eq(schema.memberships.orgId, org.id),
      eq(schema.memberships.status, 'active'),
    ),
  )
  if (!membership)
    return authzFail('access_denied', 'active organization revoked or not found', 403)
  return { ok: true, value: { id: org.id, slug: org.slug } }
}

async function resolveOrgLessContext(
  c: Context<XidHonoEnv>,
  client: ClientRow,
): Promise<Result<AuthorizeRbacContext, XidError>> {
  if (client.requireOrgContext) {
    return authzFail('access_denied', 'organization context required', 403)
  }
  // 纵深防御:active org 可被用户自助清空,无 org 上下文不得绕过 project access policy 门;
  // 无有效同 org user_grant 可能的 org-less 会话对非 open project 一律拒绝(与同 org
  // 分支同错误前缀)。仅 client 绑定 project 才查,open / 无 projectId 短路,B2C 公开
  // client 热路径不新增查询。
  if (client.projectId) {
    const db = createTenantDb(c.env.DB, c.get('tenant'))
    const project = await db.projects.findOne(
      and(eq(schema.projects.id, client.projectId), eq(schema.projects.status, 'active')),
    )
    if (!project) return authzFail('unauthorized_client', 'application project not found')
    if (project.accessPolicy === 'restricted') {
      return authzFail('access_denied', 'project_access_restricted: no effective grant', 403)
    }
    if (project.accessPolicy === 'approval_required') {
      return authzFail('access_denied', 'access_request_required: no effective grant', 403)
    }
  }
  return { ok: true, value: { activeOrgId: null, projectGrantId: null } }
}

export async function resolveAuthorizeRbacContext(
  c: Context<XidHonoEnv>,
  input: { client: ClientRow; session: SessionData },
): Promise<Result<AuthorizeRbacContext, XidError>> {
  const active = await loadActiveOrg(c, input.session)
  if (!active.ok) return active
  if (!active.value) return resolveOrgLessContext(c, input.client)
  if (!input.client.projectId) {
    return { ok: true, value: { activeOrgId: active.value.id, projectGrantId: null } }
  }

  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const project = await db.projects.findOne(
    and(eq(schema.projects.id, input.client.projectId), eq(schema.projects.status, 'active')),
  )
  if (!project) return authzFail('unauthorized_client', 'application project not found')
  if (project.orgId === active.value.id) {
    // access_policy 分流(design-access-request 第 2 节):open 放行(= 现状);其余要求有效
    // 同 org user_grant(granted_via_grant_id 为空、未 revoked、未过 expires_at)。
    // 机器可读码放 error_description 前缀(OAuth 仅 error/error_description 两字段可回传)。
    const policy = project.accessPolicy
    if (policy === 'restricted' || policy === 'approval_required') {
      // expires_at 谓词与 isGrantEffective 双重判定:多行(不同 role / 复活后新旧行)时
      // findOne 只命中有效行,不会任意取到过期行误拒有效用户。
      const userGrant = await db.userGrants.findOne(
        and(
          eq(schema.userGrants.userId, input.session.userId),
          eq(schema.userGrants.projectId, project.id),
          isNull(schema.userGrants.grantedViaGrantId),
          isNull(schema.userGrants.revokedAt),
          or(isNull(schema.userGrants.expiresAt), gt(schema.userGrants.expiresAt, new Date())),
        ),
      )
      if (!userGrant || !isGrantEffective(userGrant, Date.now())) {
        return policy === 'restricted'
          ? authzFail('access_denied', 'project_access_restricted: no effective grant', 403)
          : authzFail('access_denied', 'access_request_required: no effective grant', 403)
      }
    }
    return { ok: true, value: { activeOrgId: active.value.id, projectGrantId: null } }
  }

  const grant = await db.projectGrants.findOne(
    and(
      eq(schema.projectGrants.grantedProjectId, project.id),
      eq(schema.projectGrants.grantedToOrgId, active.value.id),
      eq(schema.projectGrants.status, 'active'),
    ),
  )
  if (!grant) return authzFail('access_denied', 'project grant revoked or not found', 403)
  const userGrant = await db.userGrants.findOne(
    and(
      eq(schema.userGrants.userId, input.session.userId),
      eq(schema.userGrants.projectId, project.id),
      eq(schema.userGrants.grantedViaGrantId, grant.id),
      isNull(schema.userGrants.revokedAt),
    ),
  )
  if (!userGrant) return authzFail('access_denied', 'user not authorized via grant', 403)
  return { ok: true, value: { activeOrgId: active.value.id, projectGrantId: grant.id } }
}

// 最多取两个有效组织:只需区分 0 / 1 / 多个。
export async function listActiveOrgIds(c: Context<XidHonoEnv>, userId: string): Promise<string[]> {
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const membershipFilter = and(
    eq(schema.memberships.userId, userId),
    eq(schema.memberships.status, 'active'),
  )
  const activeOrgIds: string[] = []
  let cursor: string | null = null

  while (activeOrgIds.length < 2) {
    const rows = await db.memberships.findMany(
      cursor ? and(membershipFilter, gt(schema.memberships.id, cursor)) : membershipFilter,
      { orderBy: asc(schema.memberships.id), limit: ACTIVE_ORG_LOOKUP_BATCH_SIZE },
    )
    if (rows.length === 0) break

    const orgIds = [...new Set(rows.map((row) => row.orgId))]
    const organizations = await db.organizations.findMany(
      and(
        inArray(schema.organizations.id, orgIds),
        eq(schema.organizations.status, 'active'),
        isNull(schema.organizations.deletedAt),
      ),
      { limit: orgIds.length },
    )
    const activeIds = new Set(organizations.map((organization) => organization.id))
    for (const row of rows) {
      if (!activeIds.has(row.orgId) || activeOrgIds.includes(row.orgId)) continue
      activeOrgIds.push(row.orgId)
      if (activeOrgIds.length === 2) break
    }

    if (rows.length < ACTIVE_ORG_LOOKUP_BATCH_SIZE) break
    const last = rows[rows.length - 1]
    if (!last || last.id === cursor) break
    cursor = last.id
  }

  return activeOrgIds
}
