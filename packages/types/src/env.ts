// Queue message contracts shared by the Worker and public server-side SDKs.
// Cloudflare runtime bindings are intentionally isolated in the type-only
// `@xid-kit/types/cloudflare` subpath so browser consumers do not load Worker ambient types.

// Core owns the apex Custom Domain fallback. Cloudflare Worker Route matching includes the query
// string, so an exact Site or Console route without a trailing wildcard can fall through to Core
// when a query is present. These names are the one-way Service Bindings Core uses to preserve the
// shared route ownership contract without giving either frontend Worker a Core binding.
export const FRONTEND_WORKER_SERVICE_BINDING_NAMES = {
  site: 'SITE_WORKER',
  console: 'CONSOLE_WORKER',
} as const

// Queue 消息体(异步不阻塞登录链路,见 cloudflare-bindings rule:邮件/审计/webhook/计量)
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

// Optional Cloudflare for SaaS runtime contract. zone/cname target are vars; API token is a
// Workers Secret. Consumers must treat an entirely absent group as disabled and a partial group as
// a configuration error.
export type CloudflareForSaasEnv = {
  CLOUDFLARE_FOR_SAAS_ZONE_ID?: string
  CLOUDFLARE_FOR_SAAS_API_TOKEN?: string
  CLOUDFLARE_FOR_SAAS_CNAME_TARGET?: string
}

// Optional managed-service billing adapter. None of these values is a license or authentication
// feature gate. Deployers that do not operate a paid service leave the whole group unset.
export type StripeBillingEnv = {
  STRIPE_SECRET_KEY?: string
  STRIPE_WEBHOOK_SECRET?: string
  STRIPE_STARTER_PRICE_ID?: string
  STRIPE_PRO_PRICE_ID?: string
  STRIPE_ENTERPRISE_PRICE_ID?: string
  STRIPE_METER_EVENT_NAME?: string
}
