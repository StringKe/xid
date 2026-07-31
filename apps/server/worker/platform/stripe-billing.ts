import { schema } from '@xid-kit/db'
import { and, eq, isNull } from 'drizzle-orm'
import { Hono } from 'hono'
import * as v from 'valibot'
import {
  createStripeCheckoutSession,
  createStripePortalSession,
  retrieveStripeCheckoutSession,
  StripeApiError,
  type StripeHostedSession,
  type StripeManagedPlan,
} from '../billing/stripe-client'
import { AppError } from '../lib/errors'
import { logWorkerError } from '../lib/safe-log'
import type { XidHonoEnv } from '../lib/types'
import { readJsonBody, validateBody } from '../lib/validate'
import { managementDb, requireInstanceManager } from './shared'

const app = new Hono<XidHonoEnv>()
const STRIPE_CHECKOUT_IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000

type BillingTarget = {
  customerId: string | null
  status: string | null
  source: string | null
}

type CheckoutReservation = {
  tenantId: string
  requestId: string
  plan: StripeManagedPlan
  customerId: string | null
  providerIdempotencyKey: string
  sessionId: string | null
  sessionUrl: string | null
  expiresAt: number | null
  status: string
  createdAt: number
}

const checkoutBodySchema = v.object({
  tenantId: v.pipe(v.string(), v.minLength(1), v.maxLength(255)),
  plan: v.picklist(['starter', 'pro', 'enterprise']),
  idempotencyKey: v.pipe(
    v.string(),
    v.minLength(16),
    v.maxLength(100),
    v.regex(/^[A-Za-z0-9_-]+$/u),
  ),
})

const portalBodySchema = v.object({
  tenantId: v.pipe(v.string(), v.minLength(1), v.maxLength(255)),
})

function requireStripeAdapter(env: Env): void {
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET) {
    throw new AppError('service_unavailable', { httpStatus: 503 })
  }
}

function checkoutAllowed(target: BillingTarget | null): boolean {
  if (!target) return true
  if (target.customerId) return target.status === 'canceled'
  return target.source !== 'stripe' || target.status === 'canceled'
}

export function stripeConfiguration(env: Env, target: BillingTarget | null) {
  const api = Boolean(env.STRIPE_SECRET_KEY)
  const reconciled = api && Boolean(env.STRIPE_WEBHOOK_SECRET)
  const canCheckout = checkoutAllowed(target)
  return {
    enabled: reconciled,
    checkout: {
      starter: reconciled && canCheckout && Boolean(env.STRIPE_STARTER_PRICE_ID),
      pro: reconciled && canCheckout && Boolean(env.STRIPE_PRO_PRICE_ID),
      enterprise: reconciled && canCheckout && Boolean(env.STRIPE_ENTERPRISE_PRICE_ID),
    },
    portal: reconciled && Boolean(target?.customerId),
    metering: reconciled && Boolean(env.STRIPE_METER_EVENT_NAME),
  }
}

async function loadBillingTarget(env: Env, tenantId: string): Promise<BillingTarget> {
  const db = managementDb(env)
  const [organization] = await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(
      and(
        eq(schema.organizations.id, tenantId),
        eq(schema.organizations.tenantId, tenantId),
        isNull(schema.organizations.parentOrgId),
      ),
    )
    .limit(1)
  if (!organization) throw new AppError('not_found', { httpStatus: 404 })
  const [plan] = await db
    .select({
      customerId: schema.organizationPlans.externalCustomerId,
      status: schema.organizationPlans.status,
      source: schema.organizationPlans.source,
    })
    .from(schema.organizationPlans)
    .where(eq(schema.organizationPlans.tenantId, tenantId))
    .limit(1)
  return {
    customerId: plan?.customerId ?? null,
    status: plan?.status ?? null,
    source: plan?.source ?? null,
  }
}

async function loadCheckoutReservation(
  env: Env,
  tenantId: string,
): Promise<CheckoutReservation | null> {
  return env.DB.prepare(
    `SELECT tenant_id AS tenantId, request_id AS requestId, plan,
            customer_id AS customerId, provider_idempotency_key AS providerIdempotencyKey,
            session_id AS sessionId, session_url AS sessionUrl, expires_at AS expiresAt,
            status, created_at AS createdAt
     FROM stripe_checkout_reservations
     WHERE tenant_id = ?
     LIMIT 1`,
  )
    .bind(tenantId)
    .first<CheckoutReservation>()
}

function assertReservationMatches(
  reservation: CheckoutReservation,
  input: { plan: StripeManagedPlan; customerId: string | null },
): void {
  if (reservation.plan !== input.plan || reservation.customerId !== input.customerId) {
    throw new AppError('conflict', { httpStatus: 409 })
  }
}

async function markCheckoutReconciliationRequired(
  env: Env,
  reservation: CheckoutReservation,
  now: number,
): Promise<never> {
  await env.DB.prepare(
    `UPDATE stripe_checkout_reservations
     SET status = 'reconciliation_required', updated_at = ?
     WHERE tenant_id = ? AND provider_idempotency_key = ? AND status = 'reserved'`,
  )
    .bind(now, reservation.tenantId, reservation.providerIdempotencyKey)
    .run()
  throw new AppError('service_unavailable', { httpStatus: 503 })
}

