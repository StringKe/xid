import {
  base64UrlDecode,
  base64UrlEncode,
  envelopeDecrypt,
  envelopeEncrypt,
  sha256Hex,
} from '@xid-kit/crypto'
import type { EmailQueueMessage } from '@xid-kit/types'
import { logWorkerError, logWorkerWarning } from '../lib/safe-log'

const LEASE_MS = 60_000
const OUTBOX_RETRY_MS = 60_000
export const DELIVERY_RETRY_SECONDS = 15

type NotificationChannel = 'email' | 'sms' | 'whatsapp'
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

export type NotificationProviderFailureOutcome = 'rejected' | 'indeterminate'

export class NotificationProviderError extends Error {
  readonly outcome: NotificationProviderFailureOutcome
  readonly code: string

  constructor(outcome: NotificationProviderFailureOutcome, code: string) {
    super(code)
    this.name = 'NotificationProviderError'
    this.outcome = outcome
    this.code = code
  }
}

export type NotificationDeliveryInput = {
  messageId: string
  deliveryKey?: string
  tenantId: string | undefined
  channel: NotificationChannel
  type: string
  provider: string
  recipient: string
  payload: Record<string, unknown>
}

export type NotificationDeliveryAction = 'send' | 'audit' | 'wait' | 'ack'

export type NotificationDeliveryCallbacks = {
  send(): Promise<void>
  recordAudit(): Promise<void>
}

export function notificationDeliveryIdentity(
  input: Pick<NotificationDeliveryInput, 'channel' | 'messageId'>,
): string {
  if (input.messageId === '') throw new Error('notification_message_id_missing')
  return `${input.channel}:${input.messageId}`
}

function notificationDeliveryKey(input: NotificationDeliveryInput): string {
  return input.deliveryKey ?? notificationDeliveryIdentity(input)
}

export function providerHttpFailure(provider: string, status: number): NotificationProviderError {
  const outcome =
    status >= 400 && status < 500 && status !== 408 && status !== 429 ? 'rejected' : 'indeterminate'
  return new NotificationProviderError(outcome, `${provider}_${status}`)
}

export function providerRejected(code: string): NotificationProviderError {
  return new NotificationProviderError('rejected', code)
}

export type NotificationDeliveryResult = 'ack' | 'retry'

