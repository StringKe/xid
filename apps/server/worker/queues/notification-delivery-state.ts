// 通知 consumer 状态机:pending -> sending -> provider_accepted -> auditing -> delivered。
// provider 明确拒绝或结果不确定时落 notification_delivery_failures 且不重发;429/5xx 回到 pending
// 按退避重试,累计 PROVIDER_SEND_ATTEMPT_LIMIT 次后按失败记录。

import { notificationDeliveryIdentity, requiredTenantId } from './notification-delivery-identity'
import type { NotificationDeliveryInput } from './notification-delivery-identity'
import { prepareNotificationOutboxInsert } from './notification-outbox'
import { NotificationProviderError } from './notification-provider-error'

export {
  notificationDeliveryIdentity,
  type NotificationDeliveryInput,
} from './notification-delivery-identity'
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

const LEASE_MS = 60_000
export const DELIVERY_RETRY_SECONDS = 15
const MAX_PROVIDER_RETRY_SECONDS = 600
export const PROVIDER_SEND_ATTEMPT_LIMIT = 5

type DeliveryStatus =
  | 'pending'
  | 'sending'
  | 'provider_accepted'
  | 'auditing'
  | 'delivered'
  | 'provider_rejected'
  | 'unknown_delivery'

type DeliveryRow = {
  status: DeliveryStatus
  leaseUntil: number | null
  attemptCount: number
}

type DeliveryAddress = {
  tenantId: string
  deliveryIdentity: string
}

type ClaimInput = DeliveryAddress & {
  from: DeliveryStatus
  to: 'sending' | 'auditing'
  now: number
}

type ProviderFailureInput = {
  input: NotificationDeliveryInput
  row: DeliveryRow
  expectedStatus: 'sending' | 'auditing'
  failure: NotificationProviderError
}

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

function hasChanged(result: D1Result<unknown>): boolean {
  return result.meta.changes === 1
}

async function insertDelivery(
  env: Env,
  input: NotificationDeliveryInput,
  now: number,
): Promise<void> {
  await (await prepareNotificationOutboxInsert(env, input, { ignoreExisting: true, now })).run()
}

async function findDelivery(
  env: Env,
  tenantId: string,
  deliveryIdentity: string,
): Promise<DeliveryRow> {
  const row = await env.DB.prepare(
    `SELECT status, lease_until AS leaseUntil, attempt_count AS attemptCount
     FROM notification_delivery_outbox
     WHERE tenant_id = ? AND delivery_identity = ?`,
  )
    .bind(tenantId, deliveryIdentity)
    .first<DeliveryRow>()
  if (row === null) throw new Error('notification_delivery_state_missing')
  return row
}

async function claim(env: Env, input: ClaimInput): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE notification_delivery_outbox
     SET status = ?, lease_until = ?, attempt_count = attempt_count + 1, updated_at = ?
     WHERE tenant_id = ? AND delivery_identity = ? AND status = ?`,
  )
    .bind(
      input.to,
      input.now + LEASE_MS,
      input.now,
      input.tenantId,
      input.deliveryIdentity,
      input.from,
    )
    .run()
  return hasChanged(result)
}

function providerFailure(error: unknown): NotificationProviderError {
  if (error instanceof NotificationProviderError) return error
  return new NotificationProviderError('indeterminate', 'provider_call_indeterminate')
}

async function recordProviderFailure(env: Env, options: ProviderFailureInput): Promise<boolean> {
  const { input, row, expectedStatus, failure } = options
  const now = Date.now()
  const tenantId = requiredTenantId(input.tenantId)
  const deliveryIdentity = notificationDeliveryIdentity(input)
  const status = failure.outcome === 'rejected' ? 'provider_rejected' : 'unknown_delivery'
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE notification_delivery_outbox
     SET status = ?, lease_until = NULL, last_error_code = ?, failure_kind = ?, failed_at = ?, updated_at = ?
     WHERE tenant_id = ? AND delivery_identity = ? AND status = ?`,
    ).bind(
      status,
      failure.code,
      failure.outcome,
      now,
      now,
      tenantId,
      deliveryIdentity,
      expectedStatus,
    ),
    env.DB.prepare(
      `INSERT INTO notification_delivery_failures (
        id, tenant_id, channel, source_message_id, delivery_identity, provider,
        outcome, reason, attempt_count, failed_at, created_at, updated_at
      )
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM notification_delivery_outbox
         WHERE tenant_id = ? AND delivery_identity = ? AND status = ?
       )
       ON CONFLICT (tenant_id, delivery_identity) DO UPDATE SET
         outcome = excluded.outcome,
         reason = excluded.reason,
         attempt_count = excluded.attempt_count,
         failed_at = excluded.failed_at,
         updated_at = excluded.updated_at`,
    ).bind(
      crypto.randomUUID(),
      tenantId,
      input.channel,
      input.messageId,
      deliveryIdentity,
      input.provider,
      failure.outcome,
      failure.code,
      row.attemptCount,
      now,
      now,
      now,
      tenantId,
      deliveryIdentity,
      status,
    ),
  ])
  const result = results[0]
  return result !== undefined && hasChanged(result)
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

