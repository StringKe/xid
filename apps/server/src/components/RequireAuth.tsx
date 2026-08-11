// 受保护路由:未登录重定向 /sign-in?continue=...。

import { useLingui } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import { Navigate, useLocation } from '../lib/router'
import * as stylex from '@stylexjs/stylex'
import { useAuth, type AuthSession } from '../lib/auth-context'
import { Spinner } from './ui'
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
