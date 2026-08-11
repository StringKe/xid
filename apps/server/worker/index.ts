import { Hono } from 'hono'
import type {
  EmailQueueMessage,
  WhatsappQueueMessage,
  SmsQueueMessage,
  AuditQueueMessage,
  WebhookQueueMessage,
  MeteringQueueEnvelope,
  PrivacyQueueMessage,
  ScimSyncQueueMessage,
} from '@xid-kit/types'
import type { XidHonoEnv } from './lib/types'
import { errorHandler, i18nMiddleware, sessionMiddleware, tenantMiddleware } from './middleware'
import { registerBootstrapRoute } from './admin'
import { registerAllRoutes } from './routes'
import { registerFrontendRouteDelegation, registerPublicAssetRoutes } from './public-assets'
import { dispatchQueue } from './queues'
import { dispatchScheduled } from './crons'
import { registerUnmatchedProtocolBlocker } from './lib/unmatched-protocol'
import { TENANT_ROUTE_PATTERNS } from './tenant-routes'
import { registerCanonicalHostRedirect, registerPublicMetadataRoutes } from './public-metadata'
import { registerPublicStatusRoutes } from './public-status'
import { registerStripeWebhookRoutes } from './billing/stripe-webhook'

// i18n 全局;tenant/session 仅协议/认证前缀;公共路径不解析 tenant。
export function createApp(): Hono<XidHonoEnv> {
  const app = new Hono<XidHonoEnv>()

  app.onError(errorHandler)
  // 含 bootstrap/public error 在内,渲染前须有请求私有 i18n 实例。
  app.use('*', i18nMiddleware)

  // www 属 Site,防御 308 防回落 tenant;须先于 TenantContext。
  registerCanonicalHostRedirect(app)

  // LLM 发现入口无 tenant;其余 well-known 仍走协议路由。
  registerPublicMetadataRoutes(app)

  // 健康检查任意 Host 可达,不经 tenant。
  app.get('/v1/health', (c) => c.json({ ok: true }))
  // 公开状态不依赖 TenantContext,Core 故障时 Nimbus `/status` 仍可出 shell。
  registerPublicStatusRoutes(app)
  // Stripe webhook 只验 body HMAC;须先于 /v1 tenant 中间件,否则 Host 解析短路。
  registerStripeWebhookRoutes(app)

  // bootstrap 在 tenant 之前(空 D1 时解析必 404);幂等门控。
  registerBootstrapRoute(app)

  // CF exact Route 含完整 URL 不含 query 变体;契约归属前端的请求先于协议中间件委托。
  registerFrontendRouteDelegation(app)

  // 仅真实协议前缀挂 tenant/session,避免 SPA 被 tenant 解析短路。
  for (const pattern of TENANT_ROUTE_PATTERNS) {
    app.use(pattern, tenantMiddleware)
    app.use(pattern, sessionMiddleware)
  }
  // smoke harness 要 TenantContext 隔离数据,不参与用户会话恢复。
  app.use('/test/*', tenantMiddleware)
  app.use('/test-harness/*', tenantMiddleware)
  registerAllRoutes(app)

  // 未命中协议/API 前缀必须 404,禁止落到 SPA。
  registerUnmatchedProtocolBlocker(app)

  registerPublicAssetRoutes(app)

  return app
}

const app = createApp()

// wrangler 要求 DO class 从 main 模块 re-export。
export {
  SessionDO,
  ChallengeStore,
  OAuthFlowDO,
  ParStore,
  DeviceFlowStore,
  RateLimitStore,
  AuditSeqDO,
  MeteringDO,
  GuestStore,
  CibaStore,
  ImpersonationGrantDO,
} from './durable-objects'

// 异步不阻塞主链路;audit max_concurrency=1 保链式 hash 顺序。
export default {
  fetch: app.fetch,

  async queue(
    batch: MessageBatch<
      | EmailQueueMessage
      | WhatsappQueueMessage
      | SmsQueueMessage
      | AuditQueueMessage
      | WebhookQueueMessage
      | MeteringQueueEnvelope
      | ScimSyncQueueMessage
      | PrivacyQueueMessage
    >,
    env: Env,
  ): Promise<void> {
    await dispatchQueue(batch, env)
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(dispatchScheduled(event.cron, env))
  },
}
