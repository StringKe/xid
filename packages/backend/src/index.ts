// @xid-kit/backend:服务端核心 SDK(Cloudflare Workers 原生,networkless JWT 验证)。
// 对标 @clerk/backend。验签/JWKS 复用 @xid-kit/crypto,claims/Result/error 契约复用 @xid-kit/types,SDK 内不放任何密钥(只用公钥验签)。
// 见 docs/design/06-developer-experience.md 第 6 节、api-sdk-conventions / signing-keys rule。

export const PACKAGE = '@xid-kit/backend'

// 错误模型:意外/不可恢复 throw AppError;可预期失败走各模块 Result。
export type { BackendErrorCode } from './errors'
export { AppError, BACKEND_ERROR_CODES } from './errors'

// JWKS 解析与可选回源缓存(networkless 默认传 jwtKey,JwksCache 仅显式回源时用)。
export type { JwtKey, JwksCacheOptions } from './jwks'
export { toVerifyKeySet, JwksCache } from './jwks'

// verifyToken:低层 networkless access token 验证(签名/exp/nbf/iss/aud/azp)。
export type { VerifyTokenOptions, VerifyTokenError } from './verify-token'
export { verifyToken } from './verify-token'

// authenticateRequest:从 Request(Authorization header / cookie)提取并验证。
export type {
  AuthenticateRequestOptions,
  RequestState,
  SignedInState,
  SignedOutState,
} from './authenticate-request'
export { authenticateRequest } from './authenticate-request'

// verifyWebhook:svix 风格 HMAC-SHA256 webhook 签名验证(5min 防重放)。
export type { VerifyWebhookOptions, WebhookVerifyError, VerifiedWebhook } from './verify-webhook'
export { verifyWebhook } from './verify-webhook'
