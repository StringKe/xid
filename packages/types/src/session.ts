// Browser session 的 HTTP wire 契约；集中定义避免各消费方私自加字段或路径。

import type { OrganizationMembershipRole, TenantManagerRoleScope } from './rbac'

export type BrowserAuthUser = {
  id: string
  email: string
  emailVerified: boolean
  name: string | null
  imageUrl: string | null
  locale: string | null
  hasMfa: boolean
  instanceManager: boolean
  // account portal 据此在「改密」与「设密」间切换；可选以兼容旧 Core 响应，缺失时前端按改密处理
  hasPassword?: boolean
  provisioned_by?: 'anonymous' | (string & {}) | null
}

export type BrowserAuthOrganization = {
  id: string
  slug: string
  name: string
  role: OrganizationMembershipRole
  permissions: readonly string[]
}

export type BrowserAuthSession = {
  id: string
  status: 'active' | 'pending_mfa' | 'pending_mfa_setup'
  expiresAt: string
  isImpersonation: boolean
  userId: string
  activeOrganizationId: string | null
  lastActiveAt: string
}

type BrowserManagerScopeStatus<TScope extends TenantManagerRoleScope['scopeType']> =
  TScope extends 'project' ? 'active' | 'deleted' : TScope extends 'grant' ? 'active' : never

type ToBrowserManagerAssignment<TContract extends TenantManagerRoleScope> =
  TContract extends TenantManagerRoleScope
    ? BrowserManagerScopeStatus<TContract['scopeType']> extends never
      ? never
      : TContract & {
          id: string
          scopeId: string
          scopeStatus: BrowserManagerScopeStatus<TContract['scopeType']>
        }
    : never

export type BrowserManagerAssignment = ToBrowserManagerAssignment<TenantManagerRoleScope>

export type BrowserMeResponse = {
  user: BrowserAuthUser | null
  activeOrg: BrowserAuthOrganization | null
  organizations: readonly BrowserAuthOrganization[]
  managerAssignments: readonly BrowserManagerAssignment[]
  session: BrowserAuthSession | null
  activeSessionId: string | null
  sessions: readonly BrowserAuthSession[]
}

export type SessionTokenResponse = {
  token: string
}

export type ActiveSessionResponse = {
  activeSessionId: string
}

export type ActiveOrganizationResponse = {
  session: {
    id: string
    expiresAt: string
    isImpersonation: boolean
  }
  activeOrganizationId: string | null
}
