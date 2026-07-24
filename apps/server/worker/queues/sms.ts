// SMS Queue Consumer:支持 Twilio、Vonage、Infobip 与 MessageBird。
// 未配置 provider 时上游策略拒绝;consumer 仍做配置校验,失败落 notification_failures。

import type { SmsProviderName, SmsQueueMessage } from '@xid-kit/types'
import { TestSmsProvider } from '../test-harness/test-otp'
import { isDevOrTestEnvironment } from '../test-harness/dev-gate'
import {
  executeNotificationDelivery,
  providerHttpFailure,
  providerRejected,
  DELIVERY_RETRY_SECONDS,
} from './notification-delivery-state'
import { recordNotificationSent } from './notification-audit'
import { buildNotificationFailureRecord } from './notification-safety'
import { renderPhoneOtpText } from './phone-otp-template'

const BACKOFF_BASE_SECONDS = 2
const BACKOFF_START_EXP = 2
const TWILIO_API_BASE = 'https://api.twilio.com/2010-04-01'
const VONAGE_API_URL = 'https://rest.nexmo.com/sms/json'
const INFOBIP_SMS_PATH = '/sms/3/messages'
const MESSAGEBIRD_API_URL = 'https://rest.messagebird.com/messages'

export type SmsSendInput = {
  to: string
  from: string
  text: string
  tenantId?: string
}

export type SmsProvider = {
  readonly name: SmsProviderName
  send(input: SmsSendInput): Promise<void>
}

function required(value: string | undefined, name: string): string {
  if (value === undefined || value === '') throw new Error(`${name}_missing`)
  return value
}

function formBody(values: Record<string, string>): URLSearchParams {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) {
    if (value !== '') params.set(key, value)
  }
  return params
}

export class TwilioSmsProvider implements SmsProvider {
  readonly name = 'twilio'
  private readonly accountSid: string
  private readonly authToken: string
  private readonly from: string | undefined
  private readonly messagingServiceSid: string | undefined

  constructor(env: Env) {
    this.accountSid = required(env.TWILIO_ACCOUNT_SID, 'twilio_account_sid')
    this.authToken = required(env.TWILIO_AUTH_TOKEN, 'twilio_auth_token')
    this.from = env.SMS_FROM
    this.messagingServiceSid = env.TWILIO_MESSAGING_SERVICE_SID
  }

  async send(input: SmsSendInput): Promise<void> {
    const from = input.from || this.from || ''
    const body = formBody({
      To: input.to,
      Body: input.text,
      From: this.messagingServiceSid ? '' : required(from, 'sms_from'),
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
    if (!res.ok) throw providerHttpFailure('twilio', res.status)
  }
}

export class VonageSmsProvider implements SmsProvider {
  readonly name = 'vonage'
  private readonly apiKey: string
  private readonly apiSecret: string
  private readonly from: string

  constructor(env: Env) {
    this.apiKey = required(env.VONAGE_API_KEY, 'vonage_api_key')
    this.apiSecret = required(env.VONAGE_API_SECRET, 'vonage_api_secret')
    this.from = required(env.SMS_FROM, 'sms_from')
  }

  async send(input: SmsSendInput): Promise<void> {
    const res = await fetch(VONAGE_API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        api_key: this.apiKey,
        api_secret: this.apiSecret,
        to: input.to,
        from: input.from || this.from,
        text: input.text,
      }),
    })
    if (!res.ok) throw providerHttpFailure('vonage', res.status)
    const body = (await res.json().catch(() => ({}))) as {
      messages?: Array<{ status?: string; 'error-text'?: string }>
    }
    const first = body.messages?.[0]
    if (first && first.status !== '0') {
      throw providerRejected(`vonage_status_${first.status ?? 'unknown'}`)
    }
  }
}

export class InfobipSmsProvider implements SmsProvider {
  readonly name = 'infobip'
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly from: string

  constructor(env: Env) {
    this.apiKey = required(env.INFOBIP_API_KEY, 'infobip_api_key')
    this.baseUrl = required(env.INFOBIP_BASE_URL, 'infobip_base_url').replace(/\/+$/, '')
    this.from = required(env.SMS_FROM, 'sms_from')
  }

