// 通知 outbox 生产侧:收件人和 payload 以 KEK 信封加密落库,email 入队失败由 hourly cron 按同一
// deliveryId 重派。

import {
  base64UrlDecode,
  base64UrlEncode,
  envelopeDecrypt,
  envelopeEncrypt,
  sha256Hex,
} from '@xid-kit/crypto'
import type { EmailQueueMessage } from '@xid-kit/types'
import { logWorkerError, logWorkerWarning } from '../lib/safe-log'
import {
  notificationDeliveryIdentity,
  notificationDeliveryKey,
  requiredTenantId,
} from './notification-delivery-identity'
import type { NotificationDeliveryInput } from './notification-delivery-identity'

const OUTBOX_RETRY_MS = 60_000

function decodeKek(kekB64: string): Uint8Array {
  const binary = atob(kekB64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
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
