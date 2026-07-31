import type { PrivacyQueueMessage } from '@xid-kit/types'
import { logWorkerError, logWorkerWarning } from '../lib/safe-log'
import { PRIVACY_PROCESSING_LEASE_MS, type PrivacyRequestStatus } from '../privacy/constants'
import { completePrivacyErasure } from '../privacy/erasure'
import { completePrivacyExport } from '../privacy/export'

const DUPLICATE_RETRY_DELAY_SECONDS = 180

type PrivacyStateRow = {
  status: PrivacyRequestStatus
  processingStartedAt: number | null
}

type ClaimResult = 'claimed' | 'retry_later' | 'terminal'

function validMessage(value: unknown): value is PrivacyQueueMessage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return (
    typeof row['requestId'] === 'string' &&
    row['requestId'].length > 0 &&
    typeof row['tenantId'] === 'string' &&
    row['tenantId'].length > 0 &&
    typeof row['userId'] === 'string' &&
    row['userId'].length > 0 &&
    (row['operation'] === 'export' || row['operation'] === 'delete') &&
    typeof row['requestedAt'] === 'number' &&
    Number.isFinite(row['requestedAt'])
  )
}

async function claimRequest(
  env: Env,
  message: PrivacyQueueMessage,
  now: number,
): Promise<ClaimResult> {
  const result = await env.DB.prepare(
    `UPDATE privacy_requests
        SET status = 'processing', processing_started_at = ?, error_code = NULL, updated_at = ?
      WHERE id = ? AND tenant_id = ? AND user_id = ? AND request_type = ?
        AND (
          status = 'pending'
          OR (
            status = 'processing'
            AND processing_started_at IS NOT NULL
            AND processing_started_at <= ?
          )
        )`,
  )
    .bind(
      now,
      now,
      message.requestId,
      message.tenantId,
      message.userId,
      message.operation,
      now - PRIVACY_PROCESSING_LEASE_MS,
    )
    .run()
  if ((result.meta.changes ?? 0) === 1) return 'claimed'

  const row = await env.DB.prepare(
    `SELECT status, processing_started_at AS processingStartedAt
       FROM privacy_requests
      WHERE id = ? AND tenant_id = ? AND user_id = ? AND request_type = ?
      LIMIT 1`,
  )
    .bind(message.requestId, message.tenantId, message.userId, message.operation)
    .first<PrivacyStateRow>()
  if (!row || row.status !== 'processing') return 'terminal'
  return 'retry_later'
}

async function releaseClaim(
  env: Env,
  message: PrivacyQueueMessage,
  claimedAt: number,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE privacy_requests
        SET status = 'pending', processing_started_at = NULL, error_code = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ? AND user_id = ? AND request_type = ?
        AND status = 'processing' AND processing_started_at = ?`,
  )
    .bind(
      message.operation === 'export' ? 'privacy_export_failed' : 'privacy_erasure_failed',
      Date.now(),
      message.requestId,
      message.tenantId,
      message.userId,
      message.operation,
      claimedAt,
    )
    .run()
}

async function processMessage(message: Message<PrivacyQueueMessage>, env: Env): Promise<void> {
  if (!validMessage(message.body)) {
    logWorkerWarning('privacy.queue.invalid_message', {
      component: 'privacy-queue',
      outcome: 'retry_to_dead_letter',
    })
    message.retry()
    return
  }

  const claimedAt = Date.now()
  try {
    const claim = await claimRequest(env, message.body, claimedAt)
    if (claim === 'terminal') {
      message.ack()
      return
    }
    if (claim === 'retry_later') {
      message.retry({ delaySeconds: DUPLICATE_RETRY_DELAY_SECONDS })
      return
    }

    if (message.body.operation === 'export') {
      await completePrivacyExport(env, { ...message.body, now: claimedAt })
    } else {
      await completePrivacyErasure(env, { ...message.body, now: claimedAt })
    }
    message.ack()
  } catch (error) {
    try {
      await releaseClaim(env, message.body, claimedAt)
    } catch (stateError) {
      logWorkerError('privacy.queue.release_claim_failed', stateError, {
        component: 'privacy-queue',
        operation: message.body.operation,
        outcome: 'stale_lease_recovery_required',
      })
    }
    logWorkerError('privacy.queue.processing_failed', error, {
      component: 'privacy-queue',
      operation: message.body.operation,
      outcome: 'retry',
    })
    message.retry()
  }
}

export async function handlePrivacyBatch(
  batch: MessageBatch<PrivacyQueueMessage>,
  env: Env,
): Promise<void> {
  for (const message of batch.messages) {
    await processMessage(message, env)
  }
}
