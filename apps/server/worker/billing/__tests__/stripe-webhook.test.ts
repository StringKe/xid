import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applyStripeEvent,
  readStripeWebhookBody,
  STRIPE_WEBHOOK_MAX_BODY_BYTES,
} from '../stripe-webhook'
import type { StripeEvent } from '../stripe-client'
import { createBillingDatabase, makeBillingEnv } from './sqlite-d1'

function subscriptionEvent(
  id: string,
  type:
    | 'customer.subscription.created'
    | 'customer.subscription.updated'
    | 'customer.subscription.deleted',
  created: number,
  status?: string,
  subscriptionId = 'sub_1',
): StripeEvent {
  return {
    id,
    type,
    created,
    data: {
      object: {
        id: subscriptionId,
        customer: 'cus_1',
        status,
        metadata: { xid_tenant_id: 'org_1' },
        items: { data: [{ price: { id: 'price_metered_mau' } }] },
      },
    },
  }
}

function accountStatus(d1: ReturnType<typeof createBillingDatabase>): unknown {
  return d1.database
    .prepare(`SELECT status FROM organization_plans WHERE tenant_id = 'org_1'`)
    .get()
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Stripe webhook with replaced subscriptions', () => {
  it('keeps the tenant active when the old subscription is deleted after the new one starts', async () => {
    const d1 = createBillingDatabase()
    const env = makeBillingEnv(d1)
    await applyStripeEvent(
      env,
      subscriptionEvent('evt_old', 'customer.subscription.created', 100, 'active', 'sub_old'),
    )
    await applyStripeEvent(
      env,
      subscriptionEvent('evt_new', 'customer.subscription.created', 200, 'active', 'sub_new'),
    )

    await applyStripeEvent(
      env,
      subscriptionEvent(
        'evt_old_deleted',
        'customer.subscription.deleted',
        300,
        undefined,
        'sub_old',
      ),
    )

    expect(accountStatus(d1)).toEqual({ status: 'active' })
    expect(
      d1.database
        .prepare(
          `SELECT subscription_id, status FROM billing_subscriptions ORDER BY subscription_id`,
        )
        .all(),
    ).toEqual([
      { subscription_id: 'sub_new', status: 'active' },
      { subscription_id: 'sub_old', status: 'canceled' },
    ])
    d1.close()
  })

  it('reactivates the tenant when an older new-subscription event arrives after the old deletion', async () => {
    const d1 = createBillingDatabase()
    const env = makeBillingEnv(d1)
    await applyStripeEvent(
      env,
      subscriptionEvent('evt_old', 'customer.subscription.created', 100, 'active', 'sub_old'),
    )
    await applyStripeEvent(
      env,
      subscriptionEvent(
        'evt_old_deleted',
        'customer.subscription.deleted',
        300,
        undefined,
        'sub_old',
      ),
    )
    expect(accountStatus(d1)).toEqual({ status: 'canceled' })

    await applyStripeEvent(
      env,
      subscriptionEvent('evt_new', 'customer.subscription.created', 250, 'active', 'sub_new'),
    )

    expect(accountStatus(d1)).toEqual({ status: 'active' })
    d1.close()
  })

  it('cancels the tenant only when its last subscription is deleted', async () => {
    const d1 = createBillingDatabase()
    const env = makeBillingEnv(d1)
    await applyStripeEvent(
      env,
      subscriptionEvent('evt_a', 'customer.subscription.created', 100, 'active', 'sub_a'),
    )
    await applyStripeEvent(
      env,
      subscriptionEvent('evt_b', 'customer.subscription.created', 110, 'past_due', 'sub_b'),
    )
    await applyStripeEvent(
      env,
      subscriptionEvent('evt_a_deleted', 'customer.subscription.deleted', 200, undefined, 'sub_a'),
    )
    expect(accountStatus(d1)).toEqual({ status: 'past_due' })

    await applyStripeEvent(
      env,
      subscriptionEvent('evt_b_deleted', 'customer.subscription.deleted', 210, undefined, 'sub_b'),
    )

    expect(accountStatus(d1)).toEqual({ status: 'canceled' })
    expect(
      d1.database.prepare(`SELECT COUNT(*) AS value FROM platform_audit_outbox`).get(),
    ).toEqual({ value: 4 })
    d1.close()
  })
})

