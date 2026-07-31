// Management API v1: webhooks(订阅 CRUD,签名 secret 信封加密存储)
// 见 06 章 7、08 章 17.4。signing secret:AES-256-GCM 信封加密(@xid-kit/crypto envelopeEncrypt)。
// 路由前缀:/v1/webhooks

import { envelopeEncrypt, base64UrlEncode } from '@xid-kit/crypto'
import { createTenantDb, schema } from '@xid-kit/db'
import { and, asc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import * as v from 'valibot'
import { AppError } from '../lib/errors'
import { createPersistedId } from '../lib/persisted-id'
import type { XidHonoEnv } from '../lib/types'
import { publicHttpsUrlSchema, readJsonBody, validateBody } from '../lib/validate'
import {
  idAfterCursor,
  requireApiKeyOrTopLevelOrgManager,
  paginate,
  parsePagination,
} from './shared'

const app = new Hono<XidHonoEnv>()

// webhook 端点是 worker 出网投递目标,必须 https + 公网(SSRF 防护,见 validate.ts publicHttpsUrlSchema)。
// create 与 PATCH 必须同一标准:PATCH 放宽为裸 string 即可写入 http/内网 IP 让投递打内网。
const createWebhookBodySchema = v.object({
  url: publicHttpsUrlSchema,
  event_types: v.optional(v.array(v.string())),
})

const patchWebhookBodySchema = v.object({
  url: v.optional(publicHttpsUrlSchema),
  event_types: v.optional(v.array(v.string())),
  status: v.optional(v.string()),
})

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

// GET /v1/webhooks
app.get('/', async (c) => {
  await requireApiKeyOrTopLevelOrgManager(c, 'webhooks:read')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const { limit, cursor } = parsePagination(c)
  const active = eq(schema.webhooks.status, 'active')
  const after = idAfterCursor(schema.webhooks.id, cursor)
  const rows = await db.webhooks.findMany(after ? and(active, after) : active, {
    orderBy: asc(schema.webhooks.id),
    limit: limit + 1,
  })
  return c.json(paginate(rows.map(toResponse), (r) => r.id, limit))
})

// POST /v1/webhooks
app.post('/', async (c) => {
  await requireApiKeyOrTopLevelOrgManager(c, 'webhooks:write')
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

  return c.json({ ...toResponse(row), signing_secret: secret.publicValue }, 201)
})

// GET /v1/webhooks/:id
app.get('/:id', async (c) => {
  await requireApiKeyOrTopLevelOrgManager(c, 'webhooks:read')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const row = await db.webhooks.findOne(
    and(eq(schema.webhooks.id, c.req.param('id')), eq(schema.webhooks.status, 'active')),
  )
  if (!row) throw new AppError('not_found')
  return c.json(toResponse(row))
})

// PATCH /v1/webhooks/:id
app.patch('/:id', async (c) => {
  await requireApiKeyOrTopLevelOrgManager(c, 'webhooks:write')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(patchWebhookBodySchema, json.value)
  const where = and(eq(schema.webhooks.id, c.req.param('id')), eq(schema.webhooks.status, 'active'))
  const existing = await db.webhooks.findOne(where)
  if (!existing) throw new AppError('not_found')

  const patch: Partial<typeof schema.webhooks.$inferInsert> = {}
  if (body.url !== undefined) patch.url = body.url
  if (body.event_types !== undefined) patch.eventTypes = body.event_types
  if (body.status !== undefined) patch.status = body.status

  const updated = await db.webhooks.update(patch, where)
  const row = updated[0]
  if (!row) throw new AppError('not_found')
  return c.json(toResponse(row))
})

// DELETE /v1/webhooks/:id
app.delete('/:id', async (c) => {
  await requireApiKeyOrTopLevelOrgManager(c, 'webhooks:write')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const where = and(eq(schema.webhooks.id, c.req.param('id')), eq(schema.webhooks.status, 'active'))
  const existing = await db.webhooks.findOne(where)
  if (!existing) throw new AppError('not_found')
  await db.webhooks.update({ status: 'deleted' }, where)
  return new Response(null, { status: 204 })
})

// POST /v1/webhooks/:id/restore
app.post('/:id/restore', async (c) => {
  await requireApiKeyOrTopLevelOrgManager(c, 'webhooks:write')
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
  return c.json(toResponse(row))
})

// POST /v1/webhooks/:id/rotate-secret
app.post('/:id/rotate-secret', async (c) => {
  await requireApiKeyOrTopLevelOrgManager(c, 'webhooks:write')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const where = and(eq(schema.webhooks.id, c.req.param('id')), eq(schema.webhooks.status, 'active'))
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

  return c.json({ signing_secret: newSecret.publicValue })
})

export function registerWebhooks(parent: Hono<XidHonoEnv>): void {
  parent.route('/v1/webhooks', app)
}
