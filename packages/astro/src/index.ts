// @xid-kit/astro:Astro integration + middleware + island client helper。
// 职责:
//   - xidIntegration():Astro integration 工厂,注入 middleware 到 astro.config
//   - createXidMiddleware():Astro onRequest middleware,认证后写 locals.xidAuth
//   - getClient() / initClient():浏览器 island 单例 XidClient
//   - getAuth(locals):SSR .astro 页面同步读取 locals.xidAuth
//   - currentUser(locals, options):懒加载完整 XidUser
//   - xidClient(options):server 端 Management API client
// 见 docs/sdks/platform-matrix.md Astro 行。

// Integration
export { xidIntegration } from './integration'

// Middleware
export { createXidMiddleware } from './middleware'
export type { AstroMiddlewareHandler } from './middleware'

// Client island helper
export { getClient, initClient, resetClient } from './client'

// Server SSR helpers
export { getAuth, currentUser, xidClient } from './server'

// Types
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

// Re-export @xid-kit/core public surface for island components.
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
