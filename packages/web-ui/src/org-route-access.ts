import type { AuthOrg } from './session/contracts'
import type { OrganizationMembershipRole } from '@xid-kit/types'

// 镜像 worker requireOrgManager:仅 owner/admin 进 org console;/v1/me 已把 org_manager 映射为 admin,
// 此处不再认 manager;instance_manager 走 /console/platform 独立守卫。
export function isOrgManagerRole(role: OrganizationMembershipRole): boolean {
  return role === 'owner' || role === 'admin'
}

export function canAccessOrgConsoleRoute(input: {
  activeOrg: AuthOrg | null
  targetOrgId: string | null
}): boolean {
  if (!input.activeOrg) return false
  if (!isOrgManagerRole(input.activeOrg.role)) return false
  return input.targetOrgId === null || input.targetOrgId === input.activeOrg.id
}
