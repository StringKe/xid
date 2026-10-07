import type { BillingAccountStatus } from '@xid-kit/types'
import type { StripeEvent } from './stripe-client'

// 订阅事件只用于绑定 customer 与同步订阅状态;XID 没有套餐,不从 price 推导任何档位。
export type StripeSubscriptionMutation = {
  eventId: string
  eventCreated: number
  eventType: string
  tenantHint: string | null
  customerId: string
  status: BillingAccountStatus
  auditAction: 'billing.subscription_created' | 'billing.subscription_updated'
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function boundedString(value: unknown, maxLength = 255): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength ? value : null
}

function metadata(object: Record<string, unknown>): Record<string, unknown> {
  const direct = record(object['metadata'])
  if (direct) return direct
  const subscriptionDetails = record(object['subscription_details'])
  const subscriptionMetadata = record(subscriptionDetails?.['metadata'])
  if (subscriptionMetadata) return subscriptionMetadata
  const parent = record(object['parent'])
  const parentSubscriptionDetails = record(parent?.['subscription_details'])
  return record(parentSubscriptionDetails?.['metadata']) ?? {}
}

function customerId(object: Record<string, unknown>): string | null {
  const customer = object['customer']
  if (typeof customer === 'string') return boundedString(customer)
  return boundedString(record(customer)?.['id'])
}

function subscriptionStatus(value: unknown): BillingAccountStatus {
  if (value === 'trialing') return 'trialing'
  if (value === 'active') return 'active'
  if (value === 'canceled') return 'canceled'
  return 'past_due'
}

export function deriveStripeSubscriptionMutation(
  event: StripeEvent,
): StripeSubscriptionMutation | null {
  if (
    event.type !== 'customer.subscription.created' &&
    event.type !== 'customer.subscription.updated' &&
    event.type !== 'customer.subscription.deleted'
  ) {
    return null
  }
  const object = event.data.object
  const customer = customerId(object)
  if (!customer) return null
  const tenantHint =
    boundedString(metadata(object)['xid_tenant_id']) ?? boundedString(object['client_reference_id'])
  return {
    eventId: event.id,
    eventCreated: event.created,
    eventType: event.type,
    tenantHint,
    customerId: customer,
    status:
      event.type === 'customer.subscription.deleted'
        ? 'canceled'
        : subscriptionStatus(object['status']),
    auditAction:
      event.type === 'customer.subscription.created'
        ? 'billing.subscription_created'
        : 'billing.subscription_updated',
  }
}
