// RedirectToSignIn:未登录时重定向到登录页(对标 Clerk <RedirectToSignIn>)。
// 在 useEffect 中执行重定向,避免 SSR hydration 问题。

import { useEffect } from 'react'
import type { ReactNode } from 'react'

import { useXidContext } from '../../context/xid-context'
import { runAuthorizationRedirect } from './authorization-redirect'

export type RedirectToSignInProps = {
  // 登录页路径,默认 /sign-in
  signInUrl?: string
  // 登录后返回的应用内 URL。
  redirectUrl?: string
  onError?: (error: unknown) => void
}

export function RedirectToSignIn({
  signInUrl = '/sign-in',
  redirectUrl,
  onError,
}: RedirectToSignInProps): ReactNode {
  const { client, mode } = useXidContext()
  useEffect(() => {
    runAuthorizationRedirect(
      {
        client,
        mode,
        intent: 'sign-in',
        ...(redirectUrl ? { returnUrl: redirectUrl } : {}),
        sameOriginPath: signInUrl,
        navigation: 'replace',
      },
      onError,
    )
  }, [client, mode, signInUrl, redirectUrl, onError])

  return null
}
