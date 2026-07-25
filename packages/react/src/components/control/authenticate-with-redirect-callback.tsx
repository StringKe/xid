// AuthenticateWithRedirectCallback:OAuth 授权码回调处理器。
// 挂载后调用 client.load() 使 SDK 读取服务端已建立的会话(服务端在 /oauth/callback 完成 code exchange 并落 cookie),
// 完成后重定向到 afterSignInUrl / afterSignUpUrl 或调用 onSuccess。

import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'

import { useXidContext } from '../../context/xid-context'

export type AuthenticateWithRedirectCallbackProps = {
  // 登录成功后跳转(默认 '/')
  afterSignInUrl?: string
  // 注册成功后跳转(默认 '/')
  afterSignUpUrl?: string
  // 优先级高于 afterSignInUrl/afterSignUpUrl 的自定义成功回调
  onSuccess?: () => void
  // 失败回调
  onError?: (error: unknown) => void
}

export function AuthenticateWithRedirectCallback({
  afterSignInUrl = '/',
  afterSignUpUrl,
  onSuccess,
  onError,
}: AuthenticateWithRedirectCallbackProps): ReactNode {
  const { client } = useXidContext()
  // 防止 StrictMode 双次触发重复跳转
  const ranRef = useRef(false)

  useEffect(() => {
    if (ranRef.current) return
    ranRef.current = true

    const ac = new AbortController()

    void (async (): Promise<void> => {
      try {
        await client.load({ signal: ac.signal })
        if (onSuccess) {
          onSuccess()
          return
        }
        // afterSignUpUrl 优先用于首次注册场景;回退 afterSignInUrl。
        const target = afterSignUpUrl ?? afterSignInUrl
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
