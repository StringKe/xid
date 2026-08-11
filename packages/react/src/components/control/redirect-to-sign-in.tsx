// 在 useEffect 中跳转,避免 SSR hydration 期间改 location。

import { useEffect } from 'react'
import type { ReactNode } from 'react'

import { useXidContext } from '../../context/xid-context'
import { runAuthorizationRedirect } from './authorization-redirect'

export type RedirectToSignInProps = {
  signInUrl?: string
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