export async function reserveCheckout(
  env: Env,
  input: {
    tenantId: string
    requestId: string
    plan: StripeManagedPlan
    customerId: string | null
    currentStatus: string | null
    now: number
  },
): Promise<CheckoutReservation> {
  const providerIdempotencyKey = `xid_checkout_${crypto.randomUUID().replaceAll('-', '')}`
  await env.DB.prepare(
    `INSERT INTO stripe_checkout_reservations (
       tenant_id, request_id, plan, customer_id, provider_idempotency_key,
       session_id, session_url, expires_at, status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, 'reserved', ?, ?)
     ON CONFLICT (tenant_id) DO NOTHING`,
  )
    .bind(
      input.tenantId,
      input.requestId,
      input.plan,
      input.customerId,
      providerIdempotencyKey,
      input.now,
      input.now,
    )
    .run()

  let reservation = await loadCheckoutReservation(env, input.tenantId)
  if (!reservation) throw new Error('stripe_checkout_reservation_missing')

  const readyAndLive =
    reservation.status === 'ready' &&
    reservation.expiresAt !== null &&
    reservation.expiresAt > input.now
  if (readyAndLive || reservation.status === 'ready' || reservation.status === 'reserved') {
    assertReservationMatches(reservation, input)
    if (
      reservation.status === 'reserved' &&
      input.now - reservation.createdAt >= STRIPE_CHECKOUT_IDEMPOTENCY_WINDOW_MS
    ) {
      return markCheckoutReconciliationRequired(env, reservation, input.now)
    }
    return reservation
  }

  const replaceable =
    reservation.status === 'expired' ||
    (reservation.status === 'completed' && input.currentStatus === 'canceled')
  if (!replaceable || reservation.status === 'reconciliation_required') {
    throw new AppError('conflict', { httpStatus: 409 })
  }

  await env.DB.prepare(
    `UPDATE stripe_checkout_reservations
     SET request_id = ?, plan = ?, customer_id = ?, provider_idempotency_key = ?,
         session_id = NULL, session_url = NULL, expires_at = NULL,
         status = 'reserved', created_at = ?, updated_at = ?
     WHERE tenant_id = ? AND (
       status = 'expired'
       OR (status = 'completed' AND ? = 'canceled')
     )`,
  )
    .bind(
      input.requestId,
      input.plan,
      input.customerId,
      providerIdempotencyKey,
      input.now,
      input.now,
      input.tenantId,
      input.currentStatus,
    )
    .run()
  reservation = await loadCheckoutReservation(env, input.tenantId)
  if (!reservation) throw new Error('stripe_checkout_reservation_missing')
  assertReservationMatches(reservation, input)
  return reservation
}

export function hostedSessionFromReservation(
  reservation: CheckoutReservation,
  now: number,
): StripeHostedSession | null {
  if (
    (reservation.status !== 'ready' && reservation.status !== 'completed') ||
    !reservation.sessionId ||
    !reservation.sessionUrl ||
    reservation.expiresAt === null ||
    reservation.expiresAt <= now
  ) {
    return null
  }
  return {
    id: reservation.sessionId,
    url: reservation.sessionUrl,
    expiresAt: reservation.expiresAt,
  }
}

export async function persistCheckoutSession(
  env: Env,
  reservation: CheckoutReservation,
  session: StripeHostedSession,
  now: number,
): Promise<StripeHostedSession> {
  if (session.expiresAt === null) throw new Error('stripe_checkout_expiry_missing')
  await env.DB.prepare(
    `UPDATE stripe_checkout_reservations
     SET session_id = ?, session_url = ?, expires_at = ?,
         status = CASE WHEN status = 'completed' THEN 'completed' ELSE 'ready' END,
         updated_at = ?
     WHERE tenant_id = ? AND provider_idempotency_key = ?
       AND status IN ('reserved', 'completed')`,
  )
    .bind(
      session.id,
      session.url,
      session.expiresAt,
      now,
      reservation.tenantId,
      reservation.providerIdempotencyKey,
    )
    .run()
  const stored = await loadCheckoutReservation(env, reservation.tenantId)
  const hosted = stored ? hostedSessionFromReservation(stored, now) : null
  if (!hosted) throw new Error('stripe_checkout_session_persist_failed')
  return hosted
}

