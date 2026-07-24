// RedirectToSignIn:未登录时重定向到登录页(对标 Clerk <RedirectToSignIn>)。
// 在 useEffect 中执行重定向,避免 SSR hydration 问题。

import { useEffect } from 'react'
import type { ReactNode } from 'react'

export type RedirectToSignInProps = {
  // 登录页路径,默认 /sign-in
  signInUrl?: string
  // 登录后返回的 URL(encoded 传 redirect_url param)
  redirectUrl?: string
}

export function RedirectToSignIn({
  signInUrl = '/sign-in',
  redirectUrl,
}: RedirectToSignInProps): ReactNode {
  useEffect(() => {
    const target = redirectUrl
      ? `${signInUrl}?redirect_url=${encodeURIComponent(redirectUrl)}`
      : signInUrl
    window.location.replace(target)
  }, [signInUrl, redirectUrl])

  return null
}
