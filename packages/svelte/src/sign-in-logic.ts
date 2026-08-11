import type { XidClient } from '@xid-kit/core'
import type { Result, XidError } from '@xid-kit/types'

export function buildSignInUrl(signInUrl: string, redirectUrl?: string): string {
  if (!redirectUrl) return signInUrl
  return `${signInUrl}?redirect_url=${encodeURIComponent(redirectUrl)}`
}

// navigate 可注入，默认 window.location.assign，便于测试
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
