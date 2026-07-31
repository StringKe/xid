// @xid-kit/core:浏览器登录态核心(对标 @clerk/clerk-js)。
// 登录态 load/cache、multi-session 切换、active org 切换、getToken(short-lived JWT)、sign-out;
// 框架无关响应式 store 供 @xid-kit/react 的 useAuth/useUser/useOrganization/useSession 绑定。
// 见 docs/design/06-developer-experience.md SDK 分层、api-sdk-conventions rule。不持任何密钥(crypto-boundary rule)。

export const PACKAGE = '@xid-kit/core'

// 顶层客户端
export { XidClient } from './client'
export { BrowserOidcError } from './browser-oidc'
export { executeBrowserSamlLogout } from './saml-logout'
export type { BrowserSamlLogoutAction, SignOutResponse } from './saml-logout'

// 框架无关 store(框架层绑定用)
export { XidStore } from './store'

// token 刷新管理(高级用法 / 测试)
export { TokenManager } from './token-manager'

// 认证 API 客户端
export { XidApiClient } from './api-client'
export type { TokenResponse, ClientStateResponse } from './api-client'

// 错误模型
export { XidNetworkError, makeXidError, isXidErrorShape } from './errors'

// JWT 解码(仅 exp 调度,不验签)
export { decodeTokenClaims, isTokenExpiring } from './jwt-decode'
export type { DecodedTokenClaims } from './jwt-decode'

// guest 模式判定与 sub 对比
export { isGuestUser, isGuestToken, isSameUser } from './guest'

export { trimTrailingSlashes } from './url'

// 公开状态契约
export type {
  XidUser,
  XidOrganization,
  XidOrganizationMembership,
  XidSession,
  XidApiKey,
  XidApiKeyWithSecret,
  XidPage,
  CreateApiKeyInput,
  ListSessionsInput,
  ListUsersInput,
  ManagementSession,
  ManagementUser,
  SignInPasswordInput,
  SignInAnonymouslyInput,
  SignInAnonymouslyResult,
  SignInResult,
  SessionStatus,
  ClientStatus,
  XidState,
  XidStateListener,
  Unsubscribe,
  GetTokenOptions,
  CreateAuthorizationUrlInput,
  HandleRedirectCallbackResult,
  OidcAuthorizationIntent,
  OidcXidClientOptions,
  SameOriginXidClientOptions,
  XidTokenCache,
  XidClientOptions,
} from './types'
export { SESSION_STATUS, CLIENT_STATUS } from './types'

// 固定 Organization membership role contract。Project 自定义角色不使用此类型。
export type { OrganizationMembershipRole } from '@xid-kit/types'
