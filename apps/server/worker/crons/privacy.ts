import type { PrivacyQueueMessage } from '@xid-kit/types'
import { logWorkerError, logWorkerWarning } from '../lib/safe-log'
import {
  PRIVACY_PAGE_SIZE,
  PRIVACY_PROCESSING_LEASE_MS,
  type PrivacyRequestType,
} from '../privacy/constants'

const PRIVACY_REDELIVERY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
const PRIVACY_RETRIES_EXHAUSTED = 'privacy_retries_exhausted'

type DuePrivacyRequestRow = {
  id: string
  tenantId: string
  userId: string
  requestType: PrivacyRequestType
  createdAt: number
  isExhausted: number
}

type ExpiredExportRow = {
  id: string
  tenantId: string
  userId: string
  storageKey: string
}

function toQueueMessage(row: DuePrivacyRequestRow): PrivacyQueueMessage {
  return {
    requestId: row.id,
    tenantId: row.tenantId,
    userId: row.userId,
    operation: row.requestType,
    requestedAt: row.createdAt,
  }
}

async function markRedeliveryExhausted(
  env: Env,
  row: DuePrivacyRequestRow,
  now: number,
): Promise<void> {
  try {
    const result = await env.DB.prepare(
      `UPDATE privacy_requests
          SET status = 'pending', processing_started_at = NULL, error_code = ?, updated_at = ?
        WHERE id = ? AND tenant_id = ? AND user_id = ?
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
        PRIVACY_RETRIES_EXHAUSTED,
        now,
        row.id,
        row.tenantId,
        row.userId,
        now - PRIVACY_PROCESSING_LEASE_MS,
      )
      .run()
    if ((result.meta.changes ?? 0) !== 1) return
    logWorkerWarning('privacy.cron.redelivery_exhausted', {
      component: 'privacy-cron',
      operation: row.requestType,
      outcome: 'operator_action_required',
    })
  } catch (error) {
    logWorkerError('privacy.cron.exhausted_state_write_failed', error, {
      component: 'privacy-cron',
      operation: row.requestType,
    })
  }
}

export async function enqueueDuePrivacyRequests(env: Env, now: number = Date.now()): Promise<void> {
  const redeliveryCutoff = now - PRIVACY_REDELIVERY_WINDOW_MS
  let cursor = ''
  while (true) {
    const rows = (
      await env.DB.prepare(
        `SELECT id, tenant_id AS tenantId, user_id AS userId, request_type AS requestType,
                created_at AS createdAt,
                CASE
                  WHEN (
                    status = 'processing'
                    OR error_code IN ('privacy_export_failed', 'privacy_erasure_failed')
                  )
                  AND (
                    (request_type = 'export' AND created_at <= ?)
                    OR (request_type = 'delete' AND scheduled_for IS NOT NULL AND scheduled_for <= ?)
                  )
                  THEN 1
                  ELSE 0
                END AS isExhausted
           FROM privacy_requests
          WHERE id > ?
            AND (error_code IS NULL OR error_code <> ?)
            AND (
              (
                status = 'pending'
                AND (
                  request_type = 'export'
                  OR (request_type = 'delete' AND scheduled_for IS NOT NULL AND scheduled_for <= ?)
                )
              )
              OR (
                status = 'processing'
                AND processing_started_at IS NOT NULL
                AND processing_started_at <= ?
              )
            )
          ORDER BY id
          LIMIT ?`,
      )
        .bind(
          redeliveryCutoff,
          redeliveryCutoff,
          cursor,
          PRIVACY_RETRIES_EXHAUSTED,
          now,
          now - PRIVACY_PROCESSING_LEASE_MS,
          PRIVACY_PAGE_SIZE,
        )
        .all<DuePrivacyRequestRow>()
    ).results
    if (rows.length === 0) return

    for (const row of rows) {
      if (row.isExhausted === 1) {
        await markRedeliveryExhausted(env, row, now)
        continue
      }
      try {
        await env.PRIVACY_QUEUE.send(toQueueMessage(row))
      } catch (error) {
        logWorkerError('privacy.cron.queue_send_failed', error, {
          component: 'privacy-cron',
          operation: row.requestType,
          outcome: 'retry_next_daily_cron',
        })
        try {
          await env.DB.prepare(
            `UPDATE privacy_requests
                SET error_code = 'privacy_queue_send_failed', updated_at = ?
              WHERE id = ? AND tenant_id = ? AND user_id = ?
                AND status IN ('pending', 'processing')`,
          )
            .bind(now, row.id, row.tenantId, row.userId)
            .run()
        } catch (stateError) {
          logWorkerError('privacy.cron.queue_failure_state_write_failed', stateError, {
            component: 'privacy-cron',
            operation: row.requestType,
          })
        }
      }
    }

    cursor = rows[rows.length - 1]?.id ?? cursor
    if (rows.length < PRIVACY_PAGE_SIZE) return
  }
}

export async function expirePrivacyExports(env: Env, now: number = Date.now()): Promise<void> {
  let cursor = ''
  while (true) {
    const rows = (
      await env.DB.prepare(
        `SELECT id, tenant_id AS tenantId, user_id AS userId, storage_key AS storageKey
          FROM privacy_requests
          WHERE request_type = 'export' AND status = 'completed'
            AND expires_at IS NOT NULL AND expires_at <= ? AND storage_key IS NOT NULL
            AND id > ?
          ORDER BY id
          LIMIT ?`,
      )
        .bind(now, cursor, PRIVACY_PAGE_SIZE)
        .all<ExpiredExportRow>()
    ).results
    if (rows.length === 0) return

    for (const row of rows) {
      try {
        await env.STORAGE.delete(row.storageKey)
        await env.DB.prepare(
          `UPDATE privacy_requests
              SET status = 'expired', storage_key = NULL, content_type = NULL, available_at = NULL,
                  error_code = NULL, updated_at = ?
            WHERE id = ? AND tenant_id = ? AND user_id = ? AND request_type = 'export'
              AND status = 'completed' AND expires_at <= ?`,
        )
          .bind(now, row.id, row.tenantId, row.userId, now)
          .run()
      } catch (error) {
        logWorkerError('privacy.cron.export_expiry_failed', error, {
          component: 'privacy-cron',
          outcome: 'retry_next_daily_cron',
        })
      }
    }

    cursor = rows[rows.length - 1]?.id ?? cursor
    if (rows.length < PRIVACY_PAGE_SIZE) return
    logWorkerWarning('privacy.cron.export_expiry_batch_full', {
      component: 'privacy-cron',
      outcome: 'continue_current_run',
    })
  }
}
