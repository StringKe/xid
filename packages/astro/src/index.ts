// @xid-kit/astro 公共导出;平台能力见 docs/sdks/platform-matrix.md Astro 行。

export { xidIntegration } from './integration'

export { createXidMiddleware } from './middleware'
export type { AstroMiddlewareHandler } from './middleware'

export { getClient, initClient, resetClient } from './client'

export { getAuth, currentUser, xidClient } from './server'

export type {
  AuthObject,
  UnauthenticatedAuthObject,
  AuthResult,
  XidMiddlewareOptions,
  XidIntegrationOptions,
  XidIntegrationBrowserOptions,
  SerializableJwtKey,
  XidIntegrationSessionTokenExchangeOptions,
  XidServerClientOptions,
  PaginatedResponse,
} from './types'

export { XID_AUTH_LOCALS_KEY } from './types'

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
