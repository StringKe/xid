import { base64UrlEncode, envelopeEncrypt, sha256Hex } from '@xid-kit/crypto'

const LEASE_MS = 60_000
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

async function insertDelivery(
  env: Env,
  input: NotificationDeliveryInput,
  tenantId: string,
  now: number,
): Promise<void> {
  const kek = decodeKek(env.KEK)
  const recipient = input.recipient.trim().toLowerCase()
  const [recipientBlob, payloadBlob, recipientHash] = await Promise.all([
    envelopeEncrypt(new TextEncoder().encode(input.recipient), kek, 1),
    envelopeEncrypt(new TextEncoder().encode(JSON.stringify(input.payload)), kek, 1),
    sha256Hex(`${tenantId}:${input.channel}:${recipient}`),
  ])
  await env.DB.prepare(
    `INSERT OR IGNORE INTO notification_delivery_outbox (
      id, tenant_id, delivery_key, source_message_id, delivery_identity, channel, type, provider, recipient_hash,
      recipient_iv, recipient_ciphertext, recipient_tag,
      payload_iv, payload_ciphertext, payload_tag,
      status, attempt_count, available_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      tenantId,
      notificationDeliveryIdentity(input),
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
    .run()
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
