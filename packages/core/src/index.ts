// 浏览器登录态核心:只读状态与 short-lived JWT,不持密钥。

export const PACKAGE = '@xid-kit/core'

export { XidClient } from './client'
export { BrowserOidcError } from './browser-oidc'
export { executeBrowserSamlLogout } from './saml-logout'
export type { BrowserSamlLogoutAction, SignOutResponse } from './saml-logout'

export { XidStore } from './store'

export { TokenManager } from './token-manager'

export { XidApiClient } from './api-client'
export type { TokenResponse, ClientStateResponse } from './api-client'

export { XidNetworkError, makeXidError, isXidErrorShape } from './errors'

export { decodeTokenClaims, isTokenExpiring } from './jwt-decode'
export type { DecodedTokenClaims } from './jwt-decode'

export { isGuestUser, isGuestToken, isSameUser } from './guest'

export {
  b64urlToBytes,
  bytesToB64url,
  createPasskeyCredential,
  registrationOptionsToPublicKey,
} from './webauthn'
export type { PasskeyRegistrationOptions, PasskeyRegistrationVerifyBody } from './webauthn'

export { trimTrailingSlashes } from './url'

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
  UpgradeGuestWithPasskeyInput,
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
  SignInSilentInput,
  SilentAuthorizationError,
  SilentRedirectCallbackResult,
  XidTokenCache,
  XidClientOptions,
} from './types'
export { SESSION_STATUS, CLIENT_STATUS, SILENT_AUTHORIZATION_ERRORS } from './types'

// 固定 org membership role;Project 自定义角色不走此类型。
export type { OrganizationMembershipRole } from '@xid-kit/types'
