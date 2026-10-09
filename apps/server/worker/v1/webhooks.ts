// Management API v1: webhooks(订阅 CRUD,签名 secret 信封加密存储)
// 见 06 章 7、08 章 17.4。signing secret:AES-256-GCM 信封加密(@xid-kit/crypto envelopeEncrypt)。
// 路由前缀:/v1/webhooks

import { envelopeEncrypt, base64UrlEncode } from '@xid-kit/crypto'
import { createTenantDb, schema, type TenantDb } from '@xid-kit/db'
import { and, asc, desc, eq, gte, inArray, lt, ne, or, type SQL } from 'drizzle-orm'
import { isWebhookSubscription, WEBHOOK_EVENT_TYPES } from '@xid-kit/types'
import { Hono } from 'hono'
import type { Context } from 'hono'
import * as v from 'valibot'
import { AppError } from '../lib/errors'
import { createPersistedId } from '../lib/persisted-id'
import type { XidHonoEnv } from '../lib/types'
import { publicHttpsUrlSchema, readJsonBody, validateBody, validateQuery } from '../lib/validate'
import { WEBHOOK_MAX_ATTEMPTS } from '../queues/webhook'
import { resolveActors } from './api-keys'
import {
  auditActorId,
  decodeCursor,
  emitManagementAuditAsync,
  encodeCursor,
  idAfterCursor,
  requireApiKeyOrTopLevelOrgManager,
  paginate,
  parsePagination,
  type OrgScopedAuth,
} from './shared'
import { userDisplayName } from './user-query'

const app = new Hono<XidHonoEnv>()

// webhook 是租户级资源,审计 orgId 记顶层组织,顶层组织管理员的审计页可见。
function auditWebhook(
  c: Context<XidHonoEnv>,
  auth: OrgScopedAuth,
  input: { action: string; webhookId: string; details?: Record<string, unknown> },
): void {
  emitManagementAuditAsync(c, {
    action: input.action,
    actorId: auditActorId(auth),
    orgId: c.get('tenant').tenantId,
    targetType: 'webhook',
    targetId: input.webhookId,
    ...(input.details ? { details: input.details } : {}),
  })
}

// webhook 端点是 worker 出网投递目标,必须 https + 公网(SSRF 防护,见 validate.ts publicHttpsUrlSchema)。
// create 与 PATCH 必须同一标准:PATCH 放宽为裸 string 即可写入 http/内网 IP 让投递打内网。
// 空数组表示订阅全部事件;每一项必须是已发出的事件名、`<object>.*` 或 `*`。
const eventTypesSchema = v.pipe(
  v.array(v.pipe(v.string(), v.check(isWebhookSubscription))),
  v.maxLength(WEBHOOK_EVENT_TYPES.length + 1),
)

const createWebhookBodySchema = v.object({
  url: publicHttpsUrlSchema,
  event_types: v.optional(eventTypesSchema),
})

// disabled 端点保留配置但不再投递(投递只读 status = 'active');deleted 只经 DELETE / restore 进出。
const WEBHOOK_LIVE_STATUSES = ['active', 'disabled'] as const

const patchWebhookBodySchema = v.object({
  url: v.optional(publicHttpsUrlSchema),
  event_types: v.optional(eventTypesSchema),
  status: v.optional(v.picklist(WEBHOOK_LIVE_STATUSES)),
})

const DELIVERY_STATUS_FILTERS = ['all', 'failed', 'pending'] as const

const deliveriesQuerySchema = v.object({
  status: v.optional(v.picklist(DELIVERY_STATUS_FILTERS), 'all'),
  cursor: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(256))),
})

const STATS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

function liveWebhookWhere(id: string): SQL | undefined {
  return and(eq(schema.webhooks.id, id), ne(schema.webhooks.status, 'deleted'))
}

type GeneratedSigningSecret = {
  publicValue: string
  key: Uint8Array
}

function base64Encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
}

// 对外 secret 使用 svix 兼容的 whsec_<standard-base64>,D1 仅信封加密存原始 32-byte HMAC key。
export function generateWebhookSigningSecret(): GeneratedSigningSecret {
  const key = crypto.getRandomValues(new Uint8Array(32))
  return {
    publicValue: `whsec_${base64Encode(key)}`,
    key,
  }
}

