// worker 共享辅助桶导出。供 auth/oidc/admin 等后续路由模块复用。

export type { SessionData, TenantVar, SessionVar, XidVars, XidHonoEnv } from './types'

export type { WorkerLocale } from './locale'
export { SUPPORTED_LOCALES, resolveLocale, isSupportedLocale } from './locale'

export {
  rtCookieName,
  setRefreshTokenCookie,
  clearRefreshTokenCookie,
  readRefreshTokenCookie,
  readAllRefreshTokenCookies,
} from './cookies'

export type { IssueSessionInput, IssuedSession } from './session'
export { issueSession, readSession, readSessionById, revokeSession } from './session'

export type { AppErrorOptions } from './errors'
export { AppError, isAppError, httpStatusForCode } from './errors'
