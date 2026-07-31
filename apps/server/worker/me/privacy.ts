import type { PrivacyQueueMessage } from '@xid-kit/types'
import { Hono } from 'hono'
import * as v from 'valibot'
import { AppError } from '../lib/errors'
import { createPersistedId } from '../lib/persisted-id'
import { logWorkerError } from '../lib/safe-log'
import type { XidHonoEnv } from '../lib/types'
import { readJsonBody, validateBody } from '../lib/validate'
import {
  PRIVACY_DELETE_GRACE_MS,
  type PrivacyRequestRow,
  type PrivacyRequestType,
} from '../privacy/constants'
import {
  PRIVACY_ERASURE_ELIGIBLE_SQL,
  privacyErasureEligibilityBindings,
  requirePrivacyErasureEligibility,
} from '../privacy/erasure-eligibility'
import { requireSession, toIso } from './shared'

const createPrivacyRequestSchema = v.object({
  type: v.picklist(['export', 'delete']),
  confirmation: v.optional(v.string()),
})

const DELETE_CONFIRMATION = 'DELETE'

const PRIVACY_REQUEST_ELIGIBLE_SQL = `EXISTS (
  SELECT 1
    FROM users u
   WHERE u.tenant_id = ?
     AND u.id = ?
     AND u.status = 'active'
     AND u.deleted_at IS NULL
     AND (
       u.is_new_user = 0
       OR EXISTS (
         SELECT 1
          FROM memberships m
         WHERE m.tenant_id = u.tenant_id
            AND m.user_id = u.id
       )
     )
)`

type PrivacyRequestView = {
  id: string
  type: PrivacyRequestType
  status: PrivacyRequestRow['status']
  availableAt: string | null
  expiresAt: string | null
  scheduledFor: string | null
  completedAt: string | null
  canceledAt: string | null
  errorCode: string | null
  downloadUrl: string | null
  createdAt: string
  updatedAt: string
}

function timestampToIso(value: number | null): string | null {
  return value === null ? null : toIso(new Date(value))
}

function toPrivacyRequestView(
  row: PrivacyRequestRow,
  now: number = Date.now(),
): PrivacyRequestView {
  const downloadable =
    row.requestType === 'export' &&
    row.status === 'completed' &&
    row.storageKey !== null &&
    row.availableAt !== null &&
    row.availableAt <= now &&
    row.expiresAt !== null &&
    row.expiresAt > now
  return {
    id: row.id,
    type: row.requestType,
    status: row.status,
    availableAt: timestampToIso(row.availableAt),
    expiresAt: timestampToIso(row.expiresAt),
    scheduledFor: timestampToIso(row.scheduledFor),
    completedAt: timestampToIso(row.completedAt),
    canceledAt: timestampToIso(row.canceledAt),
    errorCode: row.errorCode,
    downloadUrl: downloadable ? `/v1/me/privacy/requests/${row.id}/download` : null,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  }
}

const PRIVACY_SELECT = `SELECT id,
  tenant_id AS tenantId,
  user_id AS userId,
  request_type AS requestType,
  status,
  storage_key AS storageKey,
  content_type AS contentType,
  available_at AS availableAt,
  expires_at AS expiresAt,
  scheduled_for AS scheduledFor,
  processing_started_at AS processingStartedAt,
  completed_at AS completedAt,
  canceled_at AS canceledAt,
  error_code AS errorCode,
  created_at AS createdAt,
  updated_at AS updatedAt
FROM privacy_requests`

async function findRequest(
  env: Env,
  tenantId: string,
  userId: string,
  requestId: string,
): Promise<PrivacyRequestRow | null> {
  return env.DB.prepare(
    `${PRIVACY_SELECT}
      WHERE id = ? AND tenant_id = ? AND user_id = ?
      LIMIT 1`,
  )
    .bind(requestId, tenantId, userId)
    .first<PrivacyRequestRow>()
}

function queueMessage(row: PrivacyRequestRow): PrivacyQueueMessage {
  return {
    requestId: row.id,
    tenantId: row.tenantId,
    userId: row.userId,
    operation: row.requestType,
    requestedAt: row.createdAt,
  }
}

async function requirePrivacyRequestEligibility(
  env: Env,
  tenantId: string,
  userId: string,
): Promise<void> {
  const row = await env.DB.prepare(
    `SELECT CASE WHEN (${PRIVACY_REQUEST_ELIGIBLE_SQL}) THEN 1 ELSE 0 END AS eligible`,
  )
    .bind(tenantId, userId)
    .first<{ eligible: number }>()
  if (row?.eligible !== 1) throw new AppError('conflict', { httpStatus: 409 })
}

async function enqueueExport(env: Env, row: PrivacyRequestRow): Promise<void> {
  try {
    await env.PRIVACY_QUEUE.send(queueMessage(row))
  } catch (error) {
    // The pending D1 row is the durable recovery source. Daily Cron retries the same request id.
    logWorkerError('privacy.request.queue_send_failed', error, {
      component: 'privacy-request',
      operation: row.requestType,
      outcome: 'daily_recovery_required',
    })
  }
}

const app = new Hono<XidHonoEnv>()

app.get('/requests', async (c) => {
  const session = await requireSession(c)
  const tenantId = c.get('tenant').tenantId
  const rows = (
    await c.env.DB.prepare(
      `${PRIVACY_SELECT}
        WHERE tenant_id = ? AND user_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 100`,
    )
      .bind(tenantId, session.userId)
      .all<PrivacyRequestRow>()
  ).results
  return c.json(rows.map((row) => toPrivacyRequestView(row)))
})

