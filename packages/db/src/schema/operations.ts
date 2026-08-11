// 平台运营(08 章 17+):audit 仅 INSERT;occurred_at 用 ISO TEXT 入 hash;platform_admins 无 tenant_id。

import { sql } from 'drizzle-orm'
import { index, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { createdAt, numCol, tenantId, timestamps, tsMs } from './common'

// append-only 审计,复合 PK(tenant_id, seq)。
export const auditEvents = sqliteTable(
  'audit_events',
  {
    seq: numCol('seq').notNull(),
    id: text('id').notNull(),
    sourceMessageId: text('source_message_id'),
    tenantId: tenantId(),
    orgId: text('org_id'),
    eventType: text('event_type').notNull(),
    actorId: text('actor_id'),
    actorIp: text('actor_ip'),
    targetType: text('target_type'),
    targetId: text('target_id'),
    meta: text('meta', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
    occurredAt: text('occurred_at').notNull(),
    prevHash: text('prev_hash').notNull(),
    hash: text('hash').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.seq] }),
    index('audit_events_tenant_occurred_id_idx').on(t.tenantId, t.occurredAt, t.id),
    index('audit_events_occurred_id_idx').on(t.occurredAt, t.id),
    index('audit_events_event_idx').on(t.eventType),
    index('audit_events_tenant_occurred_idx').on(t.tenantId, t.occurredAt),
    index('audit_events_tenant_actor_idx').on(t.tenantId, t.actorId),
    index('audit_events_tenant_event_idx').on(t.tenantId, t.eventType),
    uniqueIndex('audit_events_tenant_source_message_id_unq')
      .on(t.tenantId, t.sourceMessageId)
      .where(sql`${t.sourceMessageId} is not null`),
  ],
)

// 审计毒消息死信:不参与 hash 链,防单条卡死;tenant_id 可 null(消息体损坏时)。
export const auditDeadLetters = sqliteTable(
  'audit_dead_letters',
  {
    id: text('id').primaryKey(),
    messageId: text('message_id').notNull(),
    sourceMessageId: text('source_message_id'),
    tenantId: text('tenant_id'),
    reason: text('reason').notNull(),
    attempts: numCol('attempts').notNull().default(1),
    body: text('body', { mode: 'json' }).$type<unknown>(),
    failedAt: text('failed_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('audit_dead_letters_message_id_unq').on(t.messageId),
    uniqueIndex('audit_dead_letters_tenant_source_message_id_unq')
      .on(t.tenantId, t.sourceMessageId)
      .where(sql`${t.sourceMessageId} is not null`),
    index('audit_dead_letters_tenant_idx').on(t.tenantId),
    index('audit_dead_letters_failed_at_idx').on(t.failedAt),
  ],
)

export const usageDaily = sqliteTable(
  'usage_daily',
  {
    tenantId: tenantId(),
    day: text('day').notNull(),
    dau: numCol('dau').notNull().default(0),
    apiCalls: numCol('api_calls').notNull().default(0),
    emailCount: numCol('email_count').notNull().default(0),
    ...timestamps(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.day] }),
    index('usage_daily_day_idx').on(t.day, t.tenantId),
  ],
)

