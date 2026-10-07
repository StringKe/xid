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
  // 自助创建组织的资格(与 POST /v1/organizations/self 同一判定);缺失时按不可创建处理
  canCreateOrganization?: boolean
  // 登录后 passkey 创建插页的展示资格:租户已解析、允许 passkey、未达上限且当前没有有效 passkey
  passkeyEnrollmentEligible?: boolean
  provisioned_by?: 'anonymous' | (string & {}) | null
}

export type BrowserAuthOrganization = {
  id: string
  slug: string
  name: string
  role: OrganizationMembershipRole
  permissions: readonly string[]
  // null 表示租户顶层组织;Applications、API keys、Webhooks、Compliance 只能由顶层组织管理。
  parentOrgId: string | null
  allowOrgSelfService: boolean
  // owner 或该组织的 org_manager 才能授予或移除 owner,与服务端 canManageOwners 一致。
  canManageOwners: boolean
  logoUrl?: string | null
  // 只对 membership 来源的组织有值;仅凭 org_manager 行列出的组织为 null。
  joinedAt?: string | null
  // 目录同步管理的成员关系,本人不能自行离开。
  isManaged?: boolean
}

export type BrowserImpersonator = {
  userId: string
  displayName: string | null
  email: string | null
}

export type BrowserAuthSession = {
  id: string
  status: 'active' | 'pending_mfa' | 'pending_mfa_setup'
  expiresAt: string
  isImpersonation: boolean
  userId: string
  activeOrganizationId: string | null
  lastActiveAt: string
  // 只在 isImpersonation 时非空。
  impersonator?: BrowserImpersonator | null
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
