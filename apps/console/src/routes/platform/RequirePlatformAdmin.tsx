// RequirePlatformAdmin:platform console 模块守卫。
// 平台管理权限来自 ManagerAssignment(instance_manager / scope=instance),不进入业务 token。
// 此组件检查 /v1/me 的 user.instanceManager 字段;worker 侧与平台 API 守卫共用同一语义。
// 未通过:重定向回 /console(与 RequireAuth 叠用:外层 RequireAuth 保证已登录),
// 不让用户停留在整组 nav 都指向同一拒绝页的 URL 上。

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
