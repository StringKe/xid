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