export async function markProviderAccepted(
  env: Env,
  input: NotificationDeliveryInput,
): Promise<void> {
  const tenantId = requiredTenantId(input.tenantId)
  const now = Date.now()
  const result = await env.DB.prepare(
    `UPDATE notification_delivery_outbox
     SET status = 'provider_accepted', provider_accepted_at = ?, lease_until = NULL, updated_at = ?
     WHERE tenant_id = ? AND delivery_identity = ? AND status = 'sending'`,
  )
    .bind(now, now, tenantId, notificationDeliveryIdentity(input))
    .run()
  if (!hasChanged(result)) throw new Error('notification_provider_acceptance_state_lost')
}

export async function markProviderUnknown(
  env: Env,
  input: NotificationDeliveryInput,
  code: string,
): Promise<void> {
  const tenantId = requiredTenantId(input.tenantId)
  const row = await findDelivery(env, tenantId, notificationDeliveryIdentity(input))
  const changed = await recordProviderFailure(env, {
    input,
    row,
    expectedStatus: 'sending',
    failure: new NotificationProviderError('indeterminate', code),
  })
  if (!changed) throw new Error('notification_provider_unknown_state_lost')
}

export async function markAuditQueued(env: Env, input: NotificationDeliveryInput): Promise<void> {
  const tenantId = requiredTenantId(input.tenantId)
  const now = Date.now()
  const result = await env.DB.prepare(
    `UPDATE notification_delivery_outbox
     SET status = 'delivered', audit_queued_at = ?, lease_until = NULL, updated_at = ?
     WHERE tenant_id = ? AND delivery_identity = ? AND status = 'auditing'`,
  )
    .bind(now, now, tenantId, notificationDeliveryIdentity(input))
    .run()
  if (!hasChanged(result)) throw new Error('notification_audit_state_lost')
}

async function releaseAuditForRetry(env: Env, input: NotificationDeliveryInput): Promise<void> {
  const tenantId = requiredTenantId(input.tenantId)
  const now = Date.now()
  const result = await env.DB.prepare(
    `UPDATE notification_delivery_outbox
     SET status = 'provider_accepted', lease_until = NULL, last_error_code = 'audit_enqueue_failed', updated_at = ?
     WHERE tenant_id = ? AND delivery_identity = ? AND status = 'auditing'`,
  )
    .bind(now, tenantId, notificationDeliveryIdentity(input))
    .run()
  if (!hasChanged(result)) throw new Error('notification_audit_retry_state_lost')
}

// 回到 pending 并清 lease:否则短于 lease 的重投递会读到未过期的 sending 而只能等待。
async function releaseSendForRetry(
  env: Env,
  input: NotificationDeliveryInput,
  code: string,
): Promise<boolean> {
  const tenantId = requiredTenantId(input.tenantId)
  const now = Date.now()
  const result = await env.DB.prepare(
    `UPDATE notification_delivery_outbox
     SET status = 'pending', lease_until = NULL, last_error_code = ?, updated_at = ?
     WHERE tenant_id = ? AND delivery_identity = ? AND status = 'sending'`,
  )
    .bind(code, now, tenantId, notificationDeliveryIdentity(input))
    .run()
  return hasChanged(result)
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
