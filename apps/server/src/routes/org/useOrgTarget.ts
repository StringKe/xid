import { useAuth } from '../../lib/auth-context'
import type { AuthOrg } from '../../lib/auth-context'
import { organizationDisplayName } from '../../lib/display-names'
import { isOrgManagerRole } from '../../lib/org-route-access'
import type { ReactNode } from 'react'

export type OrgTarget = {
  orgId: string
  orgName: ReactNode
  activeOrg: AuthOrg | null
}

export function useOrgTarget(): OrgTarget {
  const { activeOrg } = useAuth()
  const orgId = activeOrg?.id ?? ''
  const orgName = activeOrg ? organizationDisplayName(activeOrg) : null
  return { orgId, orgName, activeOrg }
}

// org 管理接口的服务端门控是 requireOrgManager(worker/v1/shared.ts,owner/admin/org_manager),
// 客户端 enabled 必须与之同源判角色:只判 orgId 会让 member 或角色尚未解析的上下文打出必然 403 的请求。
// activeOrg 为 null(会话加载中)时返回 false,解析完成后 activeOrg 变化触发重渲染自动放行,不会永久禁用。
// 判据与路由守卫 canAccessOrgConsoleRoute(lib/org-route-access.ts)镜像,含 org 归属校验。
export function useCanManageOrg(orgId: string): boolean {
  const { activeOrg } = useAuth()
  if (!orgId || !activeOrg) return false
  return activeOrg.id === orgId && isOrgManagerRole(activeOrg.role)
}
