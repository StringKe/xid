// 服务端子路径入口（@xid-kit/remix/server）：JWT 验签、sk_ 认证、session 与 OAuth callback；禁止在 client 组件中导入。

export { getAuth, requireAuth, xidClient, UNAUTHENTICATED } from './server'
export type { GetAuthOptions } from './server'

export { createXidClient } from './helpers'

export {
  createXidSessionStorage,
  getTokenFromSession,
  getRefreshTokenFromSession,
  setTokensInSession,
  clearTokensFromSession,
} from './session'

export { handleCallback } from './callback'
export type { HandleCallbackOptions, HandleCallbackResult } from './callback'

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
