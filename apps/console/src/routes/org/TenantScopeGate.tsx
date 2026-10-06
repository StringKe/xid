import { Trans } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import { Alert, ConsolePage, ConsolePageNotice } from '@xid-kit/web-ui/ui'
import { useAuth } from '@xid-kit/web-ui/session'

// 租户级资源只能由顶层组织管理;子组织直接访问 URL 时说明原因,不发出必然 403 的请求。
export function TenantScopeGate({
  title,
  children,
}: {
  title: ReactNode
  children: ReactNode
}): ReactNode {
  const { activeOrg } = useAuth()
  if (!activeOrg || activeOrg.parentOrgId === null) return children
  return (
    <ConsolePage wide title={title}>
      <ConsolePageNotice>
        <Alert tone="info">
          <Trans>
            This resource is shared by every organization in the tenant. Switch to the top-level
            organization to manage it.
          </Trans>
        </Alert>
      </ConsolePageNotice>
    </ConsolePage>
  )
}
