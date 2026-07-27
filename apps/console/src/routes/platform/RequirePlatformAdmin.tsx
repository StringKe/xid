// RequirePlatformAdmin:platform console 模块守卫。
// 平台管理权限来自 ManagerAssignment(instance_manager / scope=instance),不进入业务 token。
// 此组件检查 /v1/me 的 user.instanceManager 字段;worker 侧与平台 API 守卫共用同一语义。
// 未通过:显示无权限提示,不重定向(与 RequireAuth 叠用:外层 RequireAuth 保证已登录)。

import { Trans } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { useAuth } from '@xid-kit/web-ui/session'
import { Alert, Spinner } from '@xid-kit/web-ui/ui'
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
    return (
      <Alert tone="error">
        <Trans>
          You do not have permission to access this area. Instance Manager access is required.
        </Trans>
      </Alert>
    )
  }

  return children
}
