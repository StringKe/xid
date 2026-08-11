// 客户端入口：仅导出 client-safe API。getAuth / requireAuth / xidClient 等须从 @xid-kit/remix/server 引入，避免进入 client bundle。

export * from '@xid-kit/react'

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
  PACKAGE as CORE_PACKAGE,
} from '@xid-kit/core'

export type {
  TokenResponse,
  ClientStateResponse,
  DecodedTokenClaims,
  XidUser,
  XidOrganization,
  XidOrganizationMembership,
  XidSession as XidSessionState,
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

export {
  createXidSessionStorage,
  getTokenFromSession,
  getRefreshTokenFromSession,
  setTokensInSession,
  clearTokensFromSession,
} from './session'

export type {
  AuthObject,
  UnauthenticatedAuthObject,
  AuthResult,
  XidSession,
  XidSessionStorage,
  XidSessionStorageOptions,
  PaginationParams,
  PaginatedResponse,
} from './types'
export {
  XID_SESSION_ACCESS_TOKEN_KEY,
  XID_SESSION_REFRESH_TOKEN_KEY,
  XID_SESSION_RETURN_TO_KEY,
} from './types'
