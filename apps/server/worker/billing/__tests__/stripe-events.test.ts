import { describe, expect, it } from 'vitest'
import { deriveStripeSubscriptionMutation } from '../stripe-events'
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
      deriveStripeSubscriptionMutation(
        event('checkout.session.completed', {
          customer: 'cus_1',
          client_reference_id: 'org_1',
          metadata: { xid_tenant_id: 'org_1' },
        }),
      ),
    ).toBeNull()
  })

  it('maps subscription lifecycle state without creating an auth feature gate', () => {
    expect(
      deriveStripeSubscriptionMutation(
        event('customer.subscription.updated', {
          id: 'sub_1',
          customer: { id: 'cus_1' },
          status: 'past_due',
          metadata: { xid_tenant_id: 'org_1' },
        }),
      ),
    ).toMatchObject({
      tenantHint: 'org_1',
      customerId: 'cus_1',
      subscriptionId: 'sub_1',
      status: 'past_due',
      auditAction: 'billing.subscription_updated',
    })
    expect(
      deriveStripeSubscriptionMutation(
        event('customer.subscription.deleted', {
          id: 'sub_1',
          customer: 'cus_1',
          status: 'canceled',
        }),
      ),
    ).toMatchObject({ status: 'canceled', eventPriority: 40 })
  })

  it.each([
    ['unpaid', 'past_due'],
    ['incomplete', 'past_due'],
    ['incomplete_expired', 'canceled'],
    ['paused', 'canceled'],
    ['trialing', 'trialing'],
  ])('maps Stripe subscription status %s to billing status %s', (stripeStatus, expected) => {
    expect(
      deriveStripeSubscriptionMutation(
        event('customer.subscription.updated', {
          id: 'sub_1',
          customer: 'cus_1',
          status: stripeStatus,
        }),
      )?.status,
    ).toBe(expected)
  })

  it('accepts a metered subscription with any price and never derives a plan', () => {
    const mutation = deriveStripeSubscriptionMutation(
      event('customer.subscription.created', {
        id: 'sub_1',
        customer: 'cus_1',
        status: 'active',
        metadata: { xid_tenant_id: 'org_1', xid_plan: 'pro' },
        items: { data: [{ price: { id: 'price_metered_mau' } }] },
      }),
    )

    expect(mutation).toEqual({
      eventId: 'evt_1',
      eventCreated: 1_785_240_000,
      eventType: 'customer.subscription.created',
      eventPriority: 30,
      tenantHint: 'org_1',
      customerId: 'cus_1',
      subscriptionId: 'sub_1',
      status: 'active',
      auditAction: 'billing.subscription_created',
    })
  })

  it('leaves overdue state to the subscription status instead of invoice events', () => {
    expect(
      deriveStripeSubscriptionMutation(
        event('invoice.payment_failed', {
          customer: 'cus_1',
          parent: {
            subscription_details: {
              subscription: 'sub_1',
              metadata: { xid_tenant_id: 'org_1' },
            },
          },
        }),
      ),
    ).toBeNull()
  })

  it('ignores unsupported events and subscriptions without a customer or id', () => {
    expect(
      deriveStripeSubscriptionMutation(event('customer.created', { customer: 'cus_1' })),
    ).toBeNull()
    expect(
      deriveStripeSubscriptionMutation(
        event('customer.subscription.updated', { id: 'sub_1', status: 'active' }),
      ),
    ).toBeNull()
    expect(
      deriveStripeSubscriptionMutation(
        event('customer.subscription.updated', { customer: 'cus_1', status: 'active' }),
      ),
    ).toBeNull()
  })
})
