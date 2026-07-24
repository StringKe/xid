/// <reference types="@cloudflare/workers-types" />
// 第 7 组契约:Cloudflare Worker bindings(Env)。
// 对照 docs/design/00-overview.md 第 8 节服务映射、cloudflare-bindings rule。
// 铁律:binding 不在业务代码裸调,走封装(此处只声明类型)。

// Queue 消息体(异步不阻塞登录链路,见 cloudflare-bindings rule:邮件/审计/webhook/计量)
export type EmailQueueMessage = {
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

// Cloudflare bindings。D1/KV/R2/DO/Queues/Analytics 全局类型来自 @cloudflare/workers-types。
// secret(KEK/pepper/provider 凭证)注入为 string(见 00 章第 8 节 Workers Secrets)。
export type Env = {
  // D1:关系数据(用户/应用/凭证/授权码/refresh token/审计/租户/密钥密文/会话)
  DB: D1Database
  // KV:JWKS / discovery / 品牌配置 / feature flag 缓存
  CACHE: KVNamespace
  // R2:头像 / logo / 邮件语言包 / 导出文件 / GeoIP MMDB
  STORAGE: R2Bucket

  // Durable Objects(强一致 / 防重放 / 串行,见 cloudflare-bindings rule),与 wrangler.jsonc 8 个 binding 对齐
  WEBAUTHN_CHALLENGE: DurableObjectNamespace
  OAUTH_STATE: DurableObjectNamespace
  SESSION_REVOCATION: DurableObjectNamespace
  RATE_LIMITER: DurableObjectNamespace
  PAR_STORE: DurableObjectNamespace
  DEVICE_FLOW: DurableObjectNamespace
  AUDIT_SEQ: DurableObjectNamespace
  METERING: DurableObjectNamespace

  // Queues(异步,见 cloudflare-bindings rule)
  EMAIL_QUEUE: Queue<EmailQueueMessage>
  WHATSAPP_QUEUE: Queue<WhatsappQueueMessage>
  SMS_QUEUE: Queue<SmsQueueMessage>
  AUDIT_QUEUE: Queue<AuditQueueMessage>
  WEBHOOK_QUEUE: Queue<WebhookQueueMessage>
  METERING_QUEUE: Queue<MeteringQueueMessage>

  // Email Sending:Cloudflare Email Service 出站事务邮件(send_email binding,见 07 章 3.1)
  EMAIL: SendEmail

  // Analytics Engine:实时指标(登录成功率 / MFA 采用率 / 活跃数)
  ANALYTICS: AnalyticsEngineDataset

  // Workers Secrets(信封加密主密钥 KEK + 密码 pepper,见 signing-keys / password-auth rule)
  KEK: string
  PEPPER: string
  WHATSAPP_PROVIDER?: WhatsappProviderName
  WHATSAPP_FROM?: string
  WHATSAPP_META_PHONE_NUMBER_ID?: string
  WHATSAPP_META_ACCESS_TOKEN?: string
  WHATSAPP_META_API_VERSION?: string
  SMS_PROVIDER?: SmsProviderName
  SMS_FROM?: string
  TWILIO_ACCOUNT_SID?: string
  TWILIO_AUTH_TOKEN?: string
  TWILIO_MESSAGING_SERVICE_SID?: string
  VONAGE_API_KEY?: string
  VONAGE_API_SECRET?: string
  INFOBIP_API_KEY?: string
  INFOBIP_BASE_URL?: string
  MESSAGEBIRD_ACCESS_KEY?: string
}
