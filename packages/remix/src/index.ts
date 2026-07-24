// @xid-kit/remix: Remix SDK -- client-side entry.
// This file exports ONLY client-safe APIs.
// Server-only APIs (getAuth / requireAuth / xidClient / verifyToken / verifyWebhook)
// are in the ./server subpath export to prevent them from entering client bundles.
//
// Usage:
//   // In route components (client):
//   import { useAuth, SignInButton } from '@xid-kit/remix'
//
//   // In loader/action (server-only):
//   import { getAuth, requireAuth } from '@xid-kit/remix/server'

// --- Re-export @xid-kit/react client components and hooks ---
export * from '@xid-kit/react'

// --- Re-export @xid-kit/core public API ---
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

// --- Remix session storage helpers (shared between client + server) ---
export {
  createXidSessionStorage,
  getTokenFromSession,
  getRefreshTokenFromSession,
  setTokensInSession,
  clearTokensFromSession,
} from './session'

// --- Shared types ---
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
