// RequireAuth:受保护路由守卫。未登录重定向到 /sign-in?continue=...,加载中显示 spinner。
// 已登录才渲染 children;配合 useAuth 的三态(loading/authenticated/unauthenticated)。
// 加载态容器样式走 StyleX。

import { useLingui } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import { Navigate, useLocation } from '@xid-kit/web-ui/tanstack-router'
import * as stylex from '@stylexjs/stylex'
import { useAuth, type AuthSession } from '@xid-kit/web-ui/session'
import { Spinner } from '@xid-kit/web-ui/ui'
import { signInRedirectTarget } from './require-auth-redirect'

export type RequireAuthProps = {
  children: ReactNode
}

const styles = stylex.create({
  center: {
    minHeight: '100dvh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
})

function mfaGateRedirect(
  sessionStatus: AuthSession['status'] | undefined,
  pathname: string,
): string | null {
  if (sessionStatus === 'pending_mfa' && !pathname.startsWith('/mfa')) {
    const params = new URLSearchParams({ redirect_to: pathname })
    return `/mfa?${params.toString()}`
  }
  if (sessionStatus === 'pending_mfa_setup' && !pathname.startsWith('/account/security')) {
    const params = new URLSearchParams({ setup: 'mfa', redirect_to: pathname })
    return `/account/security?${params.toString()}`
  }
  return null
}

export function RequireAuth({ children }: RequireAuthProps): ReactNode {
  const { status, session } = useAuth()
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

  const gateRedirect = mfaGateRedirect(session?.status, location.pathname)
  if (gateRedirect) {
    return <Navigate to={gateRedirect} replace />
  }

  return children
}
