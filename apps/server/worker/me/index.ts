// account portal(self-service)路由注册汇总:/v1/me + /v1/me/* 系列。
// 由 wire 阶段(routes.ts)调用,本任务不直接改 worker/routes.ts 或 index.ts。
// 认证:全部 cookie session(readSession),不是 sk_live Bearer(那是 Management API /v1/users 等)。
// 子端点(passkey/mfa-factor/social/trusted-device 的 PATCH/DELETE :id)为同域后续扩展,本批覆盖列表读 + 改密 + 会话撤销。

import type { Hono } from 'hono'
import type { XidHonoEnv } from '../lib/types'
import { registerMeRoute } from './me'
import { registerProfileRoutes } from './profile'
import { registerPasskeysRoutes } from './passkeys'
import { registerMfaFactorsRoutes } from './mfa-factors'
import { registerSocialConnectionsRoutes } from './social-connections'
import { registerTrustedDevicesRoutes } from './trusted-devices'
import { registerMeSessionsRoutes } from './sessions'
import { registerPasswordRoutes } from './password'

export function registerAccountRoutes(app: Hono<XidHonoEnv>): void {
  // 先挂更具体的 /v1/me/* 前缀,再挂 /v1/me(GET /),避免聚合端点遮挡子资源路径。
  registerProfileRoutes(app)
  registerPasskeysRoutes(app)
  registerMfaFactorsRoutes(app)
  registerSocialConnectionsRoutes(app)
  registerTrustedDevicesRoutes(app)
  registerMeSessionsRoutes(app)
  registerPasswordRoutes(app)
  registerMeRoute(app)
}
