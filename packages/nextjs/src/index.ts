// @xid-kit/nextjs：Next.js SDK（对标 @clerk/nextjs）。分层见 docs/design/06-developer-experience.md。

export { xidMiddleware } from './middleware'
export type { XidMiddlewareOptions } from './middleware'

export { auth, getAuth, currentUser, xidClient } from './server'
export type { XidServerClientOptions } from './types'

export type {
  AuthObject,
  UnauthenticatedAuthObject,
  AuthResult,
  PaginationParams,
  PaginatedResponse,
} from './types'
export { XID_AUTH_HEADER } from './types'

export * from '@xid-kit/react'

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