  async send(input: SmsSendInput): Promise<void> {
    const res = await fetch(`${this.baseUrl}${INFOBIP_SMS_PATH}`, {
      method: 'POST',
      headers: {
        authorization: `App ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        messages: [
          {
            from: input.from || this.from,
            destinations: [{ to: input.to }],
            text: input.text,
          },
        ],
      }),
    })
    if (!res.ok) throw providerHttpFailure('infobip', res.status)
  }
}

export class MessageBirdSmsProvider implements SmsProvider {
  readonly name = 'messagebird'
  private readonly accessKey: string
  private readonly from: string

  constructor(env: Env) {
    this.accessKey = required(env.MESSAGEBIRD_ACCESS_KEY, 'messagebird_access_key')
    this.from = required(env.SMS_FROM, 'sms_from')
  }

  async send(input: SmsSendInput): Promise<void> {
    const res = await fetch(MESSAGEBIRD_API_URL, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: `AccessKey ${this.accessKey}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: formBody({
        originator: input.from || this.from,
        recipients: input.to,
        body: input.text,
      }),
    })
    if (!res.ok) throw providerHttpFailure('messagebird', res.status)
  }
}

export function smsProviderReady(env: Env): boolean {
  if (env.SMS_PROVIDER === 'twilio') {
    return (
      Boolean(env.TWILIO_ACCOUNT_SID) &&
      Boolean(env.TWILIO_AUTH_TOKEN) &&
      (Boolean(env.SMS_FROM) || Boolean(env.TWILIO_MESSAGING_SERVICE_SID))
    )
  }
  if (env.SMS_PROVIDER === 'vonage') {
    return Boolean(env.VONAGE_API_KEY) && Boolean(env.VONAGE_API_SECRET) && Boolean(env.SMS_FROM)
  }
  if (env.SMS_PROVIDER === 'infobip') {
    return Boolean(env.INFOBIP_API_KEY) && Boolean(env.INFOBIP_BASE_URL) && Boolean(env.SMS_FROM)
  }
  if (env.SMS_PROVIDER === 'messagebird') {
    return Boolean(env.MESSAGEBIRD_ACCESS_KEY) && Boolean(env.SMS_FROM)
  }
  if (env.SMS_PROVIDER === 'test') {
    return isDevOrTestEnvironment(env)
  }
  return false
}

function resolveProvider(env: Env, requested?: SmsProviderName): SmsProvider {
  const provider = requested ?? env.SMS_PROVIDER
  if (provider === 'twilio') return new TwilioSmsProvider(env)
  if (provider === 'vonage') return new VonageSmsProvider(env)
  if (provider === 'infobip') return new InfobipSmsProvider(env)
  if (provider === 'messagebird') return new MessageBirdSmsProvider(env)
  if (provider === 'test') {
    if (!isDevOrTestEnvironment(env)) throw new Error('sms_provider_not_configured')
    return new TestSmsProvider(env)
  }
  throw new Error('sms_provider_not_configured')
}

async function renderSms(message: SmsQueueMessage, env: Env): Promise<SmsSendInput> {
  const text = await renderPhoneOtpText({
    storage: env.STORAGE,
    channel: 'sms',
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
  message: Message<SmsQueueMessage>
  reason: string
  attempts: number
  provider?: string
}

async function recordFailure(env: Env, failure: FailureRecord): Promise<void> {
  const body = failure.message.body
  const sanitized = await buildNotificationFailureRecord({
    channel: 'sms',
    type: body.type,
    recipient: body.recipient,
    payload: body.payload,
  })
  await env.DB.prepare(
    `INSERT OR IGNORE INTO notification_failures (id, source_message_id, tenant_id, channel, recipient, type, payload, provider, reason, attempts, failed_at)
     VALUES (?, ?, ?, 'sms', ?, ?, ?, ?, ?, ?, ?)`,
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

async function processSmsMessage(message: Message<SmsQueueMessage>, env: Env): Promise<void> {
  const attempt = message.attempts
  const providerName = message.body.payload.provider ?? env.SMS_PROVIDER
  let provider: SmsProvider
  let input: SmsSendInput
  try {
    provider = resolveProvider(env, providerName)
    input = await renderSms(message.body, env)
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'invalid_sms_message'
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
    channel: 'sms' as const,
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

export async function handleSmsBatch(
  batch: MessageBatch<SmsQueueMessage>,
  env: Env,
): Promise<void> {
  for (const message of batch.messages) {
    await processSmsMessage(message, env)
  }
}
