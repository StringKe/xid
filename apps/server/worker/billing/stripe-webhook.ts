import { Hono } from 'hono'
import {
  parseStripeEvent,
  requireUsageBilling,
  verifyStripeWebhookSignature,
  type StripeEvent,
} from './stripe-client'
import { deriveStripeSubscriptionMutation, type StripeSubscriptionMutation } from './stripe-events'
import {
  billingAccountStatement,
  subscriptionAuditPayload,
  subscriptionAuditStatement,
  subscriptionUpsertStatement,
  type StripeTarget,
} from './stripe-subscription-state'
import { AppError } from '../lib/errors'
import { createPersistedId } from '../lib/persisted-id'
import { logWorkerError, logWorkerWarning } from '../lib/safe-log'
import type { XidHonoEnv } from '../lib/types'
import { enqueuePersistedPlatformAudit } from '../platform/audit-outbox'

const app = new Hono<XidHonoEnv>()
export const STRIPE_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024

type ExistingWebhookEvent = {
  eventType: string
  eventCreated: number
  status: string
}

type BillingAccountRow = {
  tenantId: string
  customerId: string | null
}

export async function readStripeWebhookBody(request: Request): Promise<Uint8Array> {
  const declaredLength = request.headers.get('content-length')
  if (declaredLength !== null && /^\d+$/u.test(declaredLength)) {
    const parsedLength = Number(declaredLength)
    if (!Number.isSafeInteger(parsedLength) || parsedLength > STRIPE_WEBHOOK_MAX_BODY_BYTES) {
      throw new AppError('invalid_request', { httpStatus: 413 })
    }
  }

  if (!request.body) return new Uint8Array()
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > STRIPE_WEBHOOK_MAX_BODY_BYTES) {
        await reader.cancel()
        throw new AppError('invalid_request', { httpStatus: 413 })
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

function decodeStripeWebhookBody(rawBody: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(rawBody)
  } catch (cause) {
    throw new AppError('invalid_request', { httpStatus: 400, cause })
  }
}

async function existingEvent(env: Env, event: StripeEvent): Promise<ExistingWebhookEvent | null> {
  const row = await env.DB.prepare(
    `SELECT event_type AS eventType, event_created AS eventCreated, status
     FROM stripe_webhook_events
     WHERE event_id = ?
     LIMIT 1`,
  )
    .bind(event.id)
    .first<ExistingWebhookEvent>()
  if (!row) return null
  if (row.eventType !== event.type || row.eventCreated !== event.created) {
    logWorkerWarning('billing.stripe_event_identity_mismatch', {
      component: 'stripe-webhook',
      outcome: 'rejected',
    })
    throw new AppError('invalid_request', { httpStatus: 400 })
  }
  return row
}

async function loadAccountByCustomer(
  env: Env,
  customerId: string,
): Promise<BillingAccountRow | null> {
  return env.DB.prepare(
    `SELECT tenant_id AS tenantId, external_customer_id AS customerId
     FROM organization_plans
     WHERE external_customer_id = ?
     LIMIT 1`,
  )
    .bind(customerId)
    .first<BillingAccountRow>()
}

async function loadAccountByTenant(env: Env, tenantId: string): Promise<BillingAccountRow | null> {
  return env.DB.prepare(
    `SELECT tenant_id AS tenantId, external_customer_id AS customerId
     FROM organization_plans
     WHERE tenant_id = ?
     LIMIT 1`,
  )
    .bind(tenantId)
    .first<BillingAccountRow>()
}

async function isTopLevelTenant(env: Env, tenantId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT id
     FROM organizations
     WHERE id = ? AND tenant_id = ? AND parent_org_id IS NULL
     LIMIT 1`,
  )
    .bind(tenantId, tenantId)
    .first<{ id: string }>()
  return row !== null
}

// 返回 null 表示事件不属于 XID:同一 Stripe 账户里其他产品的订阅既没有 xid_tenant_id,
// customer 也没有绑定任何租户。
async function resolveTarget(
  env: Env,
  mutation: StripeSubscriptionMutation,
): Promise<StripeTarget | null> {
  const [customerAccount, hintedAccount, tenantExists] = await Promise.all([
    loadAccountByCustomer(env, mutation.customerId),
    mutation.tenantHint ? loadAccountByTenant(env, mutation.tenantHint) : Promise.resolve(null),
    mutation.tenantHint ? isTopLevelTenant(env, mutation.tenantHint) : Promise.resolve(false),
  ])

  if (!mutation.tenantHint && !customerAccount) return null
  if (mutation.tenantHint && !tenantExists) {
    throw new Error('stripe_tenant_hint_unknown')
  }
  if (customerAccount && mutation.tenantHint && customerAccount.tenantId !== mutation.tenantHint) {
    throw new Error('stripe_customer_tenant_mismatch')
  }

  const tenantId = customerAccount?.tenantId ?? mutation.tenantHint
  if (!tenantId) throw new Error('stripe_tenant_unresolved')
  const current = customerAccount ?? hintedAccount
  if (current?.customerId && current.customerId !== mutation.customerId) {
    throw new Error('stripe_tenant_customer_mismatch')
  }
  return { tenantId, customerId: mutation.customerId }
}

async function recordIgnoredEvent(env: Env, event: StripeEvent, now: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO stripe_webhook_events (
       event_id, event_type, tenant_id, event_created, status, error_code,
       processed_at, created_at, updated_at
     ) VALUES (?, ?, NULL, ?, 'ignored', NULL, ?, ?, ?)
     ON CONFLICT (event_id) DO NOTHING`,
  )
    .bind(event.id, event.type, event.created, now, now, now)
    .run()
}

