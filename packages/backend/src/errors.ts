// @xid-kit/backend 错误模型(见 error-handling rule)。
// 策略:意外/不可恢复(配置缺失、JWKS 拉取失败、私钥误传)throw typed AppError;
// 可预期失败(token 无效、未认证、webhook 签名不匹配)走 Result 判别联合,调用方显式处理。

// 后端 SDK 错误码(networkless 验证场景,与 @xid-kit/types XidErrorCode 不同域:
// types 的 code 面向协议端 HTTP 响应,这里面向 SDK 调用方的程序化分支)。
export const BACKEND_ERROR_CODES = [
  'missing_jwt_key',
  'jwks_fetch_failed',
  'invalid_options',
  'session_token_exchange_failed',
] as const
export type BackendErrorCode = (typeof BACKEND_ERROR_CODES)[number]

// 意外/不可恢复错误:SDK 误用或外部依赖故障,调用方无从恢复 -> throw。
// 保留 cause 链(见 error-handling rule),不丢原始错误。
export class AppError extends Error {
  readonly code: BackendErrorCode

  constructor(code: BackendErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'AppError'
    this.code = code
  }
}
