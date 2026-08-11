// 意外/配置错误 throw AppError;可预期验证失败走各模块 Result。

// 与 XidErrorCode 不同域:此处面向 SDK 调用方分支,非协议端 HTTP 响应。
export const BACKEND_ERROR_CODES = [
  'missing_jwt_key',
  'jwks_fetch_failed',
  'invalid_options',
  'session_token_exchange_failed',
] as const
export type BackendErrorCode = (typeof BACKEND_ERROR_CODES)[number]

export class AppError extends Error {
  readonly code: BackendErrorCode

  constructor(code: BackendErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'AppError'
    this.code = code
  }
}
