import { Hono } from 'hono'
import {
  parseStripeEvent,
  stripeWebhookSecret,
  verifyStripeWebhookSignature,
  type StripeEvent,
  type StripeManagedPlan,
} from './stripe-client'
import { deriveStripePlanMutation, type StripePlanMutation } from './stripe-events'
import { AppError } from '../lib/errors'
import { createPersistedId } from '../lib/persisted-id'
import { logWorkerError, logWorkerWarning } from '../lib/safe-log'
import type { XidHonoEnv } from '../lib/types'
import { enqueuePersistedPlatformAudit } from '../platform/audit-outbox'
import { planDefaultQuotas } from '../platform/plans'

const app = new Hono<XidHonoEnv>()
export const STRIPE_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024

type ExistingWebhookEvent = {
  eventType: string
  eventCreated: number
  status: string
}

type PlanRow = {
  tenantId: string
  plan: string
  status: string
  customerId: string | null
}

type StripeTarget = {
  tenantId: string
  plan: StripeManagedPlan | 'free'
  status: StripePlanMutation['status']
  customerId: string
}

function isOrganizationPlan(value: string): value is StripeTarget['plan'] {
  return value === 'free' || value === 'starter' || value === 'pro' || value === 'enterprise'
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

async function loadPlanByCustomer(env: Env, customerId: string): Promise<PlanRow | null> {
  return env.DB.prepare(
    `SELECT tenant_id AS tenantId, plan, status, external_customer_id AS customerId
     FROM organization_plans
     WHERE external_customer_id = ?
     LIMIT 1`,
  )
    .bind(customerId)
    .first<PlanRow>()
}

async function loadPlanByTenant(env: Env, tenantId: string): Promise<PlanRow | null> {
  return env.DB.prepare(
    `SELECT tenant_id AS tenantId, plan, status, external_customer_id AS customerId
     FROM organization_plans
     WHERE tenant_id = ?
     LIMIT 1`,
  )
    .bind(tenantId)
    .first<PlanRow>()
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

async function resolveTarget(env: Env, mutation: StripePlanMutation): Promise<StripeTarget> {
  if (mutation.planResolutionError) {
    throw new Error(`stripe_${mutation.planResolutionError}`)
  }
  const [customerPlan, hintedPlan, tenantExists] = await Promise.all([
    loadPlanByCustomer(env, mutation.customerId),
    mutation.tenantHint ? loadPlanByTenant(env, mutation.tenantHint) : Promise.resolve(null),
    mutation.tenantHint ? isTopLevelTenant(env, mutation.tenantHint) : Promise.resolve(false),
  ])

  if (mutation.tenantHint && !tenantExists) {
    throw new Error('stripe_tenant_hint_unknown')
  }
  if (customerPlan && mutation.tenantHint && customerPlan.tenantId !== mutation.tenantHint) {
    throw new Error('stripe_customer_tenant_mismatch')
  }

  const tenantId = customerPlan?.tenantId ?? mutation.tenantHint
  if (!tenantId) throw new Error('stripe_tenant_unresolved')
  const current = customerPlan ?? hintedPlan
  if (current?.customerId && current.customerId !== mutation.customerId) {
    throw new Error('stripe_tenant_customer_mismatch')
  }

  const plan = mutation.planHint ?? current?.plan
  if (!plan || !isOrganizationPlan(plan)) {
    throw new Error('stripe_plan_unresolved')
  }
  return {
    tenantId,
    plan,
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

function conditionalPlanStatement(
  env: Env,
  event: StripeEvent,
  target: StripeTarget,
  now: number,
): D1PreparedStatement {
  const canApply = `${pendingEventPredicate()} AND ${newerProcessedEventPredicate()}`
  return env.DB.prepare(
    `INSERT INTO organization_plans (
       tenant_id, plan, status, source, external_customer_id, trial_ends_at,
       effective_at, updated_by, created_at, updated_at
     )
     SELECT ?, ?, ?, 'stripe', ?, NULL, ?, NULL, ?, ?
     WHERE ${canApply}
     ON CONFLICT (tenant_id) DO UPDATE SET
       plan = excluded.plan,
       status = excluded.status,
       source = 'stripe',
       external_customer_id = excluded.external_customer_id,
       effective_at = excluded.effective_at,
       updated_by = NULL,
       updated_at = excluded.updated_at`,
  ).bind(
    target.tenantId,
    target.plan,
    target.status,
    target.customerId,
    event.created * 1000,
    now,
    now,
    ...orderedMutationBindings(event, target.tenantId),
  )
}

function conditionalQuotaStatement(
  env: Env,
  input: {
    event: StripeEvent
    target: StripeTarget
    quota: ReturnType<typeof planDefaultQuotas>[number]
    now: number
  },
): D1PreparedStatement {
  const { event, target, quota, now } = input
  const canApply = `${pendingEventPredicate()} AND ${newerProcessedEventPredicate()}`
  return env.DB.prepare(
    `INSERT INTO organization_quotas (
       tenant_id, quota_key, "limit", enforcement, updated_by, created_at, updated_at
     )
     SELECT ?, ?, ?, ?, NULL, ?, ?
     WHERE ${canApply}
     ON CONFLICT (tenant_id, quota_key) DO UPDATE SET
       "limit" = excluded."limit",
       enforcement = excluded.enforcement,
       updated_at = excluded.updated_at
     WHERE organization_quotas.updated_by IS NULL`,
  ).bind(
    target.tenantId,
    quota.key,
    quota.limit,
    quota.enforcement,
    now,
    now,
    ...orderedMutationBindings(event, target.tenantId),
  )
}

function conditionalSeatMirrorStatement(
  env: Env,
  event: StripeEvent,
  target: StripeTarget,
  now: number,
): D1PreparedStatement {
  const canApply = `${pendingEventPredicate()} AND ${newerProcessedEventPredicate()}`
  return env.DB.prepare(
    `UPDATE organizations
     SET seat_limit = (
       SELECT "limit"
       FROM organization_quotas
       WHERE tenant_id = ? AND quota_key = 'seats'
     ), updated_at = ?
     WHERE id = ? AND tenant_id = ? AND parent_org_id IS NULL
       AND ${canApply}`,
  ).bind(
    target.tenantId,
    now,
    target.tenantId,
    target.tenantId,
    ...orderedMutationBindings(event, target.tenantId),
  )
}

function conditionalCheckoutCompletionStatement(
  env: Env,
  input: { event: StripeEvent; target: StripeTarget; now: number },
): D1PreparedStatement {
  const canApply = `${pendingEventPredicate()} AND ${newerProcessedEventPredicate()}`
  return env.DB.prepare(
    `UPDATE stripe_checkout_reservations
     SET customer_id = COALESCE(customer_id, ?), status = 'completed', updated_at = ?
     WHERE tenant_id = ? AND status IN ('reserved', 'ready')
       AND (customer_id IS NULL OR customer_id = ?)
       AND ${canApply}`,
  ).bind(
    input.target.customerId,
    input.now,
    input.target.tenantId,
    input.target.customerId,
    ...orderedMutationBindings(input.event, input.target.tenantId),
  )
}

function conditionalAuditStatement(
  env: Env,
  input: {
    event: StripeEvent
    mutation: StripePlanMutation
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
    JSON.stringify({
      targetType: 'organization_plan',
      targetId: target.tenantId,
      eventId: event.id,
      eventType: event.type,
      plan: target.plan,
      status: target.status,
    }),
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

  const mutation = deriveStripePlanMutation(event, {
    starter: env.STRIPE_STARTER_PRICE_ID,
    pro: env.STRIPE_PRO_PRICE_ID,
    enterprise: env.STRIPE_ENTERPRISE_PRICE_ID,
  })
  const now = Date.now()
  if (!mutation) {
    await recordIgnoredEvent(env, event, now)
    return
  }

  let target: StripeTarget
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
    conditionalPlanStatement(env, event, target, now),
  ]

  if (mutation.planHint !== null) {
    for (const quota of planDefaultQuotas(target.plan)) {
      statements.push(conditionalQuotaStatement(env, { event, target, quota, now }))
    }
    statements.push(conditionalSeatMirrorStatement(env, event, target, now))
  }
  if (event.type === 'customer.subscription.created') {
    statements.push(conditionalCheckoutCompletionStatement(env, { event, target, now }))
  }
  statements.push(
    conditionalAuditStatement(env, { event, mutation, target, auditId, now }),
    env.DB.prepare(
      `UPDATE stripe_webhook_events
       SET tenant_id = ?, status = 'processed', error_code = NULL,
           processed_at = ?, updated_at = ?
       WHERE event_id = ? AND status = 'pending'`,
    ).bind(target.tenantId, now, now, event.id),
  )
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
        payload: {
          targetType: 'organization_plan',
          targetId: target.tenantId,
          eventId: event.id,
          eventType: event.type,
          plan: target.plan,
          status: target.status,
        },
        ts: now,
      },
    })
  }
}

app.post('/', async (c) => {
  const rawBody = await readStripeWebhookBody(c.req.raw)
  const signature = c.req.header('stripe-signature')
  if (!signature) throw new AppError('invalid_request', { httpStatus: 400 })
  const valid = await verifyStripeWebhookSignature(rawBody, signature, stripeWebhookSecret(c.env))
  if (!valid) throw new AppError('invalid_request', { httpStatus: 400 })
  await applyStripeEvent(c.env, parseStripeEvent(decodeStripeWebhookBody(rawBody)))
  return c.json({ received: true })
})

export function registerStripeWebhookRoutes(parent: Hono<XidHonoEnv>): void {
  parent.route('/v1/billing/stripe/webhook', app)
}
