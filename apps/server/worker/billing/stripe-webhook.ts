import { Hono } from 'hono'
import {
  parseStripeEvent,
  requireUsageBilling,
  verifyStripeWebhookSignature,
  type StripeEvent,
} from './stripe-client'
import { deriveStripeSubscriptionMutation, type StripeSubscriptionMutation } from './stripe-events'
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

type StripeTarget = {
  tenantId: string
  status: StripeSubscriptionMutation['status']
  customerId: string
}

function eventPriority(eventType: string): number {
  if (eventType === 'customer.subscription.deleted') return 40
  if (
    eventType === 'customer.subscription.created' ||
    eventType === 'customer.subscription.updated'
  ) {
    return 30
  }
  return 0
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
  return {
    tenantId,
    status: mutation.status,
    customerId: mutation.customerId,
  }
}

function newerProcessedEventPredicate(): string {
  return `NOT EXISTS (
    SELECT 1
    FROM stripe_webhook_events AS newer
    WHERE newer.tenant_id = ?
      AND newer.status = 'processed'
      AND (
        newer.event_created > ?
        OR (
          newer.event_created = ?
          AND (
            CASE newer.event_type
              WHEN 'customer.subscription.deleted' THEN 40
              WHEN 'customer.subscription.created' THEN 30
              WHEN 'customer.subscription.updated' THEN 30
              WHEN 'invoice.paid' THEN 20
              WHEN 'invoice.payment_failed' THEN 20
              WHEN 'checkout.session.completed' THEN 10
              ELSE 0
            END > ?
            OR (
              CASE newer.event_type
                WHEN 'customer.subscription.deleted' THEN 40
                WHEN 'customer.subscription.created' THEN 30
                WHEN 'customer.subscription.updated' THEN 30
                WHEN 'invoice.paid' THEN 20
                WHEN 'invoice.payment_failed' THEN 20
                WHEN 'checkout.session.completed' THEN 10
                ELSE 0
              END = ?
              AND newer.event_id > ?
            )
          )
        )
      )
  )`
}

function pendingEventPredicate(): string {
  return `EXISTS (
    SELECT 1
    FROM stripe_webhook_events AS current_event
    WHERE current_event.event_id = ? AND current_event.status = 'pending'
  )`
}

function orderedMutationBindings(
  event: StripeEvent,
  tenantId: string,
): readonly (string | number)[] {
  const priority = eventPriority(event.type)
  return [event.id, tenantId, event.created, event.created, priority, priority, event.id] as const
}

// organization_plans 是计费账户表(表名沿用);plan 列已停用,插入时由列默认值补齐。
function conditionalBillingAccountStatement(
  env: Env,
  event: StripeEvent,
  target: StripeTarget,
  now: number,
): D1PreparedStatement {
  const canApply = `${pendingEventPredicate()} AND ${newerProcessedEventPredicate()}`
  return env.DB.prepare(
    `INSERT INTO organization_plans (
       tenant_id, status, source, external_customer_id, trial_ends_at,
       effective_at, updated_by, created_at, updated_at
     )
     SELECT ?, ?, 'stripe', ?, NULL, ?, NULL, ?, ?
     WHERE ${canApply}
     ON CONFLICT (tenant_id) DO UPDATE SET
       status = excluded.status,
       source = 'stripe',
       external_customer_id = excluded.external_customer_id,
       effective_at = excluded.effective_at,
       updated_by = NULL,
       updated_at = excluded.updated_at`,
  ).bind(
    target.tenantId,
    target.status,
    target.customerId,
    event.created * 1000,
    now,
    now,
    ...orderedMutationBindings(event, target.tenantId),
  )
}

function subscriptionAuditPayload(event: StripeEvent, target: StripeTarget) {
  return {
    targetType: 'billing_account',
    targetId: target.tenantId,
    eventId: event.id,
    eventType: event.type,
    status: target.status,
  }
}

function conditionalAuditStatement(
  env: Env,
  input: {
    event: StripeEvent
    mutation: StripeSubscriptionMutation
    target: StripeTarget
    auditId: string
    now: number
  },
): D1PreparedStatement {
  const { event, mutation, target, auditId, now } = input
  const canApply = `${pendingEventPredicate()} AND ${newerProcessedEventPredicate()}`
  return env.DB.prepare(
    `INSERT INTO platform_audit_outbox (
       id, tenant_id, org_id, action, actor_id, payload, status,
       available_at, attempt_count, created_at, updated_at
     )
     SELECT ?, ?, NULL, ?, 'system', ?, 'pending', ?, 0, ?, ?
     WHERE ${canApply}`,
  ).bind(
    auditId,
    target.tenantId,
    mutation.auditAction,
    JSON.stringify(subscriptionAuditPayload(event, target)),
    now,
    now,
    now,
    ...orderedMutationBindings(event, target.tenantId),
  )
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

export async function applyStripeEvent(env: Env, event: StripeEvent): Promise<void> {
  const prior = await existingEvent(env, event)
  if (prior?.status === 'processed' || prior?.status === 'ignored') return

  const mutation = deriveStripeSubscriptionMutation(event)
  const now = Date.now()
  if (!mutation) {
    await recordIgnoredEvent(env, event, now)
    return
  }

  let target: StripeTarget | null
  try {
    target = await resolveTarget(env, mutation)
  } catch (cause) {
    await recordFailedEvent(env, event, 'target_resolution_failed', now)
    logWorkerError('billing.stripe_target_resolution_failed', cause, {
      component: 'stripe-webhook',
      operation: event.type,
      outcome: 'provider_retry_required',
    })
    throw new AppError('service_unavailable', { httpStatus: 503, cause })
  }
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
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO stripe_webhook_events (
         event_id, event_type, tenant_id, event_created, status, error_code,
         processed_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'pending', NULL, NULL, ?, ?)
       ON CONFLICT (event_id) DO UPDATE SET
         status = 'pending', error_code = NULL, updated_at = excluded.updated_at
       WHERE stripe_webhook_events.status = 'failed'`,
    ).bind(event.id, event.type, target.tenantId, event.created, now, now),
    conditionalBillingAccountStatement(env, event, target, now),
    conditionalAuditStatement(env, { event, mutation, target, auditId, now }),
    env.DB.prepare(
      `UPDATE stripe_webhook_events
       SET tenant_id = ?, status = 'processed', error_code = NULL,
           processed_at = ?, updated_at = ?
       WHERE event_id = ? AND status = 'pending'`,
    ).bind(target.tenantId, now, now, event.id),
  ]
  await env.DB.batch(statements)

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
        payload: subscriptionAuditPayload(event, target),
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
