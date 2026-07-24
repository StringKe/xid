// sign-in-logic.ts:SignInButton / SignOutButton 纯逻辑层。
// 构造登录 URL 与执行登出的纯函数,供 Svelte 组件桥接。
// 不依赖 Svelte runtime;可单元测试。

import type { XidClient } from '@xid-kit/core'
import type { Result, XidError } from '@xid-kit/types'

// buildSignInUrl:构造带可选 redirect_url 的登录跳转目标。
export function buildSignInUrl(signInUrl: string, redirectUrl?: string): string {
  if (!redirectUrl) return signInUrl
  return `${signInUrl}?redirect_url=${encodeURIComponent(redirectUrl)}`
}

// executeSignOut:执行登出并可选跳转。返回 Result 供调用方处理错误。
// navigate 参数注入 window.location.assign 的替代(测试 mock)。
export async function executeSignOut(
  client: XidClient,
  options: {
    sessionId?: string
    redirectUrl?: string
    navigate?: (url: string) => void
  } = {},
): Promise<Result<null, XidError>> {
  const result = await client.signOut(options.sessionId ? { sessionId: options.sessionId } : {})
  if (result.ok && options.redirectUrl) {
    const nav = options.navigate ?? ((url) => window.location.assign(url))
    nav(options.redirectUrl)
  }
  return result
}
