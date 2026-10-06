// org 路由守卫:?orgId= 指向另一个可管理 org 时先切换再原地渲染;不可管理的目标回组织列表并提示。
import { Trans, useLingui } from '@lingui/react/macro'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useAuth } from '@xid-kit/web-ui/session'
import type { AuthOrg } from '@xid-kit/web-ui/session'
import { canAccessOrgConsoleRoute, isOrgManagerRole } from '@xid-kit/web-ui/org-route-access'
import { Navigate, useSearchParams } from '@xid-kit/web-ui/tanstack-router'
import { Alert, ConsolePage, ConsolePageSection, Spinner } from '@xid-kit/web-ui/ui'
import { ORGANIZATION_UNAVAILABLE_NOTICE } from './ConsoleEntryRoutes'

const ORGANIZATION_SELECTION_PATH = '/console/organizations'

export function RequireActiveOrganization({ children }: { children: ReactNode }): ReactNode {
  const { activeOrg, organizations } = useAuth()
  const [searchParams] = useSearchParams()
  const targetOrgId = searchParams.get('orgId')
  if (canAccessOrgConsoleRoute({ activeOrg, targetOrgId })) return children

  const requestedOrgId = targetOrgId ?? activeOrg?.id ?? null
  const targetOrg = organizations.find(
    (org) => org.id === requestedOrgId && isOrgManagerRole(org.role),
  )
  if (targetOrg && targetOrgId) {
    return <SwitchToOrganization org={targetOrg}>{children}</SwitchToOrganization>
  }
  if (targetOrgId) {
    const params = new URLSearchParams({ notice: ORGANIZATION_UNAVAILABLE_NOTICE })
    return <Navigate to={`${ORGANIZATION_SELECTION_PATH}?${params.toString()}`} replace />
  }
  return <Navigate to={ORGANIZATION_SELECTION_PATH} replace />
}

function SwitchToOrganization({ org, children }: { org: AuthOrg; children: ReactNode }): ReactNode {
  const { activeOrg, setActiveOrganization } = useAuth()
  const { t } = useLingui()
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let active = true
    void setActiveOrganization(org.id).then((ok) => {
      if (active && !ok) setFailed(true)
    })
    return () => {
      active = false
    }
  }, [org.id, setActiveOrganization])

  if (activeOrg?.id === org.id) return children
  if (failed) {
    const params = new URLSearchParams({ notice: ORGANIZATION_UNAVAILABLE_NOTICE })
    return <Navigate to={`${ORGANIZATION_SELECTION_PATH}?${params.toString()}`} replace />
  }
  return (
    <ConsolePage title={<Trans>Open organization</Trans>}>
      <ConsolePageSection>
        <Alert tone="info">
          <Trans>This link opens another organization. Switching the console to it.</Trans>
        </Alert>
        <Spinner label={t`Opening organization`} />
      </ConsolePageSection>
    </ConsolePage>
  )
}
