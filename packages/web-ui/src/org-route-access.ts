import type { AuthOrg } from './session/contracts'

// 与 worker requireOrgManager 的放行语义镜像(worker/v1/shared.ts):
// 只有 org owner/admin 能进 org 管理 console;member 落 /account 自助门户。
// /v1/me 已把 org_manager 行映射为 admin role(worker/me/me.ts),此处无需再认 manager 角色。
// instance_manager 不在此放行:平台跨 org 视图走 /console/platform 独立守卫。
export function isOrgManagerRole(role: string): boolean {
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
