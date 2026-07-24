// XidProvider:注入 XidClient + publishableKey,启动时调用 client.load()。
// 对标 @clerk/clerk-react ClerkProvider。

import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'

import { XidClient, type XidClientOptions } from '@xid-kit/core'

import { XidContext } from './xid-context'

export type XidProviderProps = {
  publishableKey: string
  children: ReactNode
  // 覆盖 API 根(自托管场景,默认同域相对路径)。
  apiUrl?: string
  // 注入 fetch(测试用)。
  fetcher?: XidClientOptions['fetcher']
}

export function XidProvider({
  publishableKey,
  children,
  apiUrl,
  fetcher,
}: XidProviderProps): ReactNode {
  // client 仅在 apiUrl 变化时重建,稳定引用减少重渲染。
  const clientOptions = useMemo<XidClientOptions>(
    () => ({
      ...(apiUrl ? { apiUrl } : {}),
      ...(fetcher ? { fetcher } : {}),
    }),
    // eslint 会警告 fetcher 不稳定引用,调用者应 useCallback 包裹
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [apiUrl],
  )

  const [client] = useState(() => new XidClient(clientOptions))

  // 首次挂载拉取登录态;AbortController 在卸载时取消。
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    const ac = new AbortController()
    abortRef.current = ac
    void client.load({ signal: ac.signal })
    return () => {
      ac.abort()
    }
  }, [client])

  const value = useMemo(() => ({ client, publishableKey }), [client, publishableKey])

  return <XidContext.Provider value={value}>{children}</XidContext.Provider>
}
