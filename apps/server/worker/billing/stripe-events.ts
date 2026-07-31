import type { StripeEvent, StripeManagedPlan } from './stripe-client'

export type StripePlanStatus = 'active' | 'trialing' | 'past_due' | 'canceled'

export type StripePlanMutation = {
  eventId: string
  eventCreated: number
  eventType: string
  tenantHint: string | null
  customerId: string
  planHint: StripeManagedPlan | null
  planResolutionError: 'ambiguous_subscription_prices' | 'unmapped_subscription_price' | null
  status: StripePlanStatus
  auditAction: 'billing.subscription_created' | 'billing.subscription_updated'
}

export type StripePlanPriceIds = Partial<Record<StripeManagedPlan, string>>

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

function planHint(value: unknown): StripeManagedPlan | null {
  return value === 'starter' || value === 'pro' || value === 'enterprise' ? value : null
}

function subscriptionItemPlan(
  object: Record<string, unknown>,
  priceIds: StripePlanPriceIds | undefined,
): {
  plan: StripeManagedPlan | null
  error: StripePlanMutation['planResolutionError']
} {
  const configured = Object.entries(priceIds ?? {}).filter(
    (entry): entry is [StripeManagedPlan, string] =>
      typeof entry[1] === 'string' && entry[1].length > 0,
  )
  const data = record(object['items'])?.['data']
  if (configured.length === 0 || !Array.isArray(data) || data.length === 0) {
    return { plan: null, error: null }
  }

  const itemPriceIds = new Set<string>()
  for (const value of data) {
    const price = record(value)?.['price']
    const id =
      typeof price === 'string' ? boundedString(price) : boundedString(record(price)?.['id'])
    if (id) itemPriceIds.add(id)
  }
  if (itemPriceIds.size === 0) return { plan: null, error: 'unmapped_subscription_price' }

  const matches = configured
    .filter(([, priceId]) => itemPriceIds.has(priceId))
    .map(([plan]) => plan)
  if (matches.length === 0) return { plan: null, error: 'unmapped_subscription_price' }
  if (matches.length > 1) return { plan: null, error: 'ambiguous_subscription_prices' }
  return { plan: matches[0] ?? null, error: null }
}

function subscriptionStatus(value: unknown): StripePlanStatus {
  if (value === 'trialing') return 'trialing'
  if (value === 'active') return 'active'
  if (value === 'canceled') return 'canceled'
  return 'past_due'
}

export function deriveStripePlanMutation(
  event: StripeEvent,
  priceIds?: StripePlanPriceIds,
): StripePlanMutation | null {
  const object = event.data.object
  const customer = customerId(object)
  if (!customer) return null
  const eventMetadata = metadata(object)
  const tenantHint =
    boundedString(eventMetadata['xid_tenant_id']) ?? boundedString(object['client_reference_id'])

  if (
    event.type === 'customer.subscription.created' ||
    event.type === 'customer.subscription.updated' ||
    event.type === 'customer.subscription.deleted'
  ) {
    const itemPlan = subscriptionItemPlan(object, priceIds)
    const nextPlan = itemPlan.plan ?? planHint(eventMetadata['xid_plan'])
    return {
      eventId: event.id,
      eventCreated: event.created,
      eventType: event.type,
      tenantHint,
      customerId: customer,
      planHint: nextPlan,
      planResolutionError: event.type === 'customer.subscription.deleted' ? null : itemPlan.error,
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

  return null
}
