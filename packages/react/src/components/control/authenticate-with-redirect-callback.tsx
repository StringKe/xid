// 服务端已在 /oauth/callback 完成 code exchange 并落 cookie;此处只同步 SDK 会话并跳转。

import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import type { HandleRedirectCallbackResult } from '@xid-kit/core'

import { useXidContext } from '../../context/xid-context'

export type AuthenticateWithRedirectCallbackProps = {
  afterSignInUrl?: string
  afterSignUpUrl?: string
  onSuccess?: (result: HandleRedirectCallbackResult) => void
  onError?: (error: unknown) => void
}

export function AuthenticateWithRedirectCallback({
  afterSignInUrl,
  afterSignUpUrl,
  onSuccess,
  onError,
}: AuthenticateWithRedirectCallbackProps): ReactNode {
  const { client } = useXidContext()
  // 防止 StrictMode 双次 effect 导致重复跳转
  const ranRef = useRef(false)

  useEffect(() => {
    if (ranRef.current) return
    ranRef.current = true

    const ac = new AbortController()

    void (async (): Promise<void> => {
      try {
        const result = await client.handleRedirectCallback(globalThis.location.href, {
          signal: ac.signal,
        })
        if (!result.ok) throw result.error
        if (onSuccess) {
          onSuccess(result.value)
          return
        }
        const target =
          result.value.intent === 'sign-up'
            ? (afterSignUpUrl ?? result.value.returnUrl)
            : (afterSignInUrl ?? result.value.returnUrl)
        window.location.replace(target)
      } catch (error) {
        if ((error as { name?: string }).name === 'AbortError') return
        if (onError) {
          onError(error)
        }
      }
    })()

    return () => {
      ac.abort()
    }
  }, [client, afterSignInUrl, afterSignUpUrl, onSuccess, onError])

  return null
}
