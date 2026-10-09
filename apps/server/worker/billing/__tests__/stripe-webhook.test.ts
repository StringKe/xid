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
): StripeEvent {
  return {
    id,
    type,
    created,
    data: {
      object: {
        customer: 'cus_1',
        status,
        metadata: { xid_tenant_id: 'org_1' },
        items: { data: [{ price: { id: 'price_metered_mau' } }] },
      },
    },
  }
}

afterEach(() => {
  vi.restoreAllMocks()
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
        object: { customer: 'cus_1', status: 'active', metadata: { xid_tenant_id: 'org_2' } },
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
