import type { StripeEvent } from './stripe-client'
import type { StripeSubscriptionMutation } from './stripe-events'

export type StripeTarget = {
  tenantId: string
  customerId: string
}

// 同一订阅的事件按 (created, priority, event_id) 排序,旧事件不覆盖新状态;不同订阅互不影响。
export function subscriptionUpsertStatement(
  env: Env,
  input: {
    event: StripeEvent
    mutation: StripeSubscriptionMutation
    tenantId: string
    now: number
  },
): D1PreparedStatement {
  const { event, mutation, tenantId, now } = input
  return env.DB.prepare(
    `INSERT INTO billing_subscriptions (
       subscription_id, tenant_id, customer_id, status, last_event_id,
       last_event_created, last_event_priority, created_at, updated_at
     )
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
     WHERE EXISTS (
       SELECT 1 FROM stripe_webhook_events
       WHERE event_id = ? AND status = 'pending'
     )
     ON CONFLICT (subscription_id) DO UPDATE SET
       customer_id = excluded.customer_id,
       status = excluded.status,
       last_event_id = excluded.last_event_id,
       last_event_created = excluded.last_event_created,
       last_event_priority = excluded.last_event_priority,
       updated_at = excluded.updated_at
     WHERE billing_subscriptions.tenant_id = excluded.tenant_id
       AND (
         excluded.last_event_created > billing_subscriptions.last_event_created
         OR (
           excluded.last_event_created = billing_subscriptions.last_event_created
           AND (
             excluded.last_event_priority > billing_subscriptions.last_event_priority
             OR (
               excluded.last_event_priority = billing_subscriptions.last_event_priority
               AND excluded.last_event_id > billing_subscriptions.last_event_id
             )
           )
         )
       )`,
  ).bind(
    mutation.subscriptionId,
    tenantId,
    mutation.customerId,
    mutation.status,
    event.id,
    event.created,
    mutation.eventPriority,
    now,
    now,
    event.id,
  )
}

const APPLIED_EVENT_PREDICATE = `EXISTS (
  SELECT 1 FROM billing_subscriptions
  WHERE subscription_id = ? AND last_event_id = ?
)`

// organization_plans 是计费账户表(表名沿用);plan 列已停用,插入时由列默认值补齐。
// 租户状态取其所有订阅中最好的一个:active > trialing > past_due > canceled。
export function billingAccountStatement(
  env: Env,
  input: {
    event: StripeEvent
    mutation: StripeSubscriptionMutation
    target: StripeTarget
    now: number
  },
): D1PreparedStatement {
  const { event, mutation, target, now } = input
  return env.DB.prepare(
    `INSERT INTO organization_plans (
       tenant_id, status, source, external_customer_id, trial_ends_at,
       effective_at, updated_by, created_at, updated_at
     )
     SELECT ?,
       (SELECT CASE MIN(CASE status
                          WHEN 'active' THEN 0
                          WHEN 'trialing' THEN 1
                          WHEN 'past_due' THEN 2
                          ELSE 3
                        END)
                 WHEN 0 THEN 'active'
                 WHEN 1 THEN 'trialing'
                 WHEN 2 THEN 'past_due'
                 ELSE 'canceled'
               END
        FROM billing_subscriptions WHERE tenant_id = ?),
       'stripe', ?, NULL, ?, NULL, ?, ?
     WHERE ${APPLIED_EVENT_PREDICATE}
     ON CONFLICT (tenant_id) DO UPDATE SET
       status = excluded.status,
       source = 'stripe',
       external_customer_id = excluded.external_customer_id,
       effective_at = excluded.effective_at,
       updated_by = NULL,
       updated_at = excluded.updated_at`,
  ).bind(
    target.tenantId,
    target.tenantId,
    target.customerId,
    event.created * 1000,
    now,
    now,
    mutation.subscriptionId,
    event.id,
  )
}

export function subscriptionAuditPayload(
  event: StripeEvent,
  mutation: StripeSubscriptionMutation,
  target: StripeTarget,
): Record<string, unknown> {
  return {
    targetType: 'billing_account',
    targetId: target.tenantId,
    eventId: event.id,
    eventType: event.type,
    subscriptionId: mutation.subscriptionId,
    status: mutation.status,
  }
}

export function subscriptionAuditStatement(
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
  return env.DB.prepare(
    `INSERT INTO platform_audit_outbox (
       id, tenant_id, org_id, action, actor_id, payload, status,
       available_at, attempt_count, created_at, updated_at
     )
     SELECT ?, ?, NULL, ?, 'system', ?, 'pending', ?, 0, ?, ?
     WHERE ${APPLIED_EVENT_PREDICATE}
       AND EXISTS (
         SELECT 1 FROM stripe_webhook_events
         WHERE event_id = ? AND status = 'pending'
       )`,
  ).bind(
    auditId,
    target.tenantId,
    mutation.auditAction,
    JSON.stringify(subscriptionAuditPayload(event, mutation, target)),
    now,
    now,
    now,
    mutation.subscriptionId,
    event.id,
    event.id,
  )
}
