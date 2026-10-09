import type { BillingAccountStatus } from '@xid-kit/types'
import type { StripeEvent } from './stripe-client'

// 订阅事件只用于绑定 customer 与同步订阅状态;XID 没有套餐,不从 price 推导任何档位。
// 逾期状态来自订阅本身的 past_due / unpaid:Stripe 扣款失败时会同时把订阅置为 past_due
// 并发出 customer.subscription.updated,invoice 事件不再单独改状态。
export type StripeSubscriptionMutation = {
  eventId: string
  eventCreated: number
  eventType: string
  eventPriority: number
  tenantHint: string | null
  customerId: string
  subscriptionId: string
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

function customerId(object: Record<string, unknown>): string | null {
  const customer = object['customer']
  if (typeof customer === 'string') return boundedString(customer)
  return boundedString(record(customer)?.['id'])
}

// paused 的订阅不再出账,和 incomplete_expired 一样不再上报用量。
function subscriptionStatus(value: unknown): BillingAccountStatus {
  if (value === 'trialing') return 'trialing'
  if (value === 'active') return 'active'
  if (value === 'canceled' || value === 'incomplete_expired' || value === 'paused') {
    return 'canceled'
  }
  return 'past_due'
}

// 同一秒内的事件按 deleted > created/updated 排序,deleted 是终态。
function eventPriority(eventType: string): number {
  return eventType === 'customer.subscription.deleted' ? 40 : 30
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
  const subscriptionId = boundedString(object['id'])
  if (!customer || !subscriptionId) return null
  return {
    eventId: event.id,
    eventCreated: event.created,
    eventType: event.type,
    eventPriority: eventPriority(event.type),
    tenantHint: boundedString(record(object['metadata'])?.['xid_tenant_id']),
    customerId: customer,
    subscriptionId,
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
