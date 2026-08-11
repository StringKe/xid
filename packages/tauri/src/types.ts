// 与 docs/sdks/platform-matrix.md Shared native contract 对齐的公开类型。

import type { XidKeychainAdapter } from './keychain'

// keychain 中的最小会话视图（除 userId/orgId 外不存 PII）。
export type StoredSession = {
  userId: string
  organizationId: string | null
  expiresAt: number // epoch 秒
  abandonAt: number // epoch 秒
}

export type XidTauriClientOptions = {
  issuer: string
  clientId: string
  // tauri.conf.json 中注册的自定义 scheme，如 myapp://auth/callback。
  redirectUri: string
  scopes?: readonly string[]
  keychain?: XidKeychainAdapter
  fetcher?: typeof fetch
  now?: () => number
}

export type SignInOptions = {
  scopes?: readonly string[]
  // 可传入 @tauri-apps/plugin-shell 的 open，在返回前直接打开授权 URL。
  openUrl?: (url: string) => Promise<void>
}

export type TauriSession = {
  userId: string
  organizationId: string | null
  accessToken: string
  expiresAt: number // epoch 秒
}

export type XidTauriClient = {
  signIn(options?: SignInOptions): Promise<URL>
  // 从 deeplink 回调（onOpenUrl / deep-link://new-url）调用。
  handleRedirect(url: string): Promise<void>
  getSession(): Promise<TauriSession | null>
  // 过期或已登出返回 null，需重新授权（本 SDK 无网络 refresh）。
  getAccessToken(options?: { skipCache?: boolean }): Promise<string | null>
  signOut(): Promise<void>
  buildSignOutUrl(options?: { postLogoutRedirectUri?: string; idTokenHint?: string }): URL
  setTokenStorage(adapter: XidKeychainAdapter): void
}
