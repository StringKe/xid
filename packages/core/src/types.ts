// @xid-kit/core 公开状态契约:浏览器登录态资源模型(对标 @clerk/clerk-js Resources)。
// 这些是 SDK 暴露给框架层(@xid-kit/react)与开发者的只读视图,不含任何密钥材料。
// opaque refresh credential 由 worker 存入 HttpOnly cookie,SDK 只读状态、
// 调 getToken() 换取 short-lived JWT。

import type { OrganizationMembershipRole, XidError } from '@xid-kit/types'

// User 公开视图(对照 06 章 SDK 核心职责:用户信息 load/cache)。
// 仅展示态字段,敏感字段(密码哈希/pepper/私钥)永不出现在前端。
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
  // guest 判定标记:匿名开通的账号由 worker 带 provisioned_by='anonymous'。
  // 可选:旧会话 / 非 guest 用户不带该字段(与 /v1/me 契约一致)。
  provisionedBy?: 'anonymous' | (string & {})
  // 开发者可读的非敏感元数据(对照 06 章 metadata PATCH)。
  publicMetadata: Readonly<Record<string, unknown>>
  // 该用户当前可用的组织成员摘要(用于 OrganizationSwitcher)。
  organizationMemberships: readonly XidOrganizationMembership[]
  createdAt: number
  updatedAt: number
}

// Organization 公开视图(对照 06 章组织组件 / 02 章组织模型)。
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

// 当前用户在某 org 的成员关系(角色 + 权限,对照 02 章 RBAC 注入 token)。
export type XidOrganizationMembership = {
  id: string
  organization: XidOrganization
  role: OrganizationMembershipRole
  permissions: readonly string[]
  createdAt: number
}

// Session 公开视图(对照 05 章会话模型、06 章 multi-session 切换)。
// status 驱动 token 刷新与 UI 状态(active 才可 getToken)。
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
  // 当前会话激活的 org(multi-session + active org 切换),无则个人上下文。
  activeOrganizationId: string | null
  lastActiveAt: number
  // 绝对过期时间(秒,epoch);到点 session 失效需重新登录。
  expireAt: number
  // 空闲过期时间(秒,epoch);取与 expireAt 先到者。
  abandonAt: number
  createdAt: number
}

// API key 公开视图(对照 06 章 useAPIKeys)。secret 明文只在 create 返回一次。
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

// guest 开通输入(POST /auth/guest);Turnstile 在 env.TURNSTILE_SECRET 配置时必传。
export type SignInAnonymouslyInput = {
  turnstileToken?: string | null
  signal?: AbortSignal
}

export type SignInResult = {
  redirectUrl?: string
  nextStep?: 'verify_email' | 'complete'
}

// SDK 顶层登录态(对照 06 章 useAuth 暴露字段)。
// status 是 SDK 生命周期,与 SessionStatus(单会话状态)区分。
export const CLIENT_STATUS = ['loading', 'ready', 'degraded', 'error'] as const
export type ClientStatus = (typeof CLIENT_STATUS)[number]

export type XidState = {
  status: ClientStatus
  // SDK 初始化是否完成(对照 <XidLoaded />)。
  isLoaded: boolean
  isSignedIn: boolean
  // 当前活跃 session(多会话中被选中的那个)。
  session: XidSession | null
  user: XidUser | null
  // 当前活跃 org(由 session.activeOrganizationId 解析)。
  organization: XidOrganization | null
  // 多会话列表(对照 06 章 useSessionList / <UserButton /> 切换)。
  sessions: readonly XidSession[]
  // 最近一次不可恢复错误(status==='error' 时非空)。
  error: XidError | null
}

// guest 创建成功时 redirectUrl 由 Core endpoint 决定,SDK 不复制 onboarding 路由。
// 为兼容旧版 Result<XidState>,结果继续展开 XidState 字段;新代码应读取 state。
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

// 状态变更监听器(框架无关;@xid-kit/react 用 useSyncExternalStore 订阅)。
export type XidStateListener = (state: XidState) => void
export type Unsubscribe = () => void

// getToken 选项(对照 06 章 getToken 返回 short-lived JWT,建议 60s)。
export type GetTokenOptions = {
  // 跳过本地缓存强制刷新(敏感操作前用)。
  skipCache?: boolean
  // 提前刷新窗口(秒):token 距过期小于此值即刷新,默认 10。
  leewaySeconds?: number
  // 传播取消信号。
  signal?: AbortSignal
}

// Management API 用户视图(/v1/users)。
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
  prompt?: 'login' | 'consent' | 'select_account'
  signal?: AbortSignal
}

export type HandleRedirectCallbackResult = {
  returnUrl: string
  intent: OidcAuthorizationIntent
}

export type SameOriginXidClientOptions = {
  mode?: 'same-origin'
  // 认证 API 根。cookie 模式只允许相对 URL 或当前页面 exact same-origin。
  apiUrl?: string
  // Management API Secret Key(sk_live_/sk_test_);设置后走 Bearer 而非 cookie session。
  secretKey?: string
  // 注入 fetch(测试用);默认 globalThis.fetch。
  fetcher?: typeof fetch
  // 注入时钟(测试用,返回秒);默认 Date.now()/1000。
  now?: () => number
}

export type OidcXidClientOptions = {
  mode: 'oidc'
  // OIDC issuer,例如 https://tenant.xid.dev。
  issuer: string
  // Console 注册的 public OAuth client_id。它不是 Management API key。
  clientId: string
  // 必须与 application.redirect_uris 中一项精确相等。
  redirectUri: string
  // 默认 openid profile email。浏览器基线禁止 offline_access。
  scopes?: readonly string[]
  // 可选 OIDC RP-initiated logout 回跳,必须预先注册。
  postLogoutRedirectUri?: string
  // 默认使用当前 tab 的 sessionStorage;可注入自定义异步存储。
  tokenCache?: XidTokenCache
  fetcher?: typeof fetch
  now?: () => number
}

// XidClient 构造选项。跨域应用必须显式使用 oidc;省略 mode 仅代表 same-origin Core。
export type XidClientOptions = SameOriginXidClientOptions | OidcXidClientOptions
