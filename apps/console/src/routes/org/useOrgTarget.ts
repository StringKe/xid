import { useAuth } from '@xid-kit/web-ui/session'
import type { AuthOrg } from '@xid-kit/web-ui/session'
import { organizationDisplayName } from '@xid-kit/web-ui/display-names'
import { isOrgManagerRole } from '@xid-kit/web-ui/org-route-access'
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

// 与 requireOrgManager 同源:只判 orgId 会让 member/未解析会话打出必然 403;activeOrg 空时 false 等会话就绪。
export function useCanManageOrg(orgId: string): boolean {
  const { activeOrg } = useAuth()
  if (!orgId || !activeOrg) return false
  return activeOrg.id === orgId && isOrgManagerRole(activeOrg.role)
}

// Applications、API keys、Webhooks、Compliance 属于整个租户,服务端只允许顶层组织管理员调用。
export function useIsTenantScopeOrg(): boolean {
  const { activeOrg } = useAuth()
  const canManage = useCanManageOrg(activeOrg?.id ?? '')
  return canManage && activeOrg?.parentOrgId === null
}

export function useCanManageOwners(): boolean {
  const { activeOrg } = useAuth()
  return activeOrg?.canManageOwners === true
}

// allow_org_self_service=false 时,SSO、登录策略、投递通道、社交登录与出站 SAML 由平台管理员维护。
export function useOrgSelfServiceLocked(): boolean {
  const { activeOrg, user } = useAuth()
  return activeOrg?.allowOrgSelfService === false && user?.instanceManager !== true
}
