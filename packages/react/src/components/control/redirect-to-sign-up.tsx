// RedirectToSignUp:挂载即跳转到注册页(对标 Clerk <RedirectToSignUp>)。
// 在 useEffect 中执行重定向,避免 SSR hydration 问题。

import { useEffect } from 'react'
import type { ReactNode } from 'react'

import { useXidContext } from '../../context/xid-context'
import { runAuthorizationRedirect } from './authorization-redirect'

export type RedirectToSignUpProps = {
  // 注册页路径,默认 /sign-up
  signUpUrl?: string
  // 注册后返回的应用内 URL。
  redirectUrl?: string
  onError?: (error: unknown) => void
}

export function RedirectToSignUp({
  signUpUrl = '/sign-up',
  redirectUrl,
  onError,
}: RedirectToSignUpProps): ReactNode {
  const { client, mode } = useXidContext()
  useEffect(() => {
    runAuthorizationRedirect(
      {
        client,
        mode,
        intent: 'sign-up',
        ...(redirectUrl ? { returnUrl: redirectUrl } : {}),
        sameOriginPath: signUpUrl,
        navigation: 'replace',
      },
      onError,
    )
  }, [client, mode, signUpUrl, redirectUrl, onError])

  return null
}
