// 会话建立后补发跨重定向登录的 login/sign_up(防 finishSignIn 已直报路径重复计数)。

import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { useAuth } from '../lib/auth-context'
import { trackAuthSuccess } from '../lib/google-analytics-funnel'
import { consumePendingAuthCompletion } from '../lib/google-analytics-pending-auth'

export function AuthAnalytics(): ReactNode {
  const { status } = useAuth()
  const previousStatusRef = useRef(status)

  useEffect(() => {
    const previousStatus = previousStatusRef.current
    previousStatusRef.current = status

    if (status !== 'authenticated') return
    if (previousStatus === 'authenticated') return

    const pending = consumePendingAuthCompletion()
    if (!pending) return
    trackAuthSuccess(pending)
  }, [status])

  return null
}
