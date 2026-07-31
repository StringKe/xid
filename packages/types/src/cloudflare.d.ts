/// <reference types="@cloudflare/workers-types" />

import type {
  AuditQueueMessage,
  CloudflareForSaasEnv,
  EmailQueueMessage,
  MeteringQueueEnvelope,
  PrivacyQueueMessage,
  ScimSyncQueueMessage,
  SmsProviderName,
  SmsQueueMessage,
  WebhookQueueMessage,
  WhatsappProviderName,
  WhatsappQueueMessage,
} from '@xid-kit/types'

/**
 * Cloudflare Worker bindings for the XID identity Core.
 *
 * This type-only server subpath deliberately owns the Cloudflare ambient type reference. Browser
 * consumers should import shared contracts from `@xid-kit/types` and do not need
 * `@cloudflare/workers-types`.
 */
export type Env = CloudflareForSaasEnv & {
  DB: D1Database
  CACHE: KVNamespace
  STORAGE: R2Bucket
  ASSETS: Fetcher
  SITE_WORKER: Fetcher
  CONSOLE_WORKER: Fetcher

  WEBAUTHN_CHALLENGE: DurableObjectNamespace
  OAUTH_STATE: DurableObjectNamespace
  SESSION_REVOCATION: DurableObjectNamespace
  RATE_LIMITER: DurableObjectNamespace
  PAR_STORE: DurableObjectNamespace
  DEVICE_FLOW: DurableObjectNamespace
  AUDIT_SEQ: DurableObjectNamespace
  METERING: DurableObjectNamespace
  GUEST_STORE: DurableObjectNamespace
  CIBA_STATE: DurableObjectNamespace
  IMPERSONATION_GRANTS: DurableObjectNamespace

  EMAIL_QUEUE: Queue<EmailQueueMessage>
  WHATSAPP_QUEUE: Queue<WhatsappQueueMessage>
  SMS_QUEUE: Queue<SmsQueueMessage>
  AUDIT_QUEUE: Queue<AuditQueueMessage>
  WEBHOOK_QUEUE: Queue<WebhookQueueMessage>
  METERING_QUEUE: Queue<MeteringQueueEnvelope>
  SCIM_QUEUE: Queue<ScimSyncQueueMessage>
  PRIVACY_QUEUE: Queue<PrivacyQueueMessage>

  EMAIL: SendEmail
  ANALYTICS: AnalyticsEngineDataset

  ENVIRONMENT: string
  EMAIL_FROM_ADDRESS?: string
  EMAIL_FROM_NAME?: string
  KEK: string
  PEPPER: string
  BOOTSTRAP_TOKEN?: string
  TURNSTILE_SITE_KEY?: string
  TURNSTILE_SECRET?: string
  LDAP_GATEWAY_SHARED_SECRET?: string
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
  WEBAUTHN_TRUSTED_ROOTS_PEM?: string
}
