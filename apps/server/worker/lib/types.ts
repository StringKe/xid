// worker 共享类型:Hono Variables 契约(c.set/c.get 的键)与 session 视图。
// 后续 auth/oidc/admin 路由模块复用此处 SessionData / XidVars,统一 c.get('tenant') / c.get('session') 取值。
// 铁律:tenant/session 一律从 c.get 取(中间件注入),不在业务代码重新解析(见 tenant-context rule)。

import type { TenantContext } from '@xid-kit/types'
import type { AmrValue } from '@xid-kit/types'
import type { I18n } from '@lingui/core'
import type { WorkerLocale } from './locale'

// 已认证 session 的运行时视图(来自 D1 sessions 行 + DO active 校验,见 05 章 8)。
// 不含 refresh token 明文/哈希:cookie 持 opaque token,此处只暴露身份与上下文。
export type SessionData = {
  sessionId: string
  userId: string
  status: 'active' | 'pending_mfa' | 'pending_mfa_setup'
  activeOrgId: string | null
  // timestamp_ms 列映射 Date(见 packages/db schema/common.ts tsMs)。
  authenticatedAt: Date
  // 滑动 idle 判定基准(readSession 读取时按节流窗口续期,见 lib/session touchSessionLastActive)。
  lastActiveAt: Date
  expiresAt: Date
  rememberMe: boolean
  isImpersonation: boolean
  impersonatorUserId: string | null
  acr: string | null
  amr: readonly AmrValue[] | null
  aal: number | null
}

export type ResolvedSessionCandidate = {
  refreshTokenHash: string
  session: SessionData
}

// Hono Variables 契约:中间件注入,路由读取。
export type XidVars = {
  // tenant 中间件注入:issuer/签名密钥/rpId/策略唯一来源(见 tenant-context rule)。
  tenant: TenantContext
  // i18n 中间件注入:本请求激活的 locale(各 isolate 独立激活)。
  locale: WorkerLocale
  // i18n 中间件注入:请求私有实例，禁止读取/写入 isolate 级当前 locale。
  i18n: I18n
  // session 中间件注入:可选,未登录为 null。
  session: SessionData | null
  // 根域 tenant 解析命中的 session,供 session 中间件复用，避免重复读取 D1。
  sessionCandidate?: ResolvedSessionCandidate
}

// 单独导出便于路由模块按需引用。
export type TenantVar = XidVars['tenant']
export type SessionVar = XidVars['session']

// 典型 Hono 泛型:Bindings=Env,Variables=XidVars。路由模块用此装配 sub-app。
export type XidHonoEnv = {
  Bindings: Env
  Variables: XidVars
}
