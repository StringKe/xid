// 受保护路由:未登录重定向 /sign-in?continue=...;pending MFA 会话只能进入完成 MFA 的页面;
// 会话暂时取不到(离线、5xx)时显示可重试的错误,不当作登出。

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Navigate, useLocation } from '../tanstack-router'
import {
  isPendingMfaStatus,
  pendingMfaCompletionPath,
  signInRedirectTarget,
  useAuth,
} from '../session'
import type { PendingMfaAuthStatus } from '../session'
import { Alert, Button, Spinner } from './ui'

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
    padding: '1rem',
  },
  failure: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: '1rem',
    maxWidth: '28rem',
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

  if (status === 'error') return <SessionUnavailable />

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

function SessionUnavailable(): ReactNode {
  const { refresh } = useAuth()
  const [retrying, setRetrying] = useState(false)

  async function retry(): Promise<void> {
    setRetrying(true)
    await refresh()
    setRetrying(false)
  }

  return (
    <div {...stylex.props(styles.center)}>
      <div {...stylex.props(styles.failure)}>
        <Alert tone="error" title={<Trans>Could not check your session</Trans>}>
          <Trans>The server could not be reached. Check your connection and try again.</Trans>
        </Alert>
        <Button type="button" isLoading={retrying} onClick={() => void retry()}>
          <Trans>Try again</Trans>
        </Button>
      </div>
    </div>
  )
}
