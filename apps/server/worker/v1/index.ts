// Management API v1 路由注册汇总。
// 由 routes.ts registerAllRoutes 调用,不直接改 worker/index.ts。
// 各模块 export 独立注册函数,此处统一挂到 parent Hono app。

import type { Hono } from 'hono'
import type { XidHonoEnv } from '../lib/types'
import { registerApplications } from './applications'
import { registerConnections } from './connections'
import { registerDirectories } from './directories'
import { registerRoles } from './roles'
import { registerPermissions } from './permissions'
import { registerWebhooks } from './webhooks'
import { registerApiKeys } from './api-keys'
import { registerProjectGrants } from './project-grants'
import { registerUserGrants } from './user-grants'
// 身份资源(users/organizations/memberships/invitations/sessions)
import { registerUsersRoutes } from './users'
import { registerOrganizationsRoutes } from './organizations'
import { registerMembershipsRoutes } from './memberships'
import { registerOrgUnitsRoutes } from './org-units'
import { registerAccessRequestsRoutes } from './access-requests'
import { registerInvitationsRoutes } from './invitations'
import { registerSessionsRoutes } from './sessions'
import { registerCustomHostnameRoutes } from './custom-hostnames'
import { registerProjects } from './projects'
import { registerRolePermissions } from './role-permissions'
import { registerManagerAssignments } from './manager-assignments'

export function registerV1Routes(app: Hono<XidHonoEnv>): void {
  registerApplications(app)
  registerConnections(app)
  registerDirectories(app)
  registerRoles(app)
  registerPermissions(app)
  registerWebhooks(app)
  registerApiKeys(app)
  registerProjectGrants(app)
  registerUserGrants(app)
  // 身份资源
  registerUsersRoutes(app)
  registerOrganizationsRoutes(app)
  registerMembershipsRoutes(app)
  registerOrgUnitsRoutes(app)
  registerAccessRequestsRoutes(app)
  registerInvitationsRoutes(app)
  registerSessionsRoutes(app)
  registerCustomHostnameRoutes(app)
  registerProjects(app)
  registerRolePermissions(app)
  registerManagerAssignments(app)
}