// KEK base64 解码(Workers Secrets 以 base64 存储)。
function decodeKek(kekBase64: string): Uint8Array {
  const bin = atob(kekBase64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

// 签名 secret 信封加密:明文 -> iv/ciphertext/tag base64url 存 D1。
async function encryptSecret(secret: Uint8Array, kekBase64: string) {
  const kek = decodeKek(kekBase64)
  try {
    // KEK version 默认 1(首版单 KEK)。
    const blob = await envelopeEncrypt(secret, kek, 1)
    return {
      signingSecretIv: base64UrlEncode(blob.iv),
      signingSecretCiphertext: base64UrlEncode(blob.ciphertext),
      signingSecretTag: base64UrlEncode(blob.tag),
    }
  } finally {
    kek.fill(0)
  }
}

function toResponse(row: typeof schema.webhooks.$inferSelect) {
  return {
    id: row.id,
    url: row.url,
    event_types: row.eventTypes,
    status: row.status,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }
}

type DeliveryRow = typeof schema.webhookDeliveries.$inferSelect

// 投递行内只有 { type, data } 信封;摘要只取主体 id 并解析显示名,不回传 payload 原文。
function deliverySubject(row: DeliveryRow): { userId: string | null; orgId: string | null } {
  const data = row.payload['data']
  const record = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {}
  const pick = (value: unknown) => (typeof value === 'string' && value ? value : null)
  return {
    userId: pick(record['userId']),
    orgId: pick(record['orgId']) ?? pick(record['organizationId']),
  }
}

async function deliverySummaries(db: TenantDb, rows: readonly DeliveryRow[]) {
  const subjects = rows.map(deliverySubject)
  const userIds = [...new Set(subjects.map((s) => s.userId).filter((id) => id !== null))]
  const orgIds = [...new Set(subjects.map((s) => s.orgId).filter((id) => id !== null))]
  const [users, orgs] = await Promise.all([
    userIds.length > 0 ? db.users.findMany(inArray(schema.users.id, userIds)) : [],
    orgIds.length > 0 ? db.organizations.findMany(inArray(schema.organizations.id, orgIds)) : [],
  ])
  const userNames = new Map(users.map((user) => [user.id, userDisplayName(user)]))
  const orgNames = new Map(orgs.map((org) => [org.id, org.name]))
  return subjects.map((subject) => ({
    userId: subject.userId,
    userName: subject.userId ? (userNames.get(subject.userId) ?? null) : null,
    organizationId: subject.orgId,
    organizationName: subject.orgId ? (orgNames.get(subject.orgId) ?? null) : null,
  }))
}

// 队列侧 dead 即「已放弃」,对外统一叫 failed。
function deliveryStatus(status: string): 'delivered' | 'failed' | 'pending' {
  if (status === 'delivered') return 'delivered'
  if (status === 'dead') return 'failed'
  return 'pending'
}

function deliveryStatusWhere(filter: (typeof DELIVERY_STATUS_FILTERS)[number]): SQL | undefined {
  if (filter === 'failed') return eq(schema.webhookDeliveries.status, 'dead')
  if (filter === 'pending') return eq(schema.webhookDeliveries.status, 'pending')
  return undefined
}

// 游标 = base64url(`${createdAtMs}:${id}`),按 created_at、id 倒序的键集分页。
function deliveryCursorWhere(cursor: string | undefined): SQL | undefined {
  if (!cursor) return undefined
  const decoded = decodeCursor(cursor)
  const separator = decoded.indexOf(':')
  const at = Number(decoded.slice(0, separator))
  const id = decoded.slice(separator + 1)
  if (separator <= 0 || !Number.isSafeInteger(at) || !id) {
    throw new AppError('validation_failed', { httpStatus: 422, meta: { paramName: 'cursor' } })
  }
  const createdAt = new Date(at)
  return or(
    lt(schema.webhookDeliveries.createdAt, createdAt),
    and(eq(schema.webhookDeliveries.createdAt, createdAt), lt(schema.webhookDeliveries.id, id)),
  )
}

async function webhookStats7d(db: TenantDb, webhookId: string, now: number) {
  const counts = await db.webhookDeliveries.countBy(
    schema.webhookDeliveries.status,
    and(
      eq(schema.webhookDeliveries.webhookId, webhookId),
      gte(schema.webhookDeliveries.createdAt, new Date(now - STATS_WINDOW_MS)),
    ),
  )
  const delivered = counts.get('delivered') ?? 0
  const failed = counts.get('dead') ?? 0
  const pending = counts.get('pending') ?? 0
  return { sent: delivered + failed + pending, delivered, failed, pending }
}

// webhooks 表没有创建者列,创建者与最近一次轮换时间取自该端点的审计事件。
async function webhookHistory(db: TenantDb, row: typeof schema.webhooks.$inferSelect) {
  const events = await db.auditEvents.findMany(
    and(
      eq(schema.auditEvents.targetType, 'webhook'),
      eq(schema.auditEvents.targetId, row.id),
      inArray(schema.auditEvents.eventType, ['webhook.created', 'webhook.secret_rotated']),
    ),
    { orderBy: desc(schema.auditEvents.seq), limit: 100 },
  )
  const created = events.find((event) => event.eventType === 'webhook.created')
  const rotated = events.find((event) => event.eventType === 'webhook.secret_rotated')
  const actors = await resolveActors(db, [created?.actorId])
  return {
    createdBy: created?.actorId ? (actors.get(created.actorId) ?? null) : null,
    secretRotatedAt: rotated?.occurredAt ?? row.createdAt.toISOString(),
  }
}

// GET /v1/webhooks
app.get('/', async (c) => {
  await requireApiKeyOrTopLevelOrgManager(c, 'webhooks:read')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const { limit, cursor } = parsePagination(c)
  const active = ne(schema.webhooks.status, 'deleted')
  const after = idAfterCursor(schema.webhooks.id, cursor)
  const rows = await db.webhooks.findMany(after ? and(active, after) : active, {
    orderBy: asc(schema.webhooks.id),
    limit: limit + 1,
  })
  return c.json(paginate(rows.map(toResponse), (r) => r.id, limit))
})

// POST /v1/webhooks
app.post('/', async (c) => {
  const auth = await requireApiKeyOrTopLevelOrgManager(c, 'webhooks:write')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(createWebhookBodySchema, json.value)

  const url = body.url
  const eventTypes = body.event_types ?? []

  const secret = generateWebhookSigningSecret()
  let encrypted: Awaited<ReturnType<typeof encryptSecret>>
  try {
    encrypted = await encryptSecret(secret.key, c.env.KEK)
  } finally {
    secret.key.fill(0)
  }

  const row = await db.webhooks.insert({
    id: createPersistedId('webhook'),
    tenantId: tenant.tenantId,
    url,
    eventTypes,
    signingSecretHash: 'v3:whsec_base64',
    signingSecretIv: encrypted.signingSecretIv,
    signingSecretCiphertext: encrypted.signingSecretCiphertext,
    signingSecretTag: encrypted.signingSecretTag,
    status: 'active',
  })
  auditWebhook(c, auth, {
    action: 'webhook.created',
    webhookId: row.id,
    details: { url, eventTypes },
  })

  return c.json({ ...toResponse(row), signing_secret: secret.publicValue }, 201)
})

// GET /v1/webhooks/:id
app.get('/:id', async (c) => {
  await requireApiKeyOrTopLevelOrgManager(c, 'webhooks:read')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const row = await db.webhooks.findOne(liveWebhookWhere(c.req.param('id')))
  if (!row) throw new AppError('not_found')
  const [stats7d, history] = await Promise.all([
    webhookStats7d(db, row.id, Date.now()),
    webhookHistory(db, row),
  ])
  return c.json({ ...toResponse(row), stats7d, ...history })
})

// GET /v1/webhooks/:id/deliveries?status=all|failed|pending&cursor=
app.get('/:id/deliveries', async (c) => {
  await requireApiKeyOrTopLevelOrgManager(c, 'webhooks:read')
  const query = validateQuery(deliveriesQuerySchema, c.req.query())
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const webhook = await db.webhooks.findOne(liveWebhookWhere(c.req.param('id')))
  if (!webhook) throw new AppError('not_found')
  const { limit } = parsePagination(c)
  const rows = await db.webhookDeliveries.findMany(
    and(
      eq(schema.webhookDeliveries.webhookId, webhook.id),
      deliveryStatusWhere(query.status),
      deliveryCursorWhere(query.cursor),
    ),
    {
      orderBy: [desc(schema.webhookDeliveries.createdAt), desc(schema.webhookDeliveries.id)],
      limit: limit + 1,
    },
  )
  const page = rows.slice(0, limit)
  const summaries = await deliverySummaries(db, page)
  const data = page.map((row, index) => {
    const status = deliveryStatus(row.status)
    return {
      id: row.id,
      eventType: row.eventType,
      summary: summaries[index],
      status,
      attemptCount: row.attemptCount,
      maxAttempts: WEBHOOK_MAX_ATTEMPTS,
      responseStatus: row.responseStatus,
      responseMs: row.responseMs,
      lastError: row.lastError,
      nextRetryAt: status === 'pending' ? (row.nextRetryAt?.toISOString() ?? null) : null,
      createdAt: row.createdAt.toISOString(),
      deliveredAt: row.deliveredAt?.toISOString() ?? null,
    }
  })
  const last = page[page.length - 1]
  const hasMore = rows.length > limit && last !== undefined
  return c.json({
    data,
    next_cursor: hasMore ? encodeCursor(`${last.createdAt.getTime()}:${last.id}`) : null,
    has_more: hasMore,
  })
})

// PATCH /v1/webhooks/:id
app.patch('/:id', async (c) => {
  const auth = await requireApiKeyOrTopLevelOrgManager(c, 'webhooks:write')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(patchWebhookBodySchema, json.value)
  const where = liveWebhookWhere(c.req.param('id'))
  const existing = await db.webhooks.findOne(where)
  if (!existing) throw new AppError('not_found')

  const patch: Partial<typeof schema.webhooks.$inferInsert> = {}
  if (body.url !== undefined) patch.url = body.url
  if (body.event_types !== undefined) patch.eventTypes = body.event_types
  if (body.status !== undefined) patch.status = body.status

  const updated = await db.webhooks.update(patch, where)
  const row = updated[0]
  if (!row) throw new AppError('not_found')
  auditWebhook(c, auth, {
    action: 'webhook.updated',
    webhookId: row.id,
    details: { url: row.url, eventTypes: row.eventTypes, status: row.status },
  })
  return c.json(toResponse(row))
})

// DELETE /v1/webhooks/:id
app.delete('/:id', async (c) => {
  const auth = await requireApiKeyOrTopLevelOrgManager(c, 'webhooks:write')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const where = liveWebhookWhere(c.req.param('id'))
  const existing = await db.webhooks.findOne(where)
  if (!existing) throw new AppError('not_found')
  await db.webhooks.update({ status: 'deleted' }, where)
  auditWebhook(c, auth, { action: 'webhook.deleted', webhookId: existing.id })
  return new Response(null, { status: 204 })
})

// POST /v1/webhooks/:id/restore
app.post('/:id/restore', async (c) => {
  const auth = await requireApiKeyOrTopLevelOrgManager(c, 'webhooks:write')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const where = and(
    eq(schema.webhooks.id, c.req.param('id')),
    eq(schema.webhooks.status, 'deleted'),
  )
  const existing = await db.webhooks.findOne(where)
  if (!existing) throw new AppError('not_found')
  const updated = await db.webhooks.update({ status: 'active' }, where)
  const row = updated[0]
  if (!row) throw new AppError('not_found')
  auditWebhook(c, auth, { action: 'webhook.restored', webhookId: row.id })
  return c.json(toResponse(row))
})

// POST /v1/webhooks/:id/rotate-secret
app.post('/:id/rotate-secret', async (c) => {
  const auth = await requireApiKeyOrTopLevelOrgManager(c, 'webhooks:write')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const where = liveWebhookWhere(c.req.param('id'))
  const existing = await db.webhooks.findOne(where)
  if (!existing) throw new AppError('not_found')

  const newSecret = generateWebhookSigningSecret()
  let encrypted: Awaited<ReturnType<typeof encryptSecret>>
  try {
    encrypted = await encryptSecret(newSecret.key, c.env.KEK)
  } finally {
    newSecret.key.fill(0)
  }

  await db.webhooks.update(
    {
      signingSecretHash: 'v3:whsec_base64',
      signingSecretIv: encrypted.signingSecretIv,
      signingSecretCiphertext: encrypted.signingSecretCiphertext,
      signingSecretTag: encrypted.signingSecretTag,
    },
    where,
  )
  auditWebhook(c, auth, { action: 'webhook.secret_rotated', webhookId: existing.id })

  return c.json({ signing_secret: newSecret.publicValue })
})

export function registerWebhooks(parent: Hono<XidHonoEnv>): void {
  parent.route('/v1/webhooks', app)
}
