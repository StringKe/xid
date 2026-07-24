// WhatsApp Queue Consumer:支持 Twilio WhatsApp 与 Meta WhatsApp Cloud API。
// 登录链路只入队,provider 请求在 consumer 异步执行。

import type { WhatsappProviderName, WhatsappQueueMessage } from '@xid-kit/types'
import { TestWhatsappProvider } from '../test-harness/test-otp'
import { isDevOrTestEnvironment } from '../test-harness/dev-gate'
import {
  executeNotificationDelivery,
  providerHttpFailure,
  DELIVERY_RETRY_SECONDS,
} from './notification-delivery-state'
import { recordNotificationSent } from './notification-audit'
import { buildNotificationFailureRecord } from './notification-safety'
import { renderPhoneOtpText } from './phone-otp-template'

const BACKOFF_BASE_SECONDS = 2
const BACKOFF_START_EXP = 2
const TWILIO_API_BASE = 'https://api.twilio.com/2010-04-01'
const META_API_VERSION_DEFAULT = 'v25.0'

export type WhatsappSendInput = {
  to: string
  from: string
  text: string
  tenantId?: string
}

export type WhatsappProvider = {
  readonly name: WhatsappProviderName
  send(input: WhatsappSendInput): Promise<void>
}

function required(value: string | undefined, name: string): string {
  if (value === undefined || value === '') throw new Error(`${name}_missing`)
  return value
}

function whatsappAddress(value: string): string {
  return value.startsWith('whatsapp:') ? value : `whatsapp:${value}`
}

function formBody(values: Record<string, string>): URLSearchParams {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) {
    if (value !== '') params.set(key, value)
  }
  return params
}

export class TwilioWhatsappProvider implements WhatsappProvider {
  readonly name = 'twilio'
  private readonly accountSid: string
  private readonly authToken: string
  private readonly from: string | undefined
  private readonly messagingServiceSid: string | undefined

  constructor(env: Env) {
    this.accountSid = required(env.TWILIO_ACCOUNT_SID, 'twilio_account_sid')
    this.authToken = required(env.TWILIO_AUTH_TOKEN, 'twilio_auth_token')
    this.from = env.WHATSAPP_FROM || env.SMS_FROM
    this.messagingServiceSid = env.TWILIO_MESSAGING_SERVICE_SID
  }

