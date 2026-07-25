// OIDC/OAuth 核心端点注册桶。wire 阶段在 worker/index.ts 统一调 registerOidcRoutes 挂载。
// 各端点 export 注册函数(不直接改 worker/index.ts);中间件(tenant/i18n/session)由 wire 层先挂。

import type { Hono } from 'hono'
import type { XidHonoEnv } from '../lib/types'
import { registerAuthorizeRoutes } from './authorize'
import { registerDiscoveryRoutes } from './discovery'
import { registerCibaRoutes } from './ciba'
import { registerCheckSessionRoutes } from './check-session'
import { registerEndSessionRoutes } from './end-session'
import { registerFederationRoutes } from './federation'
import { registerOptionalProtocolRoutes } from './optional-protocols'
import { registerSsfRoutes } from './ssf'
import { registerJwksRoutes } from './jwks'
import { registerParRoutes } from './par'
import { registerProtectedResourceRoutes } from './protected-resource'
import { registerTokenRoutes } from './token'
import { registerUserinfoRoutes } from './userinfo'

// 统一注册全部 OIDC/OAuth 端点(discovery/jwks/authorize/par/token/userinfo/end_session)。
export function registerOidcRoutes(app: Hono<XidHonoEnv>): void {
  registerDiscoveryRoutes(app)
  registerProtectedResourceRoutes(app)
  registerJwksRoutes(app)
  registerAuthorizeRoutes(app)
  registerParRoutes(app)
  registerTokenRoutes(app)
  registerUserinfoRoutes(app)
  registerEndSessionRoutes(app)
  registerCheckSessionRoutes(app)
  registerCibaRoutes(app)
  registerFederationRoutes(app)
  registerSsfRoutes(app)
  registerOptionalProtocolRoutes(app)
}

export { registerDiscoveryRoutes } from './discovery'
export { registerProtectedResourceRoutes } from './protected-resource'
export { registerJwksRoutes } from './jwks'
export { registerAuthorizeRoutes } from './authorize'
export { registerParRoutes } from './par'
export { registerTokenRoutes } from './token'
export { registerUserinfoRoutes } from './userinfo'
export { registerEndSessionRoutes } from './end-session'