export async function createOrReuseStripeCheckout(
  env: Env,
  input: {
    tenantId: string
    requestId: string
    plan: StripeManagedPlan
    customerId: string | null
    currentStatus: string | null
    successUrl: string
    cancelUrl: string
    now: number
  },
): Promise<StripeHostedSession> {
  let reservation = await reserveCheckout(env, input)
  let reusable = hostedSessionFromReservation(reservation, input.now)
  if (reusable) return reusable
  if (reservation.status === 'ready' && reservation.sessionId) {
    const providerSession = await retrieveStripeCheckoutSession(env, reservation.sessionId)
    if (providerSession.status === 'complete') {
      await env.DB.prepare(
        `UPDATE stripe_checkout_reservations
         SET status = 'completed', updated_at = ?
         WHERE tenant_id = ? AND provider_idempotency_key = ?
           AND session_id = ? AND status = 'ready'`,
      )
        .bind(
          input.now,
          reservation.tenantId,
          reservation.providerIdempotencyKey,
          reservation.sessionId,
        )
        .run()
      throw new AppError('conflict', { httpStatus: 409 })
    }
    if (providerSession.status === 'open') {
      if (providerSession.expiresAt <= input.now) {
        throw new AppError('service_unavailable', { httpStatus: 503 })
      }
      await env.DB.prepare(
        `UPDATE stripe_checkout_reservations
         SET expires_at = ?, updated_at = ?
         WHERE tenant_id = ? AND provider_idempotency_key = ?
           AND session_id = ? AND status = 'ready'`,
      )
        .bind(
          providerSession.expiresAt,
          input.now,
          reservation.tenantId,
          reservation.providerIdempotencyKey,
          reservation.sessionId,
        )
        .run()
      reservation = (await loadCheckoutReservation(env, input.tenantId)) ?? reservation
      reusable = hostedSessionFromReservation(reservation, input.now)
      if (!reusable) throw new AppError('service_unavailable', { httpStatus: 503 })
      return reusable
    }

    await env.DB.prepare(
      `UPDATE stripe_checkout_reservations
       SET status = 'expired', updated_at = ?
       WHERE tenant_id = ? AND provider_idempotency_key = ?
         AND session_id = ? AND status = 'ready'`,
    )
      .bind(
        input.now,
        reservation.tenantId,
        reservation.providerIdempotencyKey,
        reservation.sessionId,
      )
      .run()
    reservation = await reserveCheckout(env, input)
  }
  const created = await createStripeCheckoutSession(env, {
    tenantId: input.tenantId,
    plan: input.plan,
    customerId: input.customerId,
    successUrl: input.successUrl,
    cancelUrl: input.cancelUrl,
    idempotencyKey: reservation.providerIdempotencyKey,
  })
  return persistCheckoutSession(env, reservation, created, input.now)
}

function consoleReturnUrl(c: Parameters<typeof requireInstanceManager>[0], tenantId: string): URL {
  const url = new URL('/console/platform/plans', c.get('tenant').issuer)
  url.searchParams.set('tenantId', tenantId)
  return url
}

async function mapStripeFailure<T>(operation: string, callback: () => Promise<T>): Promise<T> {
  try {
    return await callback()
  } catch (cause) {
    if (cause instanceof AppError) throw cause
    logWorkerError('platform.stripe_request_failed', cause, {
      component: 'stripe-billing',
      operation,
      ...(cause instanceof StripeApiError ? { status: cause.status } : {}),
    })
    throw new AppError('service_unavailable', { httpStatus: 503, cause })
  }
}

app.get('/stripe-config', async (c) => {
  await requireInstanceManager(c)
  const tenantId = c.req.query('tenantId')?.trim()
  const target = tenantId ? await loadBillingTarget(c.env, tenantId) : null
  return c.json(stripeConfiguration(c.env, target))
})

app.post('/checkout', async (c) => {
  await requireInstanceManager(c)
  requireStripeAdapter(c.env)
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(checkoutBodySchema, json.value)
  const target = await loadBillingTarget(c.env, body.tenantId)
  if (!checkoutAllowed(target)) {
    throw new AppError('conflict', { httpStatus: 409 })
  }
  const returnUrl = consoleReturnUrl(c, body.tenantId)
  const successUrl = new URL(returnUrl)
  successUrl.searchParams.set('checkout', 'success')
  const cancelUrl = new URL(returnUrl)
  cancelUrl.searchParams.set('checkout', 'canceled')

  const session = await mapStripeFailure('checkout.create', async () => {
    const now = Date.now()
    return createOrReuseStripeCheckout(c.env, {
      tenantId: body.tenantId,
      requestId: body.idempotencyKey,
      plan: body.plan as StripeManagedPlan,
      customerId: target.customerId,
      currentStatus: target.status,
      successUrl: successUrl.toString(),
      cancelUrl: cancelUrl.toString(),
      now,
    })
  })
  return c.json(session, 201)
})

app.post('/portal', async (c) => {
  await requireInstanceManager(c)
  requireStripeAdapter(c.env)
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(portalBodySchema, json.value)
  const target = await loadBillingTarget(c.env, body.tenantId)
  if (!target.customerId) throw new AppError('not_found', { httpStatus: 404 })
  const session = await mapStripeFailure('portal.create', () =>
    createStripePortalSession(c.env, {
      customerId: target.customerId!,
      returnUrl: consoleReturnUrl(c, body.tenantId).toString(),
    }),
  )
  return c.json(session, 201)
})

export function registerStripeBillingRoutes(parent: Hono<XidHonoEnv>): void {
  parent.route('/v1/platform/billing', app)
}