export const usageMonthly = sqliteTable(
  'usage_monthly',
  {
    tenantId: tenantId(),
    yearMonth: text('year_month').notNull(),
    mau: numCol('mau').notNull(),
    archivedAt: text('archived_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.yearMonth] }),
    index('usage_monthly_year_month_idx').on(t.yearMonth, t.tenantId),
  ],
)

// signing_secret_hash 遗留不可 HMAC;新建须填信封三列,旧行 null 视为不可投递,不删 hash 列。
export const webhooks = sqliteTable(
  'webhooks',
  {
    id: text('id').primaryKey(),
    tenantId: tenantId(),
    url: text('url').notNull(),
    eventTypes: text('event_types', { mode: 'json' }).$type<string[]>().notNull().default([]),
    signingSecretHash: text('signing_secret_hash').notNull(),
    signingSecretIv: text('signing_secret_iv'),
    signingSecretCiphertext: text('signing_secret_ciphertext'),
    signingSecretTag: text('signing_secret_tag'),
    status: text('status').notNull().default('active'),
    ...timestamps(),
  },
  (t) => [
    index('webhooks_tenant_status_id_idx').on(t.tenantId, t.status, t.id),
    index('webhooks_tenant_status_idx').on(t.tenantId, t.status),
  ],
)

export const webhookDeliveries = sqliteTable(
  'webhook_deliveries',
  {
    id: text('id').primaryKey(),
    deliveryKey: text('delivery_key'),
    tenantId: tenantId(),
    webhookId: text('webhook_id').notNull(),
    eventType: text('event_type').notNull(),
    payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    status: text('status').notNull().default('pending'),
    attemptCount: numCol('attempt_count').notNull().default(0),
    responseStatus: numCol('response_status'),
    nextRetryAt: tsMs('next_retry_at'),
    deliveredAt: tsMs('delivered_at'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('webhook_deliveries_delivery_key_unq')
      .on(t.deliveryKey)
      .where(sql`${t.deliveryKey} IS NOT NULL`),
    index('webhook_deliveries_tenant_webhook_status_idx').on(t.tenantId, t.webhookId, t.status),
    index('webhook_deliveries_status_retry_idx').on(t.status, t.nextRetryAt),
  ],
)

export const apiKeys = sqliteTable(
  'api_keys',
  {
    id: text('id').primaryKey(),
    tenantId: tenantId(),
    name: text('name').notNull(),
    keyHash: text('key_hash').notNull(),
    keyPrefix: text('key_prefix').notNull(),
    environment: text('environment').notNull().default('live'),
    scopes: text('scopes', { mode: 'json' }).$type<string[]>().notNull().default([]),
    lastUsedAt: tsMs('last_used_at'),
    expiresAt: tsMs('expires_at'),
    revokedAt: tsMs('revoked_at'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('api_keys_hash_unq').on(t.keyHash),
    index('api_keys_tenant_active_id_idx')
      .on(t.tenantId, t.id)
      .where(sql`${t.revokedAt} IS NULL`),
    index('api_keys_tenant_idx').on(t.tenantId),
  ],
)

// 平台级,无 tenant_id。
export const platformAdmins = sqliteTable(
  'platform_admins',
  {
    id: text('id').primaryKey(),
    instanceId: text('instance_id').notNull(),
    email: text('email').notNull(),
    role: text('role').notNull().default('platform_admin'),
    status: text('status').notNull().default('active'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('platform_admins_email_unq').on(t.email),
    index('platform_admins_instance_idx').on(t.instanceId),
  ],
)

// 通知死信:recipient/payload 不存明文密钥材料;tenant_id 可 null(平台级通知)。
export const notificationFailures = sqliteTable(
  'notification_failures',
  {
    id: text('id').primaryKey(),
    sourceMessageId: text('source_message_id'),
    tenantId: text('tenant_id'),
    channel: text('channel').notNull(),
    recipient: text('recipient').notNull(),
    type: text('type').notNull(),
    payload: text('payload', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    provider: text('provider'),
    reason: text('reason').notNull(),
    attempts: numCol('attempts').notNull().default(1),
    failedAt: text('failed_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('notification_failures_source_message_id_unq').on(t.sourceMessageId),
    index('notification_failures_tenant_idx').on(t.tenantId),
    index('notification_failures_channel_type_idx').on(t.channel, t.type),
    index('notification_failures_failed_at_idx').on(t.failedAt),
  ],
)

// Queue 不可用时可重派;recipient/payload 仅 KEK 信封,禁止明文 token/OTP 落库。
export const notificationDeliveryOutbox = sqliteTable(
  'notification_delivery_outbox',
  {
    id: text('id').primaryKey(),
    tenantId: tenantId(),
    deliveryKey: text('delivery_key').notNull(),
    sourceMessageId: text('source_message_id'),
    deliveryIdentity: text('delivery_identity'),
    channel: text('channel').notNull(),
    type: text('type').notNull(),
    provider: text('provider'),
    recipientHash: text('recipient_hash').notNull(),
    recipientIv: text('recipient_iv').notNull(),
    recipientCiphertext: text('recipient_ciphertext').notNull(),
    recipientTag: text('recipient_tag').notNull(),
    payloadIv: text('payload_iv').notNull(),
    payloadCiphertext: text('payload_ciphertext').notNull(),
    payloadTag: text('payload_tag').notNull(),
    status: text('status').notNull().default('pending'),
    attemptCount: numCol('attempt_count').notNull().default(0),
    availableAt: tsMs('available_at').notNull(),
    leaseUntil: tsMs('lease_until'),
    lastErrorCode: text('last_error_code'),
    failureKind: text('failure_kind'),
    failedAt: tsMs('failed_at'),
    providerAcceptedAt: tsMs('provider_accepted_at'),
    auditQueuedAt: tsMs('audit_queued_at'),
    queuedAt: tsMs('queued_at'),
    deliveredAt: tsMs('delivered_at'),
    deadAt: tsMs('dead_at'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('notification_delivery_outbox_tenant_delivery_key_unq').on(
      t.tenantId,
      t.deliveryKey,
    ),
    uniqueIndex('notification_delivery_outbox_tenant_delivery_identity_unq')
      .on(t.tenantId, t.deliveryIdentity)
      .where(sql`${t.deliveryIdentity} IS NOT NULL`),
    index('notification_delivery_outbox_tenant_ready_idx').on(t.tenantId, t.status, t.availableAt),
    index('notification_delivery_outbox_dispatch_idx').on(t.status, t.availableAt, t.leaseUntil),
    index('notification_delivery_outbox_failure_idx').on(t.status, t.failureKind, t.failedAt),
  ],
)

// provider 明确拒绝与结果不确定单独落库;不确定结果禁止 Queue 自动重发外部。
export const notificationDeliveryFailures = sqliteTable(
  'notification_delivery_failures',
  {
    id: text('id').primaryKey(),
    tenantId: tenantId(),
    channel: text('channel').notNull(),
    sourceMessageId: text('source_message_id').notNull(),
    deliveryIdentity: text('delivery_identity').notNull(),
    provider: text('provider').notNull(),
    outcome: text('outcome').notNull(),
    reason: text('reason').notNull(),
    attemptCount: numCol('attempt_count').notNull(),
    failedAt: tsMs('failed_at').notNull(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('notification_delivery_failures_tenant_identity_unq').on(
      t.tenantId,
      t.deliveryIdentity,
    ),
    index('notification_delivery_failures_tenant_outcome_idx').on(
      t.tenantId,
      t.outcome,
      t.failedAt,
    ),
    index('notification_delivery_failures_channel_source_idx').on(t.channel, t.sourceMessageId),
  ],
)

// 业务 Queue 死信:原消息仅 KEK 密文;API 不返回 ciphertext;event_type/error_code 禁载用户输入。
export const queueDeadLetters = sqliteTable(
  'queue_dead_letters',
  {
    id: text('id').primaryKey(),
    sourceQueue: text('source_queue').notNull(),
    deadLetterQueue: text('dead_letter_queue').notNull(),
    messageId: text('message_id').notNull(),
    tenantId: text('tenant_id'),
    orgId: text('org_id'),
    eventType: text('event_type').notNull().default('unknown'),
    errorCode: text('error_code').notNull().default('consumer_retries_exhausted'),
    status: text('status').notNull().default('pending'),
    attempts: numCol('attempts').notNull().default(1),
    payloadIv: text('payload_iv').notNull(),
    payloadCiphertext: text('payload_ciphertext').notNull(),
    payloadTag: text('payload_tag').notNull(),
    payloadKekVersion: numCol('payload_kek_version').notNull().default(1),
    sourceEnqueuedAt: tsMs('source_enqueued_at').notNull(),
    failedAt: tsMs('failed_at').notNull(),
    replayRequestedAt: tsMs('replay_requested_at'),
    replayedAt: tsMs('replayed_at'),
    replayedBy: text('replayed_by'),
    replayCount: numCol('replay_count').notNull().default(0),
    lastReplayErrorCode: text('last_replay_error_code'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('queue_dead_letters_source_message_unq').on(t.sourceQueue, t.messageId),
    index('queue_dead_letters_status_failed_id_idx').on(t.status, t.failedAt, t.id),
    index('queue_dead_letters_tenant_failed_id_idx').on(t.tenantId, t.failedAt, t.id),
    index('queue_dead_letters_source_status_idx').on(t.sourceQueue, t.status),
  ],
)

// 部署方计费元数据,非许可证门闸;鉴权路径永不读此表。
export const organizationPlans = sqliteTable(
  'organization_plans',
  {
    tenantId: text('tenant_id').primaryKey(),
    plan: text('plan').notNull().default('free'),
    status: text('status').notNull().default('active'),
    source: text('source').notNull().default('manual'),
    externalCustomerId: text('external_customer_id'),
    trialEndsAt: tsMs('trial_ends_at'),
    effectiveAt: tsMs('effective_at').notNull(),
    updatedBy: text('updated_by'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('organization_plans_external_customer_unq')
      .on(t.externalCustomerId)
      .where(sql`${t.externalCustomerId} IS NOT NULL`),
    index('organization_plans_plan_status_idx').on(t.plan, t.status, t.tenantId),
  ],
)

// 配额只管资源创建/运营计量,不挡登录;null=无限;seats 计全租户 active 成员,seat_limit 仅兼容镜像。
export const organizationQuotas = sqliteTable(
  'organization_quotas',
  {
    tenantId: tenantId(),
    quotaKey: text('quota_key').notNull(),
    limit: numCol('limit'),
    enforcement: text('enforcement').notNull().default('observe'),
    updatedBy: text('updated_by'),
    ...timestamps(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.quotaKey] }),
    index('organization_quotas_key_tenant_idx').on(t.quotaKey, t.tenantId),
  ],
)

// 先落 pending identifier 再调 Stripe,防 D1 失败导致用量双报。
export const billingMeterReports = sqliteTable(
  'billing_meter_reports',
  {
    tenantId: tenantId(),
    meterKey: text('meter_key').notNull(),
    period: text('period').notNull(),
    reportedValue: numCol('reported_value').notNull().default(0),
    pendingIdentifier: text('pending_identifier'),
    pendingValue: numCol('pending_value'),
    pendingTarget: numCol('pending_target'),
    pendingCustomerId: text('pending_customer_id'),
    pendingEventName: text('pending_event_name'),
    pendingTimestamp: numCol('pending_timestamp'),
    pendingReservedAt: tsMs('pending_reserved_at'),
    providerAcceptedAt: tsMs('provider_accepted_at'),
    reconciliationRequiredAt: tsMs('reconciliation_required_at'),
    ...timestamps(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.meterKey, t.period] }),
    uniqueIndex('billing_meter_reports_pending_identifier_unq')
      .on(t.pendingIdentifier)
      .where(sql`${t.pendingIdentifier} IS NOT NULL`),
    index('billing_meter_reports_period_meter_tenant_idx').on(t.period, t.meterKey, t.tenantId),
  ],
)

// 每租户一个活跃 Checkout 预留;幂等键先落库,未过期 session 复用。
export const stripeCheckoutReservations = sqliteTable(
  'stripe_checkout_reservations',
  {
    tenantId: text('tenant_id').primaryKey(),
    requestId: text('request_id').notNull(),
    plan: text('plan').notNull(),
    customerId: text('customer_id'),
    providerIdempotencyKey: text('provider_idempotency_key').notNull(),
    sessionId: text('session_id'),
    sessionUrl: text('session_url'),
    expiresAt: tsMs('expires_at'),
    status: text('status').notNull().default('reserved'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('stripe_checkout_reservations_provider_key_unq').on(t.providerIdempotencyKey),
    index('stripe_checkout_reservations_status_expiry_idx').on(t.status, t.expiresAt, t.tenantId),
  ],
)

// Stripe event id 作幂等键,先落库再应用,防重试重复计费标签切换。
export const stripeWebhookEvents = sqliteTable(
  'stripe_webhook_events',
  {
    eventId: text('event_id').primaryKey(),
    eventType: text('event_type').notNull(),
    tenantId: text('tenant_id'),
    eventCreated: tsMs('event_created').notNull(),
    status: text('status').notNull(),
    errorCode: text('error_code'),
    processedAt: tsMs('processed_at'),
    ...timestamps(),
  },
  (t) => [
    index('stripe_webhook_events_status_created_event_idx').on(t.status, t.createdAt, t.eventId),
    index('stripe_webhook_events_tenant_event_created_idx').on(
      t.tenantId,
      t.eventCreated,
      t.eventId,
    ),
  ],
)

export const platformAnnouncements = sqliteTable(
  'platform_announcements',
  {
    id: text('id').primaryKey(),
    scopeType: text('scope_type').notNull().default('global'),
    scopeValue: text('scope_value'),
    title: text('title').notNull(),
    body: text('body').notNull(),
    severity: text('severity').notNull().default('info'),
    status: text('status').notNull().default('draft'),
    startsAt: tsMs('starts_at').notNull(),
    endsAt: tsMs('ends_at'),
    createdBy: text('created_by').notNull(),
    updatedBy: text('updated_by').notNull(),
    ...timestamps(),
  },
  (t) => [
    index('platform_announcements_status_window_idx').on(t.status, t.startsAt, t.endsAt),
    index('platform_announcements_scope_idx').on(t.scopeType, t.scopeValue, t.status),
  ],
)

export const statusIncidents = sqliteTable(
  'status_incidents',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    status: text('status').notNull().default('investigating'),
    impact: text('impact').notNull().default('minor'),
    summary: text('summary').notNull(),
    startedAt: tsMs('started_at').notNull(),
    resolvedAt: tsMs('resolved_at'),
    createdBy: text('created_by').notNull(),
    updatedBy: text('updated_by').notNull(),
    ...timestamps(),
  },
  (t) => [
    index('status_incidents_status_started_idx').on(t.status, t.startedAt, t.id),
    index('status_incidents_started_id_idx').on(t.startedAt, t.id),
  ],
)

export const statusIncidentUpdates = sqliteTable(
  'status_incident_updates',
  {
    id: text('id').primaryKey(),
    incidentId: text('incident_id').notNull(),
    status: text('status').notNull(),
    message: text('message').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('status_incident_updates_incident_created_idx').on(t.incidentId, t.createdAt, t.id),
  ],
)

export const privacyRequests = sqliteTable(
  'privacy_requests',
  {
    id: text('id').primaryKey(),
    tenantId: tenantId(),
    userId: text('user_id').notNull(),
    requestType: text('request_type').notNull(),
    status: text('status').notNull().default('pending'),
    storageKey: text('storage_key'),
    contentType: text('content_type'),
    availableAt: tsMs('available_at'),
    expiresAt: tsMs('expires_at'),
    scheduledFor: tsMs('scheduled_for'),
    processingStartedAt: tsMs('processing_started_at'),
    completedAt: tsMs('completed_at'),
    canceledAt: tsMs('canceled_at'),
    errorCode: text('error_code'),
    ...timestamps(),
  },
  (t) => [
    index('privacy_requests_tenant_user_created_idx').on(t.tenantId, t.userId, t.createdAt, t.id),
    index('privacy_requests_due_idx').on(t.requestType, t.status, t.scheduledFor, t.id),
  ],
)

export const complianceDocuments = sqliteTable(
  'compliance_documents',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id'),
    documentType: text('document_type').notNull(),
    title: text('title').notNull(),
    status: text('status').notNull().default('available'),
    storageKey: text('storage_key'),
    checksum: text('checksum'),
    version: text('version').notNull(),
    acceptedBy: text('accepted_by'),
    acceptedAt: tsMs('accepted_at'),
    generatedBy: text('generated_by'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('compliance_documents_tenant_type_version_unq').on(
      t.tenantId,
      t.documentType,
      t.version,
    ),
    index('compliance_documents_type_status_idx').on(t.documentType, t.status, t.tenantId),
  ],
)

// 平台变更先落脱敏审计意图;Cron 用 outbox id 作 sourceMessageId 重投,保 append-only 链。
export const platformAuditOutbox = sqliteTable(
  'platform_audit_outbox',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    orgId: text('org_id'),
    action: text('action').notNull(),
    actorId: text('actor_id'),
    payload: text('payload', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    status: text('status').notNull().default('pending'),
    availableAt: tsMs('available_at').notNull(),
    queuedAt: tsMs('queued_at'),
    attemptCount: numCol('attempt_count').notNull().default(0),
    lastErrorCode: text('last_error_code'),
    ...timestamps(),
  },
  (t) => [
    index('platform_audit_outbox_ready_idx').on(t.status, t.availableAt, t.id),
    index('platform_audit_outbox_tenant_created_idx').on(t.tenantId, t.createdAt, t.id),
  ],
)
