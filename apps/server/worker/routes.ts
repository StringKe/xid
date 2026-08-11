// 协议与人机认证路由装配真相源;独立于 index.ts 以便 node 测试不拉 lingui macro。
// 中间件由调用方先挂;/par 只从 OIDC 侧挂。

import type { Hono } from 'hono'
import type { XidHonoEnv } from './lib/types'
import { registerOidcRoutes } from './oidc'
import { registerDevice, registerDcr, registerIntrospect, registerRevoke } from './oauth'
import { registerPasskeyRoutes, registerHostedAuthConfigRoutes, registerSocialRoutes } from './auth'
import { registerScimRoutes } from './scim'
import {
  registerSamlRoutes,
  registerOidcRpRoutes,
  registerHrdRoutes,
  registerOutboundSamlRoutes,
  registerLdapRoutes,
  registerWsfedRoutes,
  registerSwaRoutes,
  registerDirectoryConnectorRoutes,
} from './sso'
import { registerV1Routes } from './v1'
import { registerSessionAuthRoutes } from './me-auth'
import { registerAccountRoutes } from './me'
import { registerPlatformConsoleRoutes } from './platform'
import { registerTestHarnessRoutes } from './test-harness'
import { registerStorageRoutes } from './storage'
import { registerImpersonationRoutes } from './impersonation'
import { registerActiveAnnouncementRoutes } from './platform/announcements'
import { registerComplianceRoutes } from './compliance'

export function registerAllRoutes(app: Hono<XidHonoEnv>): void {
  // 模拟登录全局只读边界须先于任何读 cookie session 的协议/API。
  registerImpersonationRoutes(app)
  registerOidcRoutes(app)
  registerIntrospect(app)
  registerRevoke(app)
  registerDevice(app)
  registerDcr(app)
  registerSessionAuthRoutes(app)
  registerHostedAuthConfigRoutes(app)
  registerPasskeyRoutes(app)
  registerSocialRoutes(app)
  registerScimRoutes(app)
  registerSamlRoutes(app)
  registerOutboundSamlRoutes(app)
  registerOidcRpRoutes(app)
  registerHrdRoutes(app)
  registerLdapRoutes(app)
  registerWsfedRoutes(app)
  registerSwaRoutes(app)
  registerDirectoryConnectorRoutes(app)
  registerV1Routes(app)
  registerStorageRoutes(app)
  registerAccountRoutes(app)
  registerActiveAnnouncementRoutes(app)
  registerComplianceRoutes(app)
  registerPlatformConsoleRoutes(app)
  // 仅 development/test 的 L3 harness。
  registerTestHarnessRoutes(app)
}
