// GET /v1/me/passkeys:当前用户 passkey 列表(account/hooks.ts PasskeyCredential 契约,camelCase)。
// 认证:cookie session;租户隔离:createTenantDb。
// 安全:public_key/aaguid/sign_count/cose_alg 绝不外泄(私钥永不入库,公钥也不回前端,见 webauthn rule)。

import { createTenantDb, schema } from '@xid-kit/db'
import { and, eq, isNull } from 'drizzle-orm'
import { Hono } from 'hono'
import * as v from 'valibot'
import { PASSKEY_LIMIT } from '../auth/passkey-helpers'
import { AppError } from '../lib/errors'
import type { XidHonoEnv } from '../lib/types'
import { readJsonBody, validateBody } from '../lib/validate'
import { requireSession, toIso } from './shared'

// PATCH body:deviceName 可清空(null/空串);长度上限防异常长串落库。
const renamePasskeyBodySchema = v.object({
  deviceName: v.optional(v.nullable(v.pipe(v.string(), v.trim(), v.maxLength(100)))),
})

type PasskeyView = {
  id: string
  deviceName: string | null
  createdAt: string
  lastUsedAt: string | null
  transports: readonly string[]
}

function toPasskeyView(row: typeof schema.passkeyCredentials.$inferSelect): PasskeyView {
  return {
    id: row.id,
    deviceName: row.deviceName ?? null,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: toIso(row.lastUsedAt),
    transports: row.transports,
  }
}

const app = new Hono<XidHonoEnv>()

// GET /v1/me/passkeys
app.get('/', async (c) => {
  const session = await requireSession(c)
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const rows = await db.passkeyCredentials.findMany(
    and(
      eq(schema.passkeyCredentials.userId, session.userId),
      isNull(schema.passkeyCredentials.revokedAt),
    ),
    { limit: PASSKEY_LIMIT },
  )
  return c.json(rows.map(toPasskeyView))
})

app.patch('/:id', async (c) => {
  const session = await requireSession(c)
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const id = c.req.param('id')
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(renamePasskeyBodySchema, json.value)

  const where = and(
    eq(schema.passkeyCredentials.id, id),
    eq(schema.passkeyCredentials.userId, session.userId),
    isNull(schema.passkeyCredentials.revokedAt),
  )
  const existing = await db.passkeyCredentials.findOne(where)
  if (!existing) throw new AppError('not_found', { httpStatus: 404 })

  const deviceName = body.deviceName ?? null
  const [updated] = await db.passkeyCredentials.update({ deviceName: deviceName || null }, where)
  if (!updated) throw new AppError('not_found', { httpStatus: 404 })
  return c.json(toPasskeyView(updated))
})

app.delete('/:id', async (c) => {
  const session = await requireSession(c)
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const id = c.req.param('id')
  const where = and(
    eq(schema.passkeyCredentials.id, id),
    eq(schema.passkeyCredentials.userId, session.userId),
    isNull(schema.passkeyCredentials.revokedAt),
  )
  const existing = await db.passkeyCredentials.findOne(where)
  if (!existing) throw new AppError('not_found', { httpStatus: 404 })
  await db.passkeyCredentials.update({ revokedAt: new Date() }, where)
  return new Response(null, { status: 204 })
})

export function registerPasskeysRoutes(honoApp: Hono<XidHonoEnv>): void {
  honoApp.route('/v1/me/passkeys', app)
}
