// WhatsApp Queue Consumer:provider 见 whatsapp-providers.ts。
// 登录链路只入队,provider 请求在 consumer 异步执行。

import type { WhatsappProviderName, WhatsappQueueMessage } from '@xid-kit/types'
import { TestWhatsappProvider } from '../test-harness/test-otp'
import { isDevOrTestEnvironment } from '../test-harness/dev-gate'
import {
  executeNotificationDelivery,
  DELIVERY_RETRY_SECONDS,
  deliveryRetryDelaySeconds,
} from './notification-delivery-state'
import { recordNotificationSent } from './notification-audit'
import { buildNotificationFailureRecord } from './notification-safety'
import { renderPhoneOtpText } from './phone-otp-template'
import { MetaWhatsappProvider, TwilioWhatsappProvider } from './whatsapp-providers'
import type { WhatsappProvider, WhatsappSendInput } from './whatsapp-providers'

const BACKOFF_BASE_SECONDS = 2
const BACKOFF_START_EXP = 2

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
  const code = message.payload.code
  if (typeof code !== 'string' || code === '') throw new Error('whatsapp_code_missing')
  const text = await renderPhoneOtpText({
    storage: env.STORAGE,
    channel: 'whatsapp',
    type: message.type,
    payload: message.payload,
  })
  return {
    to: message.recipient,
    from: typeof message.payload.from === 'string' ? message.payload.from : '',
    code,
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

export async function handleWhatsappBatch(
  batch: MessageBatch<WhatsappQueueMessage>,
  env: Env,
): Promise<void> {
  for (const message of batch.messages) {
    await processWhatsappMessage(message, env)
  }
}
