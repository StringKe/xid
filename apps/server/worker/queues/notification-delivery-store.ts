// 通知投递状态的 D1 读写:每次状态迁移都以期望的旧状态做条件更新,changes=0 表示状态已被别处推进。

import { notificationDeliveryIdentity, requiredTenantId } from './notification-delivery-identity'
import type { NotificationDeliveryInput } from './notification-delivery-identity'
import { prepareNotificationOutboxInsert } from './notification-outbox'
import { NotificationProviderError } from './notification-provider-error'

const LEASE_MS = 60_000

export type DeliveryStatus =
  | 'pending'
  | 'sending'
  | 'provider_accepted'
  | 'auditing'
  | 'delivered'
  | 'provider_rejected'
  | 'unknown_delivery'

export type DeliveryRow = {
  status: DeliveryStatus
  leaseUntil: number | null
  attemptCount: number
}

type ClaimInput = {
  tenantId: string
  deliveryIdentity: string
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

function hasChanged(result: D1Result<unknown>): boolean {
  return result.meta.changes === 1
}

export async function insertDelivery(
  env: Env,
  input: NotificationDeliveryInput,
  now: number,
): Promise<void> {
  await (await prepareNotificationOutboxInsert(env, input, { ignoreExisting: true, now })).run()
}

export async function findDelivery(
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

export async function claim(env: Env, input: ClaimInput): Promise<boolean> {
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

export async function recordProviderFailure(
  env: Env,
  options: ProviderFailureInput,
): Promise<boolean> {
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

export async function releaseAuditForRetry(
  env: Env,
  input: NotificationDeliveryInput,
): Promise<void> {
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
export async function releaseSendForRetry(
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
