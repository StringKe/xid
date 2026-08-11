// 浏览器登录态只读视图:不含密钥;refresh 在 worker HttpOnly cookie,SDK 仅 getToken 换 short-lived JWT。

import type { OrganizationMembershipRole, XidError } from '@xid-kit/types'

export type XidUser = {
  id: string
  primaryEmailAddress: string | null
  primaryPhoneNumber: string | null
  emailVerified: boolean
  firstName: string | null
  lastName: string | null
  fullName: string | null
  username: string | null
  imageUrl: string | null
  hasImage: boolean
  // 匿名开通为 'anonymous';旧会话/非 guest 可能缺省。
  provisionedBy?: 'anonymous' | (string & {})
  publicMetadata: Readonly<Record<string, unknown>>
  organizationMemberships: readonly XidOrganizationMembership[]
  createdAt: number
  updatedAt: number
}

export type XidOrganization = {
  id: string
  name: string
  slug: string
  imageUrl: string | null
  hasImage: boolean
  membersCount: number
  publicMetadata: Readonly<Record<string, unknown>>
  createdAt: number
}

export type XidOrganizationMembership = {
  id: string
  organization: XidOrganization
  role: OrganizationMembershipRole
  permissions: readonly string[]
  createdAt: number
}

// active 才可 getToken;其余状态驱动 UI 与刷新策略。
export const SESSION_STATUS = [
  'active',
  'pending',
  'expired',
  'removed',
  'ended',
  'revoked',
] as const
export type SessionStatus = (typeof SESSION_STATUS)[number]

export type XidSession = {
  id: string
  status: SessionStatus
  userId: string
  activeOrganizationId: string | null
  lastActiveAt: number
  expireAt: number
  // 空闲过期,与 expireAt 取先到者。
  abandonAt: number
  createdAt: number
}

// secret 明文仅在 create 响应出现一次。
export type XidApiKey = {
  id: string
  name: string
  keyPrefix: string
  environment: string
  scopes: readonly string[]
  lastUsedAt: number | null
  expiresAt: number | null
  revokedAt: number | null
  createdAt: number
}

export type XidApiKeyWithSecret = XidApiKey & {
  key: string
}

export type XidPage<T> = {
  data: readonly T[]
  nextCursor: string | null
  hasMore: boolean
}

export type CreateApiKeyInput = {
  name: string
  environment?: 'live' | 'test' | string
  scopes?: readonly string[]
  expiresAt?: string | null
  signal?: AbortSignal
}

export type SignInPasswordInput = {
  identifier: string
  password: string
  turnstileToken?: string | null
  signal?: AbortSignal
}

// Turnstile 在 env.TURNSTILE_SECRET 配置时必传。
export type SignInAnonymouslyInput = {
  turnstileToken?: string | null
  signal?: AbortSignal
}

export type UpgradeGuestWithPasskeyInput = {
  deviceName?: string
  signal?: AbortSignal
}

export type SignInResult = {
  redirectUrl?: string
  nextStep?: 'verify_email' | 'complete'
}

// status 是 SDK 生命周期,与 SessionStatus(单会话)区分。
export const CLIENT_STATUS = ['loading', 'ready', 'degraded', 'error'] as const
export type ClientStatus = (typeof CLIENT_STATUS)[number]

export type XidState = {
  status: ClientStatus
  isLoaded: boolean
  isSignedIn: boolean
  session: XidSession | null
  user: XidUser | null
  organization: XidOrganization | null
  sessions: readonly XidSession[]
  error: XidError | null
}

// redirectUrl 由 Core 决定,SDK 不复制 onboarding 路由;展开 XidState 字段兼容旧 Result,新代码读 state。
export type SignInAnonymouslyResult =
  | (XidState & {
      state: XidState
      sessionId: string
      redirectUrl: string
      nextStep: 'redirect'
    })
  | (XidState & {
      state: XidState
      sessionId: string
      redirectUrl: null
      nextStep: 'complete'
    })

export type XidStateListener = (state: XidState) => void
export type Unsubscribe = () => void

export type GetTokenOptions = {
  // 敏感操作前跳过缓存强制刷新。
  skipCache?: boolean
  leewaySeconds?: number
  signal?: AbortSignal
}

export type ManagementUser = {
  id: string
  username: string | null
  externalId: string | null
  firstName: string | null
  lastName: string | null
  displayName: string | null
  status: string
  publicMetadata: Readonly<Record<string, unknown>>
  locale: string | null
  createdAt: number
  updatedAt: number
}

export type ManagementSession = {
  id: string
  userId: string
  activeOrgId: string | null
  status: string
  expiresAt: number
  createdAt: number
}

export type ListUsersInput = {
  search?: string
  limit?: number
  cursor?: string | null
  signal?: AbortSignal
}

export type ListSessionsInput = {
  userId?: string
  limit?: number
  cursor?: string | null
  signal?: AbortSignal
}

export type XidTokenCache = {
  getToken(key: string): Promise<string | null>
  saveToken(key: string, value: string): Promise<void>
  deleteToken(key: string): Promise<void>
  coordinationNamespace?: string
}

export type OidcAuthorizationIntent = 'sign-in' | 'sign-up'

export type CreateAuthorizationUrlInput = {
  intent?: OidcAuthorizationIntent
  returnUrl?: string
  loginHint?: string
  prompt?: 'login' | 'consent' | 'select_account' | 'none'
  signal?: AbortSignal
}

export type HandleRedirectCallbackResult = {
  returnUrl: string
  intent: OidcAuthorizationIntent
}

// prompt=none 被 IdP 拒绝时的交互类错误:静默重认证的预期失败,应降级 redirect 或交互授权。
export const SILENT_AUTHORIZATION_ERRORS = [
  'login_required',
  'consent_required',
  'interaction_required',
] as const
export type SilentAuthorizationError = (typeof SILENT_AUTHORIZATION_ERRORS)[number]

// silent redirect 回跳被拒时的内部返回;映射为失败 Result,不抛错、不污染 session。
export type SilentRedirectCallbackResult = {
  returnUrl: string
  silentError: SilentAuthorizationError
}

export type SignInSilentInput = {
  // 第三方 cookie 拦截时 iframe 拿不到 Lax cookie,超时与 login_required 同为预期失败。
  timeoutMs?: number
  signal?: AbortSignal
}

export type SameOriginXidClientOptions = {
  mode?: 'same-origin'
  // cookie 模式仅允许相对 URL 或当前页 exact same-origin。
  apiUrl?: string
  // sk_live_/sk_test_;设置后走 Bearer 而非 cookie session。
  secretKey?: string
  fetcher?: typeof fetch
  now?: () => number
}

export type OidcXidClientOptions = {
  mode: 'oidc'
  issuer: string
  // 公开 OAuth client_id,不是 Management API key。
  clientId: string
  // 须与 application.redirect_uris 精确相等,禁止通配。
  redirectUri: string
  // 默认 openid profile email;浏览器基线禁止 offline_access。
  scopes?: readonly string[]
  // RP-initiated logout 回跳,须预先注册。
  postLogoutRedirectUri?: string
  tokenCache?: XidTokenCache
  fetcher?: typeof fetch
  now?: () => number
}

// 跨域必须显式 mode:'oidc';省略 mode 仅表示 same-origin Core。
export type XidClientOptions = SameOriginXidClientOptions | OidcXidClientOptions