  async send(input: WhatsappSendInput): Promise<void> {
    const from = input.from || this.from || ''
    const body = formBody({
      To: whatsappAddress(input.to),
      Body: input.text,
      From: this.messagingServiceSid ? '' : whatsappAddress(required(from, 'whatsapp_from')),
      MessagingServiceSid: this.messagingServiceSid ?? '',
    })
    const credentials = btoa(`${this.accountSid}:${this.authToken}`)
    const res = await fetch(
      `${TWILIO_API_BASE}/Accounts/${encodeURIComponent(this.accountSid)}/Messages.json`,
      {
        method: 'POST',
        headers: {
          authorization: `Basic ${credentials}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body,
      },
    )
    if (!res.ok) throw providerHttpFailure('twilio_whatsapp', res.status)
  }
}

export class MetaWhatsappProvider implements WhatsappProvider {
  readonly name = 'meta'
  private readonly phoneNumberId: string
  private readonly accessToken: string
  private readonly apiVersion: string

  constructor(env: Env) {
    this.phoneNumberId = required(
      env.WHATSAPP_META_PHONE_NUMBER_ID,
      'whatsapp_meta_phone_number_id',
    )
    this.accessToken = required(env.WHATSAPP_META_ACCESS_TOKEN, 'whatsapp_meta_access_token')
    this.apiVersion = env.WHATSAPP_META_API_VERSION || META_API_VERSION_DEFAULT
  }

  async send(input: WhatsappSendInput): Promise<void> {
    const res = await fetch(
      `https://graph.facebook.com/${encodeURIComponent(this.apiVersion)}/${encodeURIComponent(
        this.phoneNumberId,
      )}/messages`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: input.to,
          type: 'text',
          text: { preview_url: false, body: input.text },
        }),
      },
    )
    if (!res.ok) throw providerHttpFailure('meta_whatsapp', res.status)
  }
}

export function whatsappProviderReady(env: Env): boolean {
  if (env.WHATSAPP_PROVIDER === 'twilio') {
    return (
      Boolean(env.TWILIO_ACCOUNT_SID) &&
      Boolean(env.TWILIO_AUTH_TOKEN) &&
      (Boolean(env.WHATSAPP_FROM) ||
        Boolean(env.SMS_FROM) ||
        Boolean(env.TWILIO_MESSAGING_SERVICE_SID))
    )
  }
  if (env.WHATSAPP_PROVIDER === 'meta') {
    return Boolean(env.WHATSAPP_META_PHONE_NUMBER_ID) && Boolean(env.WHATSAPP_META_ACCESS_TOKEN)
  }
  if (env.WHATSAPP_PROVIDER === 'test') {
    return isDevOrTestEnvironment(env)
  }
  return false
}

function resolveProvider(env: Env, requested?: WhatsappProviderName): WhatsappProvider {
  const provider = requested ?? env.WHATSAPP_PROVIDER
  if (provider === 'twilio') return new TwilioWhatsappProvider(env)
  if (provider === 'meta') return new MetaWhatsappProvider(env)
  if (provider === 'test') {
    if (!isDevOrTestEnvironment(env)) throw new Error('whatsapp_provider_not_configured')
    return new TestWhatsappProvider(env)
  }
  throw new Error('whatsapp_provider_not_configured')
}

async function renderWhatsapp(message: WhatsappQueueMessage, env: Env): Promise<WhatsappSendInput> {
  const text = await renderPhoneOtpText({
    storage: env.STORAGE,
    channel: 'whatsapp',
    type: message.type,
    payload: message.payload,
  })
  return {
    to: message.recipient,
    from: typeof message.payload.from === 'string' ? message.payload.from : '',
    text,
    tenantId: typeof message.payload.tenantId === 'string' ? message.payload.tenantId : undefined,
  }
}

function backoffSeconds(attempt: number): number {
  return BACKOFF_BASE_SECONDS ** (BACKOFF_START_EXP + attempt)
}

type FailureRecord = {
  message: Message<WhatsappQueueMessage>
  reason: string
  attempts: number
  provider?: string
}

async function recordFailure(env: Env, failure: FailureRecord): Promise<void> {
  const body = failure.message.body
  const sanitized = await buildNotificationFailureRecord({
    channel: 'whatsapp',
    type: body.type,
    recipient: body.recipient,
    payload: body.payload,
  })
  await env.DB.prepare(
    `INSERT OR IGNORE INTO notification_failures (id, source_message_id, tenant_id, channel, recipient, type, payload, provider, reason, attempts, failed_at)
     VALUES (?, ?, ?, 'whatsapp', ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      failure.message.id,
      sanitized.tenantId,
      sanitized.recipient,
      body.type,
      JSON.stringify(sanitized.payload),
      failure.provider ?? null,
      failure.reason,
      failure.attempts,
      new Date().toISOString(),
    )
    .run()
}

async function recordFailureOrRetry(env: Env, failure: FailureRecord): Promise<void> {
  try {
    await recordFailure(env, failure)
    failure.message.ack()
  } catch {
    failure.message.retry({ delaySeconds: backoffSeconds(failure.attempts) })
  }
}

async function processWhatsappMessage(
  message: Message<WhatsappQueueMessage>,
  env: Env,
): Promise<void> {
  const attempt = message.attempts
  const providerName = message.body.payload.provider ?? env.WHATSAPP_PROVIDER
  let provider: WhatsappProvider
  let input: WhatsappSendInput
  try {
    provider = resolveProvider(env, providerName)
    input = await renderWhatsapp(message.body, env)
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'invalid_whatsapp_message'
    await recordFailureOrRetry(env, {
      message,
      reason,
      attempts: attempt,
      provider: providerName,
    })
    return
  }

  const delivery = {
    messageId: message.id,
    tenantId: input.tenantId,
    channel: 'whatsapp' as const,
    type: message.body.type,
    provider: provider.name,
    recipient: message.body.recipient,
    payload: message.body.payload,
  }
  try {
    const result = await executeNotificationDelivery(env, delivery, {
      send: () => provider.send(input),
      recordAudit: () => recordNotificationSent(env, delivery),
    })
    if (result === 'ack') {
      message.ack()
    } else {
      message.retry({ delaySeconds: DELIVERY_RETRY_SECONDS })
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'notification_delivery_state_failed'
    if (reason === 'notification_tenant_missing' || reason === 'notification_message_id_missing') {
      await recordFailureOrRetry(env, {
        message,
        reason,
        attempts: attempt,
        provider: provider.name,
      })
      return
    }
    message.retry({ delaySeconds: DELIVERY_RETRY_SECONDS })
  }
}

export async function handleWhatsappBatch(
  batch: MessageBatch<WhatsappQueueMessage>,
  env: Env,
): Promise<void> {
  for (const message of batch.messages) {
    await processWhatsappMessage(message, env)
  }
}
