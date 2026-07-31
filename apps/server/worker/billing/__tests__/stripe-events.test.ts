import { describe, expect, it } from 'vitest'
import { deriveStripePlanMutation } from '../stripe-events'
import type { StripeEvent } from '../stripe-client'

function event(type: string, object: Record<string, unknown>): StripeEvent {
  return {
    id: 'evt_1',
    type,
    created: 1_785_240_000,
    data: { object },
  }
}

describe('Stripe billing event mapping', () => {
  it('does not treat Checkout completion as authoritative subscription state', () => {
    expect(
      deriveStripePlanMutation(
        event('checkout.session.completed', {
          customer: 'cus_1',
          client_reference_id: 'org_1',
          metadata: { xid_tenant_id: 'org_1', xid_plan: 'pro' },
        }),
      ),
    ).toBeNull()
  })

  it('maps subscription lifecycle state without creating an auth feature gate', () => {
    expect(
      deriveStripePlanMutation(
        event('customer.subscription.updated', {
          customer: { id: 'cus_1' },
          status: 'past_due',
          metadata: { xid_tenant_id: 'org_1', xid_plan: 'starter' },
        }),
      ),
    ).toMatchObject({
      status: 'past_due',
      auditAction: 'billing.subscription_updated',
    })
    expect(
      deriveStripePlanMutation(
        event('customer.subscription.deleted', {
          customer: 'cus_1',
          status: 'canceled',
        }),
      ),
    ).toMatchObject({ status: 'canceled' })
  })

  it('uses the current subscription item price instead of stale Checkout metadata', () => {
    expect(
      deriveStripePlanMutation(
        event('customer.subscription.updated', {
          customer: 'cus_1',
          status: 'active',
          metadata: { xid_tenant_id: 'org_1', xid_plan: 'starter' },
          items: {
            data: [{ price: { id: 'price_pro' } }, { price: { id: 'price_mau' } }],
          },
        }),
        {
          starter: 'price_starter',
          pro: 'price_pro',
          enterprise: 'price_enterprise',
        },
      ),
    ).toMatchObject({ planHint: 'pro', planResolutionError: null })
  })

  it('fails plan reconciliation closed for an unmapped subscription price', () => {
    expect(
      deriveStripePlanMutation(
        event('customer.subscription.updated', {
          customer: 'cus_1',
          status: 'active',
          metadata: { xid_tenant_id: 'org_1', xid_plan: 'starter' },
          items: { data: [{ price: 'price_unknown' }] },
        }),
        { starter: 'price_starter' },
      ),
    ).toMatchObject({
      planHint: 'starter',
      planResolutionError: 'unmapped_subscription_price',
    })
  })

  it('does not let invoice state overwrite the subscription lifecycle', () => {
    expect(
      deriveStripePlanMutation(
        event('invoice.payment_failed', {
          customer: 'cus_1',
          parent: {
            subscription_details: {
              metadata: { xid_tenant_id: 'org_1', xid_plan: 'enterprise' },
            },
          },
        }),
      ),
    ).toBeNull()
  })

  it('ignores unsupported or unreconcilable events', () => {
    expect(deriveStripePlanMutation(event('customer.created', { customer: 'cus_1' }))).toBeNull()
    expect(
      deriveStripePlanMutation(
        event('checkout.session.completed', {
          customer: 'cus_1',
          metadata: { xid_plan: 'pro' },
        }),
      ),
    ).toBeNull()
  })
})
