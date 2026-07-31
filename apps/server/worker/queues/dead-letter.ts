import { base64UrlDecode, base64UrlEncode, envelopeDecrypt, envelopeEncrypt } from '@xid-kit/crypto'
import type {
  AuditQueueMessage,
  EmailQueueMessage,
  MeteringQueueEnvelope,
  PrivacyQueueMessage,
  ScimSyncQueueMessage,
  SmsQueueMessage,
  WebhookQueueMessage,
  WhatsappQueueMessage,
} from '@xid-kit/types'
import { createPersistedId } from '../lib/persisted-id'
import { logWorkerError, logWorkerWarning } from '../lib/safe-log'

type SourceQueueName =
  | 'xid-email'
  | 'xid-whatsapp'
  | 'xid-sms'
  | 'xid-audit'
  | 'xid-webhook'
  | 'xid-metering'
  | 'xid-scim-sync'
  | 'xid-privacy'

type DeadLetterQueueName =
  | 'xid-email-dlq'
  | 'xid-whatsapp-dlq'
  | 'xid-sms-dlq'
  | 'xid-audit-dlq'
  | 'xid-webhook-dlq'
  | 'xid-metering-dlq'
  | 'xid-scim-sync-dlq'
  | 'xid-privacy-dlq'

type DeadLetterSource = {
  sourceQueue: SourceQueueName
  deadLetterQueue: DeadLetterQueueName
}

export const DEAD_LETTER_SOURCES = [
  { sourceQueue: 'xid-email', deadLetterQueue: 'xid-email-dlq' },
  { sourceQueue: 'xid-whatsapp', deadLetterQueue: 'xid-whatsapp-dlq' },
  { sourceQueue: 'xid-sms', deadLetterQueue: 'xid-sms-dlq' },
  { sourceQueue: 'xid-audit', deadLetterQueue: 'xid-audit-dlq' },
  { sourceQueue: 'xid-webhook', deadLetterQueue: 'xid-webhook-dlq' },
  { sourceQueue: 'xid-metering', deadLetterQueue: 'xid-metering-dlq' },
  { sourceQueue: 'xid-scim-sync', deadLetterQueue: 'xid-scim-sync-dlq' },
  { sourceQueue: 'xid-privacy', deadLetterQueue: 'xid-privacy-dlq' },
] as const satisfies readonly DeadLetterSource[]

const sourceByDeadLetterQueue = new Map<DeadLetterQueueName, DeadLetterSource>(
  DEAD_LETTER_SOURCES.map((source) => [source.deadLetterQueue, source]),
)

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u
const KEK_VERSION = 1
export const DEAD_LETTER_REPLAY_LEASE_MS = 5 * 60 * 1000

type DeadLetterMetadata = {
  tenantId: string | null
  orgId: string | null
  eventType: string
}

type ReplayCipherRow = {
  id: string
  sourceQueue: SourceQueueName
  deadLetterQueue: DeadLetterQueueName
  status: string
  payloadIv: string
  payloadCiphertext: string
  payloadTag: string
  payloadKekVersion: number
  replayRequestedAt: number | null
}

export type DeadLetterReplayResult = {
  id: string
  status: 'pending' | 'replaying' | 'replayed'
  replayed: boolean
  idempotent: boolean
}

export type DeadLetterReplayAudit = {
  statement: D1PreparedStatement
  mutationGate: {
    sql: string
    bindings: readonly unknown[]
  }
}

export type DeadLetterReplayAuditFactory = (claimedAt: number) => DeadLetterReplayAudit

