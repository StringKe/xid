// SMS Queue Consumer:provider 见 sms-providers.ts。
// 未配置 provider 时上游策略拒绝;consumer 仍做配置校验,失败落 notification_failures。

import type { SmsProviderName, SmsQueueMessage } from '@xid-kit/types'
import { TestSmsProvider } from '../test-harness/test-otp'
import { isDevOrTestEnvironment } from '../test-harness/dev-gate'
import {
  executeNotificationDelivery,
  DELIVERY_RETRY_SECONDS,
  deliveryRetryDelaySeconds,
} from './notification-delivery-state'
import { recordNotificationSent } from './notification-audit'
import { buildNotificationFailureRecord } from './notification-safety'
import { renderPhoneOtpText } from './phone-otp-template'
import {
  BirdSmsProvider,
  InfobipSmsProvider,
  TwilioSmsProvider,
  VonageSmsProvider,
} from './sms-providers'
import type { SmsProvider, SmsSendInput } from './sms-providers'

const BACKOFF_BASE_SECONDS = 2
const BACKOFF_START_EXP = 2

function resolveProvider(env: Env, requested?: SmsProviderName): SmsProvider {
  const provider = requested ?? env.SMS_PROVIDER
  if (provider === 'twilio') return new TwilioSmsProvider(env)
  if (provider === 'vonage') return new VonageSmsProvider(env)
  if (provider === 'infobip') return new InfobipSmsProvider(env)
  if (provider === 'messagebird') return new BirdSmsProvider(env)
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
      message.retry({ delaySeconds: deliveryRetryDelaySeconds(result) })
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
