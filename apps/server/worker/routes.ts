// 路由注册真相源:把全部协议端 + 人机认证路由挂到传入的 Hono app。
// 独立于 index.ts(不引 i18n/error 中间件),便于 node 测试池直接 import 而不触发 lingui macro 运行时依赖。
// 中间件(i18n/tenant/session)由调用方先挂(见 index.ts createApp)。
// /par 只从 OIDC 侧挂(oidc/par.ts 是 resolvePar 真相源)。

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
  // Impersonation 先挂全局只读边界，再挂任何可能读取 cookie session 的协议/API 路由。
  // 具体 start/handoff/end 端点也由同一模块注册。
  registerImpersonationRoutes(app)
  // OIDC/OAuth 核心:discovery/jwks/authorize/par/token/userinfo/end_session。
  registerOidcRoutes(app)
  // OAuth 扩展:introspect/revoke/device_authorization/register(DCR)。
  registerIntrospect(app)
  registerRevoke(app)
  registerDevice(app)
  registerDcr(app)
  // session-auth(me-auth):Hosted UI cookie-session 认证端点(password/passkey/reset/
  // verify-email/passwordless/mfa/consent + /v1/sessions/token)。
  // Magic Link send 和 OTP send/verify 只保留当前 Hosted UI 使用的正式拆分端点。
  registerSessionAuthRoutes(app)
  // 人机认证:passkey/social(各自挂 /auth/* 子路径);magic-link verify 由 me-auth 之外的 auth 模块提供。
  registerHostedAuthConfigRoutes(app)
  registerPasskeyRoutes(app)
  registerSocialRoutes(app)
  // SCIM 2.0 Directory Sync(/scim/v2/organizations/{organization_id}/Users+Groups,见 04 章 9)。
  registerScimRoutes(app)
  // 企业 SSO:SAML 2.0 SP(/sso/saml/{connection}/acs+metadata+login,见 04 章 1、3、8)。
  registerSamlRoutes(app)
  // 下游 SaaS SSO:SAML 2.0 IdP(/sso/outbound/saml/{app}/metadata+sso)。
  registerOutboundSamlRoutes(app)
  // 企业 SSO:OIDC RP(/sso/oidc/{connection}/authorize+callback,上游 IdP 联邦,见 04 章 1)。
  registerOidcRpRoutes(app)
  // 企业 SSO:HRD home realm discovery(POST /sso/hrd,按邮箱域路由到 connection,见 04 章 8)。
  registerHrdRoutes(app)
  // 企业 legacy SSO:LDAP direct bind / WS-Federation / SWA / header-based / directory connectors。
  registerLdapRoutes(app)
  registerWsfedRoutes(app)
  registerSwaRoutes(app)
  registerDirectoryConnectorRoutes(app)
  // Management API v1:applications/connections/directories/roles/permissions/webhooks/api-keys。
  registerV1Routes(app)
  // 公开 R2 logo 读取:/storage/logos/*(不过 tenant 中间件,见 storage.ts)。
  registerStorageRoutes(app)
  // account portal(self-service):/v1/me + /v1/me/*(cookie session 认证,非 sk_live)。
  // 路径前缀 /v1/me 与 v1 的 /v1/users、/v1/sessions 不重叠;passkeys 子路径走 passkey verify 逻辑无冲突。
  registerAccountRoutes(app)
  // 当前 tenant/plan 生效公告与 org compliance center 都复用 request TenantContext。
  registerActiveAnnouncementRoutes(app)
  registerComplianceRoutes(app)
  // platform-console:/v1/platform/*(cookie session + instance_manager 门控),与 v1 路径不重叠。
  registerPlatformConsoleRoutes(app)
  // Local L3 harness:fake IdP, fake Social OAuth, test OTP capture (development/test only)。
  registerTestHarnessRoutes(app)
}
