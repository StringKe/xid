// 通知 consumer 状态机:pending -> sending -> provider_accepted -> auditing -> delivered。
// provider 明确拒绝或结果不确定时落 notification_delivery_failures 且不重发;429/5xx 回到 pending
// 按退避重试,累计 PROVIDER_SEND_ATTEMPT_LIMIT 次后按失败记录。

import { notificationDeliveryIdentity, requiredTenantId } from './notification-delivery-identity'
import type { NotificationDeliveryInput } from './notification-delivery-identity'
import {
  claim,
  findDelivery,
  insertDelivery,
  markAuditQueued,
  markProviderAccepted,
  recordProviderFailure,
  releaseAuditForRetry,
  releaseSendForRetry,
} from './notification-delivery-store'
import { NotificationProviderError } from './notification-provider-error'

export {
  notificationDeliveryIdentity,
  type NotificationDeliveryInput,
} from './notification-delivery-identity'
export {
  markAuditQueued,
  markProviderAccepted,
  markProviderUnknown,
} from './notification-delivery-store'
export {
  enqueuePersistedEmailNotification,
  prepareNotificationOutboxInsert,
  redeliverPendingNotificationOutbox,
} from './notification-outbox'
export {
  NotificationProviderError,
  type NotificationProviderFailureOutcome,
  providerHttpFailure,
  providerIndeterminate,
  providerRejected,
  providerResponseFailure,
} from './notification-provider-error'

export const DELIVERY_RETRY_SECONDS = 15
const MAX_PROVIDER_RETRY_SECONDS = 600
export const PROVIDER_SEND_ATTEMPT_LIMIT = 5

export type NotificationDeliveryAction = 'send' | 'audit' | 'wait' | 'ack'

export type NotificationDeliveryCallbacks = {
  send(): Promise<void>
  recordAudit(): Promise<void>
}

export type NotificationProviderRetry = { providerRetryAfterSeconds: number }

export type NotificationDeliveryResult = 'ack' | 'retry' | NotificationProviderRetry

export function deliveryRetryDelaySeconds(
  result: Exclude<NotificationDeliveryResult, 'ack'>,
): number {
  return result === 'retry' ? DELIVERY_RETRY_SECONDS : result.providerRetryAfterSeconds
}

function providerFailure(error: unknown): NotificationProviderError {
  if (error instanceof NotificationProviderError) return error
  return new NotificationProviderError('indeterminate', 'provider_call_indeterminate')
}

export async function prepareNotificationDelivery(
  env: Env,
  input: NotificationDeliveryInput,
): Promise<NotificationDeliveryAction> {
  if (input.messageId === '') throw new Error('notification_message_id_missing')
  const tenantId = requiredTenantId(input.tenantId)
  const deliveryIdentity = notificationDeliveryIdentity(input)
  const now = Date.now()
  await insertDelivery(env, input, now)
  const row = await findDelivery(env, tenantId, deliveryIdentity)

  if (row.status === 'pending') {
    return (await claim(env, {
      tenantId,
      deliveryIdentity,
      from: 'pending',
      to: 'sending',
      now,
    }))
      ? 'send'
      : 'wait'
  }
  if (row.status === 'provider_accepted') {
    return (await claim(env, {
      tenantId,
      deliveryIdentity,
      from: 'provider_accepted',
      to: 'auditing',
      now,
    }))
      ? 'audit'
      : 'wait'
  }
  if (row.status === 'sending' || row.status === 'auditing') {
    if (row.leaseUntil !== null && row.leaseUntil > now) return 'wait'
    const becameUnknown = await recordProviderFailure(env, {
      input,
      row,
      expectedStatus: row.status,
      failure: new NotificationProviderError(
        'indeterminate',
        row.status === 'sending' ? 'provider_acceptance_unknown' : 'audit_enqueue_unknown',
      ),
    })
    return becameUnknown ? 'ack' : 'wait'
  }
  return 'ack'
}

function providerRetryDelaySeconds(
  failure: NotificationProviderError,
  attemptCount: number,
): number {
  if (failure.retryAfterSeconds !== undefined) return failure.retryAfterSeconds
  const exponent = Math.max(attemptCount - 1, 0)
  return Math.min(DELIVERY_RETRY_SECONDS * 2 ** exponent, MAX_PROVIDER_RETRY_SECONDS)
}

async function settleSendFailure(
  env: Env,
  input: NotificationDeliveryInput,
  error: unknown,
): Promise<NotificationDeliveryResult> {
  const failure = providerFailure(error)
  const row = await findDelivery(
    env,
    requiredTenantId(input.tenantId),
    notificationDeliveryIdentity(input),
  )
  if (failure.retryable && row.attemptCount < PROVIDER_SEND_ATTEMPT_LIMIT) {
    if (!(await releaseSendForRetry(env, input, failure.code))) return 'retry'
    return { providerRetryAfterSeconds: providerRetryDelaySeconds(failure, row.attemptCount) }
  }
  const recorded = await recordProviderFailure(env, {
    input,
    row,
    expectedStatus: 'sending',
    failure,
  })
  return recorded ? 'ack' : 'retry'
}

export async function executeNotificationDelivery(
  env: Env,
  input: NotificationDeliveryInput,
  callbacks: NotificationDeliveryCallbacks,
): Promise<NotificationDeliveryResult> {
  let action = await prepareNotificationDelivery(env, input)
  if (action === 'send') {
    try {
      await callbacks.send()
    } catch (error) {
      try {
        return await settleSendFailure(env, input, error)
      } catch {
        return 'retry'
      }
    }
    try {
      await markProviderAccepted(env, input)
      action = await prepareNotificationDelivery(env, input)
    } catch {
      return 'retry'
    }
  }
  if (action === 'audit') {
    try {
      await callbacks.recordAudit()
      await markAuditQueued(env, input)
      return 'ack'
    } catch {
      try {
        await releaseAuditForRetry(env, input)
        return 'retry'
      } catch {
        return 'retry'
      }
    }
  }
  return action === 'ack' ? 'ack' : 'retry'
}
