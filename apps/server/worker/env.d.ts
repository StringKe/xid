/// <reference types="@cloudflare/workers-types" />
// Worker Bindings 全局 Env 类型声明(自包含,不依赖 wrangler 生成的 worker-configuration.d.ts)。
// 原因:wrangler types 跨版本(4.95/4.96)生成的 binding 类型不一致(4.96 为 `T | undefined`),
// 且 worker-configuration.d.ts 被 gitignore(CI 无),导致本地/CI tsc 结果分歧。
// 此处直接声明完整非 undefined 的全局 Env,binding 命名以 @xid-kit/types 的 Env 为准 + ASSETS。
// 铁律:binding 不在业务代码裸调,走封装层(此处只声明类型)。

import type {
  EmailQueueMessage,
  WhatsappQueueMessage,
  SmsQueueMessage,
  AuditQueueMessage,
  WebhookQueueMessage,
  MeteringQueueMessage,
} from '@xid-kit/types'

type WorkerEnv = {
  // D1 / KV / R2 / Email / Analytics
  DB: D1Database
  CACHE: KVNamespace
  STORAGE: R2Bucket
  EMAIL: SendEmail
  ANALYTICS: AnalyticsEngineDataset

  // SPA 静态资源
  ASSETS: Fetcher

  // Durable Objects(8 个,见 wrangler.jsonc durable_objects)
  SESSION_REVOCATION: DurableObjectNamespace
  WEBAUTHN_CHALLENGE: DurableObjectNamespace
  OAUTH_STATE: DurableObjectNamespace
  PAR_STORE: DurableObjectNamespace
  DEVICE_FLOW: DurableObjectNamespace
  RATE_LIMITER: DurableObjectNamespace
  AUDIT_SEQ: DurableObjectNamespace
  METERING: DurableObjectNamespace

  // Queues(6 条,消息体类型来自 @xid-kit/types)
  EMAIL_QUEUE: Queue<EmailQueueMessage>
  WHATSAPP_QUEUE: Queue<WhatsappQueueMessage>
  SMS_QUEUE: Queue<SmsQueueMessage>
  AUDIT_QUEUE: Queue<AuditQueueMessage>
  WEBHOOK_QUEUE: Queue<WebhookQueueMessage>
  METERING_QUEUE: Queue<MeteringQueueMessage>

  // 非敏感运行时配置
  ENVIRONMENT: string

  // Workers Secrets(wrangler types 不输出 secrets)
  // KEK:信封加密主密钥(base64 编码 32 字节 AES-256-GCM 密钥,见 signing-keys rule)
  KEK: string
  // PEPPER:密码哈希 pepper(见 password-auth rule)
  PEPPER: string
  // BOOTSTRAP_TOKEN:可选,seed/bootstrap 接口门控(配置则强制 X-Bootstrap-Token 匹配,防公网滥用)
  BOOTSTRAP_TOKEN?: string
  // TURNSTILE_SECRET:可选,Turnstile siteverify secret;未配置时认证端点跳过人机校验(dev/test)
  TURNSTILE_SECRET?: string
  // WhatsApp provider:支持 twilio / meta。未配置时 WhatsApp OTP 不可见且 direct API 策略拒绝。
  WHATSAPP_PROVIDER?: 'twilio' | 'meta'
  WHATSAPP_FROM?: string
  WHATSAPP_META_PHONE_NUMBER_ID?: string
  WHATSAPP_META_ACCESS_TOKEN?: string
  WHATSAPP_META_API_VERSION?: string
  // SMS provider:支持 twilio / vonage / infobip / messagebird。未配置时 SMS OTP 不可见且 direct API 策略拒绝。
  SMS_PROVIDER?: 'twilio' | 'vonage' | 'infobip' | 'messagebird'
  SMS_FROM?: string
  TWILIO_ACCOUNT_SID?: string
  TWILIO_AUTH_TOKEN?: string
  TWILIO_MESSAGING_SERVICE_SID?: string
  VONAGE_API_KEY?: string
  VONAGE_API_SECRET?: string
  INFOBIP_API_KEY?: string
  INFOBIP_BASE_URL?: string
  MESSAGEBIRD_ACCESS_KEY?: string
  // WebAuthn enterprise attestation trusted roots(PEM bundle,dev/operator supplied)
  WEBAUTHN_TRUSTED_ROOTS_PEM?: string
}

declare global {
  // 全局 Env:供 worker/index.ts 与 Hono<{ Bindings: Env }> 使用。
  interface Env extends WorkerEnv {}
}

// 命名导出供 import type { Env } from '../env'(等价全局 Env,含 ASSETS)。
export type { WorkerEnv as Env }
