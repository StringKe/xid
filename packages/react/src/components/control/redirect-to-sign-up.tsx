// 在 useEffect 中跳转,避免 SSR hydration 期间改 location。

import { useEffect } from 'react'
import type { ReactNode } from 'react'

import { useXidContext } from '../../context/xid-context'
import { runAuthorizationRedirect } from './authorization-redirect'

export type RedirectToSignUpProps = {
  signUpUrl?: string
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
