// RedirectToSignUp:挂载即跳转到注册页(对标 Clerk <RedirectToSignUp>)。
// 在 useEffect 中执行重定向,避免 SSR hydration 问题。

import { useEffect } from 'react'
import type { ReactNode } from 'react'

export type RedirectToSignUpProps = {
  // 注册页路径,默认 /sign-up
  signUpUrl?: string
  // 注册后返回的 URL(encoded 传 redirect_url param)
  redirectUrl?: string
}

export function RedirectToSignUp({
  signUpUrl = '/sign-up',
  redirectUrl,
}: RedirectToSignUpProps): ReactNode {
  useEffect(() => {
    const target = redirectUrl
      ? `${signUpUrl}?redirect_url=${encodeURIComponent(redirectUrl)}`
      : signUpUrl
    window.location.replace(target)
  }, [signUpUrl, redirectUrl])

  return null
}