describe('Stripe webhook persistence', () => {
  it('applies one event once and keeps the newest authoritative state', async () => {
    const d1 = createBillingDatabase()
    const env = makeBillingEnv(d1)

    await applyStripeEvent(
      env,
      subscriptionEvent('evt_created', 'customer.subscription.created', 100, 'active'),
    )
    await applyStripeEvent(
      env,
      subscriptionEvent('evt_created', 'customer.subscription.created', 100, 'active'),
    )
    expect(
      d1.database
        .prepare(
          `SELECT plan, status, source, external_customer_id
           FROM organization_plans WHERE tenant_id = 'org_1'`,
        )
        .get(),
    ).toEqual({
      plan: 'free',
      status: 'active',
      source: 'stripe',
      external_customer_id: 'cus_1',
    })
    expect(
      d1.database.prepare(`SELECT COUNT(*) AS value FROM platform_audit_outbox`).get(),
    ).toEqual({ value: 1 })
    expect(d1.database.prepare(`SELECT COUNT(*) AS value FROM organization_quotas`).get()).toEqual({
      value: 0,
    })
    expect(
      d1.database.prepare(`SELECT seat_limit FROM organizations WHERE id = 'org_1'`).get(),
    ).toEqual({ seat_limit: null })

    await applyStripeEvent(
      env,
      subscriptionEvent('evt_newer', 'customer.subscription.updated', 300, 'active'),
    )
    await applyStripeEvent(
      env,
      subscriptionEvent('evt_older', 'customer.subscription.updated', 200, 'past_due'),
    )
    expect(
      d1.database.prepare(`SELECT status FROM organization_plans WHERE tenant_id = 'org_1'`).get(),
    ).toEqual({ status: 'active' })

    await applyStripeEvent(
      env,
      subscriptionEvent('evt_deleted', 'customer.subscription.deleted', 400),
    )
    await applyStripeEvent(
      env,
      subscriptionEvent('evt_same_second_update', 'customer.subscription.updated', 400, 'active'),
    )
    expect(
      d1.database.prepare(`SELECT status FROM organization_plans WHERE tenant_id = 'org_1'`).get(),
    ).toEqual({ status: 'canceled' })
    expect(
      d1.database
        .prepare(
          `SELECT COUNT(*) AS value
           FROM stripe_webhook_events WHERE status = 'processed'`,
        )
        .get(),
    ).toEqual({ value: 5 })
    d1.close()
  })

  it('acknowledges a subscription of another product without xid_tenant_id as ignored', async () => {
    const d1 = createBillingDatabase()
    const env = makeBillingEnv(d1)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const foreign: StripeEvent = {
      id: 'evt_foreign',
      type: 'customer.subscription.created',
      created: 100,
      data: { object: { id: 'sub_other', customer: 'cus_other', status: 'active', metadata: {} } },
    }

    await expect(applyStripeEvent(env, foreign)).resolves.toBeUndefined()

    expect(
      d1.database
        .prepare(`SELECT status, tenant_id FROM stripe_webhook_events WHERE event_id = ?`)
        .get('evt_foreign'),
    ).toEqual({ status: 'ignored', tenant_id: null })
    expect(d1.database.prepare(`SELECT COUNT(*) AS value FROM organization_plans`).get()).toEqual({
      value: 0,
    })
    d1.close()
  })

  it('still asks Stripe to retry when a bound customer points at another tenant', async () => {
    const d1 = createBillingDatabase(['org_1', 'org_2'])
    const env = makeBillingEnv(d1)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await applyStripeEvent(
      env,
      subscriptionEvent('evt_bind', 'customer.subscription.created', 100, 'active'),
    )
    const conflicting: StripeEvent = {
      id: 'evt_conflict',
      type: 'customer.subscription.updated',
      created: 200,
      data: {
        object: {
          id: 'sub_1',
          customer: 'cus_1',
          status: 'active',
          metadata: { xid_tenant_id: 'org_2' },
        },
      },
    }

    await expect(applyStripeEvent(env, conflicting)).rejects.toMatchObject({
      code: 'service_unavailable',
      httpStatus: 503,
    })

    expect(
      d1.database
        .prepare(`SELECT status FROM stripe_webhook_events WHERE event_id = ?`)
        .get('evt_conflict'),
    ).toEqual({ status: 'failed' })
    d1.close()
  })

  it('bounds the public raw-body buffer before signature verification', async () => {
    await expect(
      readStripeWebhookBody(
        new Request('https://xid.test/v1/billing/stripe/webhook', {
          method: 'POST',
          body: new Uint8Array(STRIPE_WEBHOOK_MAX_BODY_BYTES + 1),
        }),
      ),
    ).rejects.toMatchObject({ code: 'invalid_request', httpStatus: 413 })
  })
})
