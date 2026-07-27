import { Hono } from 'hono'
import type {
  EmailQueueMessage,
  WhatsappQueueMessage,
  SmsQueueMessage,
  AuditQueueMessage,
  WebhookQueueMessage,
  MeteringQueueMessage,
} from '@xid-kit/types'
import type { XidHonoEnv } from './lib/types'
import { errorHandler, i18nMiddleware, sessionMiddleware, tenantMiddleware } from './middleware'
import { registerBootstrapRoute } from './admin'
import { registerAllRoutes } from './routes'
import { registerPublicAssetRoutes } from './public-assets'
import { dispatchQueue } from './queues'
import { dispatchScheduled } from './crons'
import { registerUnmatchedProtocolBlocker } from './lib/unmatched-protocol'
import { TENANT_ROUTE_PATTERNS } from './tenant-routes'
import { registerCanonicalHostRedirect, registerPublicMetadataRoutes } from './public-metadata'

// 装配整个 Worker 的 Hono app:协议/认证 sub-app(带 tenant/i18n/session 中间件)+ health + SPA 回落。
// i18n 对所有路径生效；tenant/session 只作用于协议/认证路由，公共路径不解析 tenant。
export function createApp(): Hono<XidHonoEnv> {
  const app = new Hono<XidHonoEnv>()

  // 统一错误映射:AppError/XidError -> XidAPIError JSON(见 error-handling rule)。
  app.onError(errorHandler)
  // 所有响应（含 bootstrap/public error）在渲染前都拥有请求私有 i18n 实例。
  app.use('*', i18nMiddleware)

  // www 由 Site 持有，此处保留 route 迁移或回滚期间的防御性 308。
  // 必须先于 TenantContext，www 永远不是 tenant。
  registerCanonicalHostRedirect(app)

  // LLM 发现入口不需要 TenantContext，其他 well-known metadata 仍走协议路由。
  registerPublicMetadataRoutes(app)

  // 健康检查:不经 tenant 解析(平台探活/任意 Host 可达)。
  app.get('/v1/health', (c) => c.json({ ok: true }))

  // Seed/bootstrap:平台初始化(空 D1 -> 第一个租户可用,铁律 8)。
  // 必须在 tenant 中间件之前(此刻无 instance,tenant 解析必 404);自带 instance-existence 幂等门控。
  registerBootstrapRoute(app)

  // 协议/认证/API:只对真实协议前缀挂 tenant/session，避免 SPA 路由被 tenant 解析短路。
  for (const pattern of TENANT_ROUTE_PATTERNS) {
    app.use(pattern, tenantMiddleware)
    app.use(pattern, sessionMiddleware)
  }
  // 本地 smoke harness 依赖 TenantContext 生成隔离数据，但不参与用户会话恢复。
  app.use('/test/*', tenantMiddleware)
  app.use('/test-harness/*', tenantMiddleware)
  registerAllRoutes(app)

  // 未命中的协议/API 前缀必须 404,不能落到 SPA fallback。
  registerUnmatchedProtocolBlocker(app)

  // SPA 回落:公开技术文档只允许白名单路径;其他非协议/认证路径交给静态资源。
  registerPublicAssetRoutes(app)

  return app
}

const app = createApp()

// Durable Objects:wrangler 要求 DO class 从 main 模块 re-export。
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
} from './durable-objects'

// Queue handler:处理六条异步队列(邮件/WhatsApp/短信/审计/webhook/计量)。
// 见 cloudflare-bindings rule:异步不阻塞主链路;audit max_concurrency=1 保证链式 hash 顺序。
export default {
  fetch: app.fetch,

  async queue(
    batch: MessageBatch<
      | EmailQueueMessage
      | WhatsappQueueMessage
      | SmsQueueMessage
      | AuditQueueMessage
      | WebhookQueueMessage
      | MeteringQueueMessage
    >,
    env: Env,
  ): Promise<void> {
    // 按 batch.queue 名分发到对应 consumer(email/whatsapp/sms/audit/webhook/metering)。
    await dispatchQueue(batch, env)
  },

  // Scheduled handler:Cron Triggers(清理 / 密钥轮换 / 证书轮询 / DAU 聚合 / 域名验证)。
  // 见 cloudflare-bindings rule Cron Triggers 行。
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // 按 event.cron 分发(0 * * * * 每小时 / 0 2 * * * 每天);fire-and-forget 用 waitUntil。
    ctx.waitUntil(dispatchScheduled(event.cron, env))
  },
}
