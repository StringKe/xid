// 框架接线层；协议逻辑委托 @xid-kit/core 与 @xid-kit/backend。

export { createXidStores } from './stores'
export type {
  XidStores,
  Readable,
  Writable,
  AuthState,
  UserState,
  OrganizationState,
  SessionState,
  GetTokenFn,
  SignOutFn,
} from './stores'

export { setXidContext, getXidContext, XID_CONTEXT_KEY } from './context'

export { isAllowed } from './protect-logic'
export type { ProtectOptions } from './protect-logic'

export { buildSignInUrl, executeSignOut } from './sign-in-logic'

export type { AuthResult, AuthObject, UnauthenticatedAuthObject } from './types'
export { XID_AUTH_HEADER } from './types'

export {
  XidClient,
  XidStore,
  TokenManager,
  XidApiClient,
  XidNetworkError,
  makeXidError,
  isXidErrorShape,
  decodeTokenClaims,
  isTokenExpiring,
  SESSION_STATUS,
  CLIENT_STATUS,
  PACKAGE,
} from '@xid-kit/core'

export type {
  TokenResponse,
  ClientStateResponse,
  DecodedTokenClaims,
  XidUser,
  XidOrganization,
  XidOrganizationMembership,
  XidSession,
  XidApiKey,
  XidApiKeyWithSecret,
  XidPage,
  CreateApiKeyInput,
  SignInPasswordInput,
  SignInResult,
  SessionStatus,
  ClientStatus,
  XidState,
  XidStateListener,
  Unsubscribe,
  GetTokenOptions,
  XidClientOptions,
} from '@xid-kit/core'

export type { OrganizationMembershipRole } from '@xid-kit/types'