function decodeKek(kekB64: string): Uint8Array {
  const binary = atob(kekB64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

function hasChanged(result: D1Result<unknown>): boolean {
  return result.meta.changes === 1
}

function requiredTenantId(tenantId: string | undefined): string {
  if (tenantId === undefined || tenantId === '') throw new Error('notification_tenant_missing')
  return tenantId
}

export async function prepareNotificationOutboxInsert(
  env: Env,
  input: NotificationDeliveryInput,
  options: { ignoreExisting?: boolean; now?: number } = {},
): Promise<D1PreparedStatement> {
  const tenantId = requiredTenantId(input.tenantId)
  const now = options.now ?? Date.now()
  const kek = decodeKek(env.KEK)
  const recipient = input.recipient.trim().toLowerCase()
  const [recipientBlob, payloadBlob, recipientHash] = await Promise.all([
    envelopeEncrypt(new TextEncoder().encode(input.recipient), kek, 1),
    envelopeEncrypt(new TextEncoder().encode(JSON.stringify(input.payload)), kek, 1),
    sha256Hex(`${tenantId}:${input.channel}:${recipient}`),
  ])
  const insert = options.ignoreExisting === false ? 'INSERT' : 'INSERT OR IGNORE'
  return env.DB.prepare(
    `${insert} INTO notification_delivery_outbox (
      id, tenant_id, delivery_key, source_message_id, delivery_identity, channel, type, provider, recipient_hash,
      recipient_iv, recipient_ciphertext, recipient_tag,
      payload_iv, payload_ciphertext, payload_tag,
      status, attempt_count, available_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(),
    tenantId,
    notificationDeliveryKey(input),
    input.messageId,
    notificationDeliveryIdentity(input),
    input.channel,
    input.type,
    input.provider,
    recipientHash,
    base64UrlEncode(recipientBlob.iv),
    base64UrlEncode(recipientBlob.ciphertext),
    base64UrlEncode(recipientBlob.tag),
    base64UrlEncode(payloadBlob.iv),
    base64UrlEncode(payloadBlob.ciphertext),
    base64UrlEncode(payloadBlob.tag),
    now,
    now,
    now,
  )
}

async function insertDelivery(
  env: Env,
  input: NotificationDeliveryInput,
  _tenantId: string,
  now: number,
): Promise<void> {
  await (await prepareNotificationOutboxInsert(env, input, { ignoreExisting: true, now })).run()
}

function emailQueueMessage(input: NotificationDeliveryInput): EmailQueueMessage {
  if (input.channel !== 'email') throw new Error('notification_channel_not_email')
  return {
    deliveryId: input.messageId,
    type: input.type,
    recipient: input.recipient,
    payload: input.payload,
  }
}

async function noteQueueSendFailure(
  env: Env,
  input: NotificationDeliveryInput,
  now: number,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE notification_delivery_outbox
     SET available_at = ?, attempt_count = attempt_count + 1,
         last_error_code = 'queue_send_failed', updated_at = ?
     WHERE tenant_id = ? AND delivery_identity = ? AND status = 'pending'`,
  )
    .bind(
      now + OUTBOX_RETRY_MS,
      now,
      requiredTenantId(input.tenantId),
      notificationDeliveryIdentity(input),
    )
    .run()
}

async function markQueued(env: Env, input: NotificationDeliveryInput, now: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE notification_delivery_outbox
     SET queued_at = COALESCE(queued_at, ?), last_error_code = NULL, updated_at = ?
     WHERE tenant_id = ? AND delivery_identity = ?`,
  )
    .bind(now, now, requiredTenantId(input.tenantId), notificationDeliveryIdentity(input))
    .run()
}

// The caller must persist the outbox row before calling this function. A Queue failure is
// recoverable and therefore does not fail the business transaction; the hourly dispatcher retries
// the KEK-encrypted row with the same deliveryId.
export async function enqueuePersistedEmailNotification(
  env: Env,
  input: NotificationDeliveryInput,
): Promise<boolean> {
  try {
    await env.EMAIL_QUEUE.send(emailQueueMessage(input))
  } catch (error) {
    try {
      await noteQueueSendFailure(env, input, Date.now())
    } catch (stateError) {
      logWorkerError('notification.outbox.queue_failure_state_write_failed', stateError, {
        component: 'notification-outbox',
        queue: 'xid-email',
        outcome: 'cron_recovery_required',
      })
    }
    logWorkerError('notification.outbox.queue_send_failed', error, {
      component: 'notification-outbox',
      queue: 'xid-email',
      outcome: 'cron_recovery_required',
    })
    return false
  }

  try {
    await markQueued(env, input, Date.now())
  } catch (error) {
    // Queue acceptance happened first. Leaving queued_at null deliberately causes a later
    // at-least-once retry with the same deliveryId; consumer state prevents a second provider send.
    logWorkerError('notification.outbox.queued_state_write_failed', error, {
      component: 'notification-outbox',
      queue: 'xid-email',
      outcome: 'idempotent_redelivery_expected',
    })
  }
  return true
}

type PendingNotificationOutboxRow = {
  tenantId: string
  deliveryKey: string
  sourceMessageId: string
  type: string
  provider: string | null
  recipientIv: string
  recipientCiphertext: string
  recipientTag: string
  payloadIv: string
  payloadCiphertext: string
  payloadTag: string
}

function parseRecord(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('notification_outbox_payload_invalid')
  }
  return parsed as Record<string, unknown>
}

async function decryptPendingNotification(
  env: Env,
  row: PendingNotificationOutboxRow,
): Promise<NotificationDeliveryInput> {
  const kek = decodeKek(env.KEK)
  const [recipient, payload] = await Promise.all([
    envelopeDecrypt(
      {
        iv: base64UrlDecode(row.recipientIv),
        ciphertext: base64UrlDecode(row.recipientCiphertext),
        tag: base64UrlDecode(row.recipientTag),
        kekVersion: 1,
      },
      kek,
    ),
    envelopeDecrypt(
      {
        iv: base64UrlDecode(row.payloadIv),
        ciphertext: base64UrlDecode(row.payloadCiphertext),
        tag: base64UrlDecode(row.payloadTag),
        kekVersion: 1,
      },
      kek,
    ),
  ])
  return {
    messageId: row.sourceMessageId,
    deliveryKey: row.deliveryKey,
    tenantId: row.tenantId,
    channel: 'email',
    type: row.type,
    provider: row.provider ?? 'cloudflare',
    recipient: new TextDecoder().decode(recipient),
    payload: parseRecord(new TextDecoder().decode(payload)),
  }
}

export async function redeliverPendingNotificationOutbox(
  env: Env,
  now: number = Date.now(),
): Promise<void> {
  const rows = (
    await env.DB.prepare(
      `SELECT tenant_id AS tenantId, delivery_key AS deliveryKey,
              source_message_id AS sourceMessageId, type, provider,
              recipient_iv AS recipientIv, recipient_ciphertext AS recipientCiphertext,
              recipient_tag AS recipientTag, payload_iv AS payloadIv,
              payload_ciphertext AS payloadCiphertext, payload_tag AS payloadTag
       FROM notification_delivery_outbox
       WHERE channel = 'email' AND status = 'pending' AND queued_at IS NULL
         AND source_message_id IS NOT NULL AND available_at <= ?
       ORDER BY available_at ASC, id ASC
       LIMIT 100`,
    )
      .bind(now)
      .all<PendingNotificationOutboxRow>()
  ).results

  for (const row of rows) {
    try {
      const input = await decryptPendingNotification(env, row)
      await enqueuePersistedEmailNotification(env, input)
    } catch (error) {
      logWorkerError('notification.outbox.redelivery_failed', error, {
        component: 'notification-outbox',
        queue: 'xid-email',
        outcome: 'retry_next_cron',
      })
    }
  }
  if (rows.length === 100) {
    logWorkerWarning('notification.outbox.redelivery_batch_full', {
      component: 'notification-outbox',
      queue: 'xid-email',
      outcome: 'remaining_rows_next_cron',
    })
  }
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
  await insertDelivery(env, input, tenantId, now)
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
        const tenantId = requiredTenantId(input.tenantId)
        const row = await findDelivery(env, tenantId, notificationDeliveryIdentity(input))
        const recorded = await recordProviderFailure(env, {
          input,
          row,
          expectedStatus: 'sending',
          failure: providerFailure(error),
        })
        return recorded ? 'ack' : 'retry'
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
