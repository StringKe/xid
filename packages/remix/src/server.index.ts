// @xid-kit/remix: server-only entry (subpath export: @xid-kit/remix/server).
// Contains APIs that must ONLY run server-side: JWT verification, secret key auth,
// session helpers, and the OAuth callback handler.
// Do NOT import this file in client components or Remix client-bundle code.

// --- Remix server helpers ---
export { getAuth, requireAuth, xidClient, UNAUTHENTICATED } from './server'
export type { GetAuthOptions } from './server'

// --- createXidClient compat helper ---
export { createXidClient } from './helpers'

// --- Session storage ---
export {
  createXidSessionStorage,
  getTokenFromSession,
  getRefreshTokenFromSession,
  setTokensInSession,
  clearTokensFromSession,
} from './session'

// --- OAuth callback ---
export { handleCallback } from './callback'
export type { HandleCallbackOptions, HandleCallbackResult } from './callback'

// --- @xid-kit/backend server APIs ---
export {
  verifyToken,
  verifyWebhook,
  authenticateRequest,
  JwksCache,
  toVerifyKeySet,
  AppError,
  BACKEND_ERROR_CODES,
} from '@xid-kit/backend'

export type {
  VerifyTokenOptions,
  VerifyTokenError,
  AuthenticateRequestOptions,
  RequestState,
  SignedInState,
  SignedOutState,
  VerifyWebhookOptions,
  WebhookVerifyError,
  VerifiedWebhook,
  JwtKey,
  JwksCacheOptions,
  BackendErrorCode,
} from '@xid-kit/backend'

// --- Types ---
export type {
  AuthObject,
  UnauthenticatedAuthObject,
  AuthResult,
  XidSession,
  XidSessionStorage,
  XidSessionStorageOptions,
  XidServerClientOptions,
  PaginationParams,
  PaginatedResponse,
} from './types'
export {
  XID_SESSION_ACCESS_TOKEN_KEY,
  XID_SESSION_REFRESH_TOKEN_KEY,
  XID_SESSION_RETURN_TO_KEY,
} from './types'
