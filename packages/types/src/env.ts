// Queue 消息契约与 Worker/服务端 SDK 共享；Cloudflare runtime binding 隔离在
// `@xid-kit/types/cloudflare`，避免浏览器消费者加载 Worker ambient 类型。

// Core 持有 apex Custom Domain 回落。Worker Route 匹配含 query string，Site/Console
// 精确路由无尾随通配时带 query 会落到 Core；本 binding 名是 Core 单向 Service Binding，
// 用来维持路由归属契约且不给前端 Worker 反向绑定。
export const FRONTEND_WORKER_SERVICE_BINDING_NAMES = {
  site: 'SITE_WORKER',
  console: 'CONSOLE_WORKER',
} as const

// 异步队列消息体：不得阻塞登录链路
export type EmailQueueMessage = {
  deliveryId?: string
  type: string
  recipient: string
  payload: Record<string, unknown>
}

export type SmsProviderName = 'twilio' | 'vonage' | 'infobip' | 'messagebird' | 'test'
export type WhatsappProviderName = 'twilio' | 'meta' | 'test'

export type SmsQueueMessage = {
  type: string
  recipient: string
  payload: {
    tenantId?: string
    provider?: SmsProviderName
    from?: string
    [key: string]: unknown
  }
}

export type WhatsappQueueMessage = {
  type: string
  recipient: string
  payload: {
    tenantId?: string
    provider?: WhatsappProviderName
    from?: string
    [key: string]: unknown
  }
}

export type AuditQueueMessage = {
  tenantId: string
  orgId?: string
  action: string
  actorId?: string
  ts: number
  payload: Record<string, unknown>
}

export type WebhookQueueMessage = {
  tenantId: string
  event: string
  payload: Record<string, unknown>
}

export type MeteringQueueMessage = {
  tenantId: string
  userId: string
  ts: number
}

export type StripeMeteringQueueMessage =
  | {
      type: 'stripe_mau_dispatch'
      period: string
      cursor?: string
      requestedAt: number
    }
  | {
      type: 'stripe_mau_report'
      tenantId: string
      period: string
      requestedAt: number
    }

export type MeteringQueueEnvelope = MeteringQueueMessage | StripeMeteringQueueMessage

export type ScimSyncQueueMessage = {
  tenantId: string
  orgId: string
  targetId: string
  issuer: string
  actorId?: string
  runId: string
  requestedAt: number
}

export type PrivacyQueueMessage = {
  requestId: string
  tenantId: string
  userId: string
  operation: 'export' | 'delete'
  requestedAt: number
}

// Cloudflare for SaaS 可选契约：整组缺省=禁用；只配一部分=配置错误
export type CloudflareForSaasEnv = {
  CLOUDFLARE_FOR_SAAS_ZONE_ID?: string
  CLOUDFLARE_FOR_SAAS_API_TOKEN?: string
  CLOUDFLARE_FOR_SAAS_CNAME_TARGET?: string
}

// 托管计费适配器；任一字段都不是 license 或鉴权功能开关，未运营付费服务则整组不配
export type StripeBillingEnv = {
  STRIPE_SECRET_KEY?: string
  STRIPE_WEBHOOK_SECRET?: string
  STRIPE_STARTER_PRICE_ID?: string
  STRIPE_PRO_PRICE_ID?: string
  STRIPE_ENTERPRISE_PRICE_ID?: string
  STRIPE_METER_EVENT_NAME?: string
}
