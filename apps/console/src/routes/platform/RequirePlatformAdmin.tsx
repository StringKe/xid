// 权限来自 ManagerAssignment(instance_manager),不进业务 token;未通过回 /console,避免停在全拒 URL。

import type { ReactNode } from 'react'
import { Navigate } from '@xid-kit/web-ui/tanstack-router'
import * as stylex from '@stylexjs/stylex'
import { useAuth } from '@xid-kit/web-ui/session'
import { Spinner } from '@xid-kit/web-ui/ui'
import { page } from '@xid-kit/web-ui/styles/product-surface.stylex'

export type RequirePlatformAdminProps = {
  children: ReactNode
}

export function RequirePlatformAdmin({ children }: RequirePlatformAdminProps): ReactNode {
  const { status, user } = useAuth()

  if (status === 'loading') {
    return (
      <div {...stylex.props(page.loadingCenter)}>
        <Spinner />
      </div>
    )
  }

  const isInstanceManager = user?.instanceManager === true

  if (!isInstanceManager) {
    return <Navigate to="/console" replace />
  }

  return children
}