async function recordFailedEvent(
  env: Env,
  event: StripeEvent,
  errorCode: string,
  now: number,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO stripe_webhook_events (
       event_id, event_type, tenant_id, event_created, status, error_code,
       processed_at, created_at, updated_at
     ) VALUES (?, ?, NULL, ?, 'failed', ?, NULL, ?, ?)
     ON CONFLICT (event_id) DO UPDATE SET
       status = 'failed', error_code = excluded.error_code, updated_at = excluded.updated_at
     WHERE stripe_webhook_events.status = 'failed'`,
  )
    .bind(event.id, event.type, event.created, errorCode, now, now)
    .run()
}

async function resolveOrFail(
  env: Env,
  event: StripeEvent,
  mutation: StripeSubscriptionMutation,
  now: number,
): Promise<StripeTarget | null> {
  try {
    return await resolveTarget(env, mutation)
  } catch (cause) {
    await recordFailedEvent(env, event, 'target_resolution_failed', now)
    logWorkerError('billing.stripe_target_resolution_failed', cause, {
      component: 'stripe-webhook',
      operation: event.type,
      outcome: 'provider_retry_required',
    })
    throw new AppError('service_unavailable', { httpStatus: 503, cause })
  }
}

export async function applyStripeEvent(env: Env, event: StripeEvent): Promise<void> {
  const prior = await existingEvent(env, event)
  if (prior?.status === 'processed' || prior?.status === 'ignored') return

  const mutation = deriveStripeSubscriptionMutation(event)
  const now = Date.now()
  if (!mutation) {
    await recordIgnoredEvent(env, event, now)
    return
  }

  const target = await resolveOrFail(env, event, mutation, now)
  if (!target) {
    await recordIgnoredEvent(env, event, now)
    logWorkerWarning('billing.stripe_event_not_bound', {
      component: 'stripe-webhook',
      operation: event.type,
      outcome: 'ignored',
    })
    return
  }

  const auditId = createPersistedId('platformAudit')
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO stripe_webhook_events (
         event_id, event_type, tenant_id, event_created, status, error_code,
         processed_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'pending', NULL, NULL, ?, ?)
       ON CONFLICT (event_id) DO UPDATE SET
         status = 'pending', error_code = NULL, updated_at = excluded.updated_at
       WHERE stripe_webhook_events.status = 'failed'`,
    ).bind(event.id, event.type, target.tenantId, event.created, now, now),
    subscriptionUpsertStatement(env, { event, mutation, tenantId: target.tenantId, now }),
    billingAccountStatement(env, { event, mutation, target, now }),
    subscriptionAuditStatement(env, { event, mutation, target, auditId, now }),
    env.DB.prepare(
      `UPDATE stripe_webhook_events
       SET tenant_id = ?, status = 'processed', error_code = NULL,
           processed_at = ?, updated_at = ?
       WHERE event_id = ? AND status = 'pending'`,
    ).bind(target.tenantId, now, now, event.id),
  ])

  const auditExists = await env.DB.prepare(
    `SELECT id FROM platform_audit_outbox WHERE id = ? LIMIT 1`,
  )
    .bind(auditId)
    .first<{ id: string }>()
  if (auditExists) {
    await enqueuePersistedPlatformAudit(env, {
      id: auditId,
      input: {
        id: auditId,
        tenantId: target.tenantId,
        action: mutation.auditAction,
        actorId: 'system',
        payload: subscriptionAuditPayload(event, mutation, target),
        ts: now,
      },
    })
  }
}

app.post('/', async (c) => {
  const rawBody = await readStripeWebhookBody(c.req.raw)
  const signature = c.req.header('stripe-signature')
  if (!signature) throw new AppError('invalid_request', { httpStatus: 400 })
  const valid = await verifyStripeWebhookSignature(
    rawBody,
    signature,
    requireUsageBilling(c.env).webhookSecret,
  )
  if (!valid) throw new AppError('invalid_request', { httpStatus: 400 })
  await applyStripeEvent(c.env, parseStripeEvent(decodeStripeWebhookBody(rawBody)))
  return c.json({ received: true })
})

export function registerStripeWebhookRoutes(parent: Hono<XidHonoEnv>): void {
  parent.route('/v1/billing/stripe/webhook', app)
}
