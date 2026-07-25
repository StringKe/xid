// @xid-kit/nextjs:Next.js SDK,对标 @clerk/nextjs。
// 见 docs/design/06-developer-experience.md SDK 分层、api-sdk-conventions rule。

// --- 中间件(Edge Runtime)---
export { xidMiddleware } from './middleware'
export type { XidMiddlewareOptions } from './middleware'

// --- Server context(App Router + Pages Router)---
export { auth, getAuth, currentUser, xidClient } from './server'
export type { XidServerClientOptions } from './types'

// --- 内部类型(供高级用法)---
export type {
  AuthObject,
  UnauthenticatedAuthObject,
  AuthResult,
  PaginationParams,
  PaginatedResponse,
} from './types'
export { XID_AUTH_HEADER } from './types'

// --- re-export @xid-kit/react 客户端组件与 hooks(Next.js client 组件用)---
export * from '@xid-kit/react'

// --- re-export @xid-kit/backend 供 server 端高级用法(verifyToken / verifyWebhook / JwksCache)---
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
