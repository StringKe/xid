// 受保护路由:未登录重定向 /sign-in?continue=...;pending MFA 会话只能进入完成 MFA 的页面。

import { useLingui } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import { Navigate, useLocation } from '../lib/router'
import * as stylex from '@stylexjs/stylex'
import {
  isPendingMfaStatus,
  pendingMfaCompletionPath,
  useAuth,
  type PendingMfaAuthStatus,
} from '../lib/auth-context'
import { Spinner } from './ui'
import { signInRedirectTarget } from './require-auth-redirect'

export type RequireAuthProps = {
  children: ReactNode
  // 本页负责完成的 pending MFA 状态:该状态下直接渲染,不重定向。
  completesPendingMfa?: PendingMfaAuthStatus
}

const styles = stylex.create({
  center: {
    minHeight: '100dvh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
})

export function RequireAuth({ children, completesPendingMfa }: RequireAuthProps): ReactNode {
  const { status } = useAuth()
  const location = useLocation()
  const { t } = useLingui()

  if (status === 'loading') {
    return (
      <div {...stylex.props(styles.center)}>
        <Spinner label={t`Loading your session`} />
      </div>
    )
  }

  if (status === 'unauthenticated') {
    return (
      <Navigate
        to={signInRedirectTarget(location.pathname, location.search, location.hash)}
        replace
      />
    )
  }

  if (isPendingMfaStatus(status) && status !== completesPendingMfa) {
    const returnTo = `${location.pathname}${location.search}`
    return <Navigate to={pendingMfaCompletionPath(status, returnTo)} replace />
  }

  return children
}
