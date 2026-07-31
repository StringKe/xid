// Browser session HTTP wire contracts shared by Core Worker, private web-ui, and public SDKs.
// Keeping the response shapes here prevents one consumer from silently inventing a field or route.

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
  // 是否已有 passwords 行:account portal 用它在 "Change password" 与 "Set a password"(邮件
  // 链接仪式)之间切换。可选以兼容旧版 Core 响应,缺失时前端回退 change-password 形态。
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