function decodeKek(kekBase64: string): Uint8Array {
  const binary = atob(kekBase64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safeIdentifier(value: unknown): string | null {
  return typeof value === 'string' && SAFE_IDENTIFIER.test(value) ? value : null
}

function notificationMetadata(body: Record<string, unknown>): DeadLetterMetadata {
  const payload = isRecord(body['payload']) ? body['payload'] : {}
  return {
    tenantId: safeIdentifier(payload['tenantId']),
    orgId: null,
    eventType: safeIdentifier(body['type']) ?? 'unknown',
  }
}

export function deadLetterMetadata(
  sourceQueue: SourceQueueName,
  body: unknown,
): DeadLetterMetadata {
  if (!isRecord(body)) return { tenantId: null, orgId: null, eventType: 'unknown' }
  switch (sourceQueue) {
    case 'xid-email':
    case 'xid-whatsapp':
    case 'xid-sms':
      return notificationMetadata(body)
    case 'xid-audit':
      return {
        tenantId: safeIdentifier(body['tenantId']),
        orgId: safeIdentifier(body['orgId']),
        eventType: safeIdentifier(body['action']) ?? 'unknown',
      }
    case 'xid-webhook':
      return {
        tenantId: safeIdentifier(body['tenantId']),
        orgId: null,
        eventType: safeIdentifier(body['event']) ?? 'unknown',
      }
    case 'xid-metering':
      return {
        tenantId: safeIdentifier(body['tenantId']),
        orgId: null,
        eventType: 'metering',
      }
    case 'xid-scim-sync':
      return {
        tenantId: safeIdentifier(body['tenantId']),
        orgId: safeIdentifier(body['orgId']),
        eventType: 'scim.sync',
      }
    case 'xid-privacy':
      return {
        tenantId: safeIdentifier(body['tenantId']),
        orgId: null,
        eventType: `privacy.${safeIdentifier(body['operation']) ?? 'unknown'}`,
      }
  }
}

function serializeBody(body: unknown): Uint8Array {
  const serialized = JSON.stringify(body)
  if (serialized === undefined) throw new Error('dead_letter_payload_not_serializable')
  return new TextEncoder().encode(serialized)
}

function signalDeadLetterPersisted(env: Env, sourceQueue: SourceQueueName): void {
  try {
    env.ANALYTICS.writeDataPoint({
      indexes: [sourceQueue],
      blobs: ['queue.dead_letter.persisted'],
      doubles: [1],
    })
  } catch (error) {
    logWorkerError('queue.dead_letter.analytics_write_failed', error, {
      component: 'queue-dead-letter',
      queue: sourceQueue,
    })
  }
  logWorkerWarning('queue.dead_letter.persisted', {
    component: 'queue-dead-letter',
    queue: sourceQueue,
    outcome: 'requires_operator_action',
  })
}

async function alreadyPersisted(env: Env, sourceQueue: SourceQueueName, messageId: string) {
  return env.DB.prepare(
    `SELECT id FROM queue_dead_letters WHERE source_queue = ? AND message_id = ? LIMIT 1`,
  )
    .bind(sourceQueue, messageId)
    .first<{ id: string }>()
}

async function persistDeadLetter(
  env: Env,
  source: DeadLetterSource,
  message: Message<unknown>,
): Promise<void> {
  if (await alreadyPersisted(env, source.sourceQueue, message.id)) return

  const metadata = deadLetterMetadata(source.sourceQueue, message.body)
  const encrypted = await envelopeEncrypt(
    serializeBody(message.body),
    decodeKek(env.KEK),
    KEK_VERSION,
  )
  const now = Date.now()
  await env.DB.prepare(
    `INSERT OR IGNORE INTO queue_dead_letters (
      id, source_queue, dead_letter_queue, message_id, tenant_id, org_id, event_type,
      error_code, status, attempts, payload_iv, payload_ciphertext, payload_tag,
      payload_kek_version, source_enqueued_at, failed_at, replay_count, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'consumer_retries_exhausted', 'pending', ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  )
    .bind(
      createPersistedId('queueDeadLetter'),
      source.sourceQueue,
      source.deadLetterQueue,
      message.id,
      metadata.tenantId,
      metadata.orgId,
      metadata.eventType,
      Math.max(1, message.attempts),
      base64UrlEncode(encrypted.iv),
      base64UrlEncode(encrypted.ciphertext),
      base64UrlEncode(encrypted.tag),
      encrypted.kekVersion,
      message.timestamp.getTime(),
      now,
      now,
      now,
    )
    .run()

  if (!(await alreadyPersisted(env, source.sourceQueue, message.id))) {
    throw new Error('dead_letter_insert_not_observable')
  }
  signalDeadLetterPersisted(env, source.sourceQueue)
}

export async function handleDeadLetterBatch(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  const source = sourceByDeadLetterQueue.get(batch.queue as DeadLetterQueueName)
  if (!source) {
    batch.retryAll()
    return
  }

  for (const message of batch.messages) {
    try {
      await persistDeadLetter(env, source, message)
      message.ack()
    } catch (error) {
      logWorkerError('queue.dead_letter.persistence_failed', error, {
        component: 'queue-dead-letter',
        queue: source.sourceQueue,
        attempt: message.attempts,
      })
      message.retry()
    }
  }
}

function validNotificationMessage(value: unknown): value is EmailQueueMessage {
  return (
    isRecord(value) &&
    typeof value['type'] === 'string' &&
    typeof value['recipient'] === 'string' &&
    isRecord(value['payload'])
  )
}

function validAuditMessage(value: unknown): value is AuditQueueMessage {
  return (
    isRecord(value) &&
    typeof value['tenantId'] === 'string' &&
    typeof value['action'] === 'string' &&
    typeof value['ts'] === 'number' &&
    isRecord(value['payload'])
  )
}

function validWebhookMessage(value: unknown): value is WebhookQueueMessage {
  return (
    isRecord(value) &&
    typeof value['tenantId'] === 'string' &&
    typeof value['event'] === 'string' &&
    isRecord(value['payload'])
  )
}

function validMeteringMessage(value: unknown): value is MeteringQueueEnvelope {
  if (!isRecord(value)) return false
  if (
    typeof value['tenantId'] === 'string' &&
    typeof value['userId'] === 'string' &&
    typeof value['ts'] === 'number'
  ) {
    return true
  }
  if (
    value['type'] === 'stripe_mau_dispatch' &&
    typeof value['period'] === 'string' &&
    (value['cursor'] === undefined || typeof value['cursor'] === 'string') &&
    typeof value['requestedAt'] === 'number'
  ) {
    return true
  }
  return (
    value['type'] === 'stripe_mau_report' &&
    typeof value['tenantId'] === 'string' &&
    typeof value['period'] === 'string' &&
    typeof value['requestedAt'] === 'number'
  )
}

function validScimMessage(value: unknown): value is ScimSyncQueueMessage {
  return (
    isRecord(value) &&
    typeof value['tenantId'] === 'string' &&
    typeof value['orgId'] === 'string' &&
    typeof value['targetId'] === 'string' &&
    typeof value['issuer'] === 'string' &&
    typeof value['runId'] === 'string' &&
    typeof value['requestedAt'] === 'number'
  )
}

function validPrivacyMessage(value: unknown): value is PrivacyQueueMessage {
  return (
    isRecord(value) &&
    typeof value['requestId'] === 'string' &&
    typeof value['tenantId'] === 'string' &&
    typeof value['userId'] === 'string' &&
    (value['operation'] === 'export' || value['operation'] === 'delete') &&
    typeof value['requestedAt'] === 'number'
  )
}

async function sendOriginalMessage(
  env: Env,
  sourceQueue: SourceQueueName,
  body: unknown,
): Promise<void> {
  switch (sourceQueue) {
    case 'xid-email':
      if (!validNotificationMessage(body)) throw new Error('dead_letter_payload_invalid')
      await env.EMAIL_QUEUE.send(body)
      return
    case 'xid-whatsapp':
      if (!validNotificationMessage(body)) throw new Error('dead_letter_payload_invalid')
      await env.WHATSAPP_QUEUE.send(body as WhatsappQueueMessage)
      return
    case 'xid-sms':
      if (!validNotificationMessage(body)) throw new Error('dead_letter_payload_invalid')
      await env.SMS_QUEUE.send(body as SmsQueueMessage)
      return
    case 'xid-audit':
      if (!validAuditMessage(body)) throw new Error('dead_letter_payload_invalid')
      await env.AUDIT_QUEUE.send(body)
      return
    case 'xid-webhook':
      if (!validWebhookMessage(body)) throw new Error('dead_letter_payload_invalid')
      await env.WEBHOOK_QUEUE.send(body)
      return
    case 'xid-metering':
      if (!validMeteringMessage(body)) throw new Error('dead_letter_payload_invalid')
      await env.METERING_QUEUE.send(body)
      return
    case 'xid-scim-sync':
      if (!validScimMessage(body)) throw new Error('dead_letter_payload_invalid')
      await env.SCIM_QUEUE.send(body)
      return
    case 'xid-privacy':
      if (!validPrivacyMessage(body)) throw new Error('dead_letter_payload_invalid')
      await env.PRIVACY_QUEUE.send(body)
  }
}

async function findReplayRow(env: Env, id: string): Promise<ReplayCipherRow | null> {
  return env.DB.prepare(
    `SELECT
       id,
       source_queue AS sourceQueue,
       dead_letter_queue AS deadLetterQueue,
       status,
       payload_iv AS payloadIv,
       payload_ciphertext AS payloadCiphertext,
       payload_tag AS payloadTag,
       payload_kek_version AS payloadKekVersion,
       replay_requested_at AS replayRequestedAt
     FROM queue_dead_letters
     WHERE id = ?
     LIMIT 1`,
  )
    .bind(id)
    .first<ReplayCipherRow>()
}

function replayResult(row: ReplayCipherRow): DeadLetterReplayResult {
  const status =
    row.status === 'replayed' ? 'replayed' : row.status === 'replaying' ? 'replaying' : 'pending'
  return { id: row.id, status, replayed: false, idempotent: status !== 'pending' }
}

async function releaseReplayClaim(
  env: Env,
  id: string,
  claimedAt: number,
  errorCode: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE queue_dead_letters
     SET status = 'pending', last_replay_error_code = ?, updated_at = ?
     WHERE id = ? AND status = 'replaying' AND replay_requested_at = ?`,
  )
    .bind(errorCode, Date.now(), id, claimedAt)
    .run()
}

export async function recoverStaleDeadLetterReplays(
  env: Env,
  now: number = Date.now(),
): Promise<number> {
  const recovered = await env.DB.prepare(
    `UPDATE queue_dead_letters
     SET status = 'pending', last_replay_error_code = 'replay_lease_expired', updated_at = ?
     WHERE status = 'replaying'
       AND (replay_requested_at IS NULL OR replay_requested_at <= ?)`,
  )
    .bind(now, now - DEAD_LETTER_REPLAY_LEASE_MS)
    .run()
  return recovered.meta.changes ?? 0
}

export async function replayDeadLetter(
  env: Env,
  id: string,
  actorId: string,
  prepareAudit: DeadLetterReplayAuditFactory,
): Promise<DeadLetterReplayResult | null> {
  const current = await findReplayRow(env, id)
  if (!current) return null
  if (current.status === 'replayed') return replayResult(current)

  const claimedAt = Date.now()
  const staleBefore = claimedAt - DEAD_LETTER_REPLAY_LEASE_MS
  const staleClaim =
    current.status === 'replaying' &&
    (current.replayRequestedAt === null || current.replayRequestedAt <= staleBefore)
  if (current.status !== 'pending' && !staleClaim) return replayResult(current)
  const claimed = await env.DB.prepare(
    `UPDATE queue_dead_letters
     SET status = 'replaying', replay_requested_at = ?, replayed_by = ?,
         last_replay_error_code = NULL, updated_at = ?
     WHERE id = ?
       AND (
         status = 'pending'
         OR (
           status = 'replaying'
           AND (replay_requested_at IS NULL OR replay_requested_at <= ?)
         )
       )`,
  )
    .bind(claimedAt, actorId, claimedAt, id, staleBefore)
    .run()
  if (claimed.meta.changes !== 1) {
    const raced = await findReplayRow(env, id)
    return raced ? replayResult(raced) : null
  }

  const source = sourceByDeadLetterQueue.get(current.deadLetterQueue)
  if (!source || source.sourceQueue !== current.sourceQueue) {
    await releaseReplayClaim(env, id, claimedAt, 'source_queue_mapping_invalid')
    throw new Error('source_queue_mapping_invalid')
  }

  try {
    const plaintext = await envelopeDecrypt(
      {
        iv: base64UrlDecode(current.payloadIv),
        ciphertext: base64UrlDecode(current.payloadCiphertext),
        tag: base64UrlDecode(current.payloadTag),
        kekVersion: current.payloadKekVersion,
      },
      decodeKek(env.KEK),
    )
    const body: unknown = JSON.parse(new TextDecoder().decode(plaintext))
    await sendOriginalMessage(env, current.sourceQueue, body)
  } catch (error) {
    try {
      await releaseReplayClaim(env, id, claimedAt, 'source_replay_failed')
    } catch (releaseError) {
      logWorkerError('queue.dead_letter.replay_claim_release_failed', releaseError, {
        component: 'queue-dead-letter',
        queue: current.sourceQueue,
        outcome: 'requires_operator_action',
      })
      throw releaseError
    }
    logWorkerError('queue.dead_letter.replay_failed', error, {
      component: 'queue-dead-letter',
      queue: current.sourceQueue,
      outcome: 'claim_released',
    })
    throw error
  }

  const audit = prepareAudit(claimedAt)
  const completedAt = Date.now()
  // The source Queue has already accepted the replay. Persist its audit outbox row and the
  // replayed state together so a crash can leave only a recoverable replay lease, never an
  // unaudited completed replay.
  const [auditResult, completed] = await env.DB.batch([
    audit.statement,
    env.DB.prepare(
      `UPDATE queue_dead_letters
       SET status = 'replayed', replayed_at = ?, replay_count = replay_count + 1,
           last_replay_error_code = NULL, updated_at = ?
       WHERE id = ? AND status = 'replaying' AND replay_requested_at = ?
         AND ${audit.mutationGate.sql}`,
    ).bind(completedAt, completedAt, id, claimedAt, ...audit.mutationGate.bindings),
  ])
  if (auditResult?.meta.changes !== 1 || completed?.meta.changes !== 1) {
    throw new Error('dead_letter_replay_completion_not_observable')
  }

  return { id, status: 'replayed', replayed: true, idempotent: false }
}
