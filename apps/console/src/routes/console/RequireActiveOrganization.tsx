// RequireActiveOrganization:org 管理路由守卫(orgRoute 专用)。
// 角色不足(member)与无 org 上下文分流:member 回 /account 自助门户,
// 无 activeOrg 或 targetOrgId 不匹配回 /console/organizations 重新选择。
import type { ReactNode } from 'react'
import { useAuth } from '@xid-kit/web-ui/session'
import { canAccessOrgConsoleRoute, isOrgManagerRole } from '@xid-kit/web-ui/org-route-access'
import { Navigate, useSearchParams } from '@xid-kit/web-ui/tanstack-router'

export function RequireActiveOrganization({ children }: { children: ReactNode }): ReactNode {
  const { activeOrg } = useAuth()
  const [searchParams] = useSearchParams()
  const targetOrgId = searchParams.get('orgId')
  if (activeOrg && !isOrgManagerRole(activeOrg.role)) {
    return <Navigate to="/account" replace />
  }
  if (!canAccessOrgConsoleRoute({ activeOrg, targetOrgId })) {
    return <Navigate to="/console/organizations" replace />
  }
  return children
}
