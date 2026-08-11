// 服务端 SDK:networkless 公钥验签,包内不持有私钥。

export const PACKAGE = '@xid-kit/backend'

export type { BackendErrorCode } from './errors'
export { AppError, BACKEND_ERROR_CODES } from './errors'

export type { JwtKey, JwksCacheOptions } from './jwks'
export { toVerifyKeySet, JwksCache } from './jwks'

export type { VerifyTokenOptions, VerifyTokenError } from './verify-token'
export { verifyToken } from './verify-token'

export type {
  AuthenticateRequestOptions,
  RequestState,
  SignedInState,
  SignedOutState,
} from './authenticate-request'
export { authenticateRequest } from './authenticate-request'
export type {
  SessionTokenExchangeError,
  SessionTokenExchangeOptions,
} from './session-token-exchange'
export { exchangeSessionToken, hasCoreSessionCookie } from './session-token-exchange'

export type { VerifiedWebhook, VerifyWebhookOptions, WebhookVerifyError } from './verify-webhook'
export { verifyWebhook } from './verify-webhook'