app.post('/requests', async (c) => {
  const session = await requireSession(c)
  const tenantId = c.get('tenant').tenantId
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(createPrivacyRequestSchema, json.value)
  if (body.type === 'delete' && body.confirmation !== DELETE_CONFIRMATION) {
    throw new AppError('validation_failed', {
      httpStatus: 422,
      meta: { paramName: 'confirmation' },
    })
  }
  const now = Date.now()
  const id = createPersistedId('privacyRequest')
  const scheduledFor = body.type === 'delete' ? now + PRIVACY_DELETE_GRACE_MS : now
  await requirePrivacyRequestEligibility(c.env, tenantId, session.userId)
  if (body.type === 'delete') {
    await requirePrivacyErasureEligibility(c.env, tenantId, session.userId)
  }

  const inserted = await c.env.DB.prepare(
    `INSERT INTO privacy_requests (
       id, tenant_id, user_id, request_type, status, storage_key, content_type, available_at,
       expires_at, scheduled_for, processing_started_at, completed_at, canceled_at, error_code,
       created_at, updated_at
     )
     SELECT ?, ?, ?, ?, 'pending', NULL, NULL, NULL, NULL, ?, NULL, NULL, NULL, NULL, ?, ?
      WHERE (${PRIVACY_REQUEST_ELIGIBLE_SQL})
        AND (? <> 'delete' OR (${PRIVACY_ERASURE_ELIGIBLE_SQL}))
        AND NOT EXISTS (
        SELECT 1 FROM privacy_requests
         WHERE tenant_id = ? AND user_id = ? AND request_type = ?
           AND status IN ('pending', 'processing')
      )`,
  )
    .bind(
      id,
      tenantId,
      session.userId,
      body.type,
      scheduledFor,
      now,
      now,
      tenantId,
      session.userId,
      body.type,
      ...privacyErasureEligibilityBindings(tenantId, session.userId),
      tenantId,
      session.userId,
      body.type,
    )
    .run()

  let row: PrivacyRequestRow | null
  if ((inserted.meta.changes ?? 0) === 1) {
    row = await findRequest(c.env, tenantId, session.userId, id)
  } else {
    // Recheck both guards after the conditional INSERT. This closes onboarding and role races:
    // the loser cannot create a request under the superseded Tenant or expose role details.
    await requirePrivacyRequestEligibility(c.env, tenantId, session.userId)
    if (body.type === 'delete') {
      await requirePrivacyErasureEligibility(c.env, tenantId, session.userId)
    }
    row = await c.env.DB.prepare(
      `${PRIVACY_SELECT}
        WHERE tenant_id = ? AND user_id = ? AND request_type = ?
          AND status IN ('pending', 'processing')
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
    )
      .bind(tenantId, session.userId, body.type)
      .first<PrivacyRequestRow>()
  }
  if (!row) throw new AppError('server_error')
  if (row.requestType === 'export' && row.status === 'pending') {
    await enqueueExport(c.env, row)
  }
  return c.json(toPrivacyRequestView(row), 202)
})

app.get('/requests/:id', async (c) => {
  const session = await requireSession(c)
  const tenantId = c.get('tenant').tenantId
  const row = await findRequest(c.env, tenantId, session.userId, c.req.param('id'))
  if (!row) throw new AppError('not_found', { httpStatus: 404 })
  return c.json(toPrivacyRequestView(row))
})

app.post('/requests/:id/cancel', async (c) => {
  const session = await requireSession(c)
  const tenantId = c.get('tenant').tenantId
  const requestId = c.req.param('id')
  const now = Date.now()
  const result = await c.env.DB.prepare(
    `UPDATE privacy_requests
        SET status = 'canceled', canceled_at = ?, processing_started_at = NULL,
            error_code = NULL, updated_at = ?
      WHERE id = ? AND tenant_id = ? AND user_id = ? AND status = 'pending'`,
  )
    .bind(now, now, requestId, tenantId, session.userId)
    .run()
  if ((result.meta.changes ?? 0) !== 1) {
    const existing = await findRequest(c.env, tenantId, session.userId, requestId)
    if (!existing) throw new AppError('not_found', { httpStatus: 404 })
    if (existing.status !== 'canceled') {
      throw new AppError('conflict', { httpStatus: 409 })
    }
  }
  const row = await findRequest(c.env, tenantId, session.userId, requestId)
  if (!row) throw new AppError('not_found', { httpStatus: 404 })
  return c.json(toPrivacyRequestView(row))
})

app.get('/requests/:id/download', async (c) => {
  const session = await requireSession(c)
  const tenantId = c.get('tenant').tenantId
  const row = await findRequest(c.env, tenantId, session.userId, c.req.param('id'))
  if (!row) throw new AppError('not_found', { httpStatus: 404 })
  const now = Date.now()
  if (
    row.requestType !== 'export' ||
    row.status !== 'completed' ||
    row.storageKey === null ||
    row.availableAt === null ||
    row.availableAt > now ||
    row.expiresAt === null ||
    row.expiresAt <= now
  ) {
    throw new AppError('not_found', { httpStatus: 404 })
  }

  const object = await c.env.STORAGE.get(row.storageKey)
  if (!object) throw new AppError('not_found', { httpStatus: 404 })
  const headers = new Headers({
    'cache-control': 'private, no-store',
    'content-disposition': `attachment; filename="xid-data-export-${row.id}.json"`,
    'content-security-policy': "default-src 'none'; sandbox",
    'content-type': row.contentType ?? 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
  })
  if (object.size > 0) headers.set('content-length', String(object.size))
  return new Response(object.body, { headers })
})

export function registerPrivacyRoutes(honoApp: Hono<XidHonoEnv>): void {
  honoApp.route('/v1/me/privacy', app)
}
