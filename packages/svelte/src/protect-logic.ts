// protect-logic.ts:Protect 组件的纯逻辑层。
// 判断当前 XidState 是否满足 permission / role 要求,供 Protect.svelte 调用。
// 纯函数方便单元测试,不依赖 Svelte runtime。

import type { XidState } from '@xid-kit/core'

export type ProtectOptions = {
  // 要求拥有该 permission(org 权限字符串,如 "org:member:read")。
  permission?: string
  // 要求拥有该 role(如 "org:admin")。
  role?: string
}

// isAllowed:检查 XidState 是否通过保护条件。
// - 未加载或未登录:返回 false。
// - permission / role 均未指定:已登录即通过。
// - 指定 role:要求活跃 membership.role 匹配。
// - 指定 permission:要求活跃 membership.permissions 包含该值。
export function isAllowed(state: XidState, options: ProtectOptions): boolean {
  if (!state.isLoaded || !state.isSignedIn) return false

  const { permission, role } = options
  if (permission === undefined && role === undefined) return true

  const memberships = state.user?.organizationMemberships ?? []
  const activeMembership = memberships.find((m) => m.organization.id === state.organization?.id)

  if (role !== undefined && activeMembership?.role !== role) return false
  if (permission !== undefined && !activeMembership?.permissions.includes(permission)) return false

  return true
}
