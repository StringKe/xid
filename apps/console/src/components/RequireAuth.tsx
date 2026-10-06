import { useLingui } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import { Navigate, useLocation } from '@xid-kit/web-ui/tanstack-router'
import * as stylex from '@stylexjs/stylex'
import { isPendingMfaStatus, pendingMfaCompletionPath, useAuth } from '@xid-kit/web-ui/session'
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

export function RequireAuth({ children }: RequireAuthProps): ReactNode {
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

  // pending MFA session 不渲染 Console:交给 Core 完成 MFA 后再回到这里。
  if (isPendingMfaStatus(status)) {
    const returnTo = `${location.pathname}${location.search}`
    return <Navigate to={pendingMfaCompletionPath(status, returnTo)} replace />
  }

  return children
}
