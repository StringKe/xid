// GET / PATCH /v1/me/profile:account portal 用户档案(account/hooks.ts UserProfile 契约,camelCase)。
// 认证:cookie session(requireSession);租户隔离:createTenantDb。
// email 只读(前端 disabled),PATCH 仅接受 firstName/lastName/displayName/locale/timezone 五字段。
// 见 docs/design/05-users-sessions.md、tenant-isolation rule。

import { createTenantDb, schema } from '@xid-kit/db'
import { and, eq, isNull } from 'drizzle-orm'
import { Hono } from 'hono'
import type { Context } from 'hono'
import * as v from 'valibot'
import { AppError } from '../lib/errors'
import type { XidHonoEnv } from '../lib/types'
import { readJsonBody, validateBody } from '../lib/validate'
import { loadPrimaryEmail, requireSession } from './shared'

type UserProfile = {
  id: string
  firstName: string | null
  lastName: string | null
  displayName: string | null
  email: string
  emailVerified: boolean
  imageUrl: string | null
  locale: string | null
  timezone: string | null
}

// users 行 + primary email -> UserProfile(camelCase 契约,非 /v1/users 的 snake_case)。
async function toUserProfile(
  c: Context<XidHonoEnv>,
  row: typeof schema.users.$inferSelect,
): Promise<UserProfile> {
  const primaryEmail = await loadPrimaryEmail(c, row.id, row.primaryEmailId)
  return {
    id: row.id,
    firstName: row.firstName ?? null,
    lastName: row.lastName ?? null,
    displayName: row.displayName ?? null,
    email: primaryEmail?.email ?? '',
    emailVerified: primaryEmail?.verified ?? false,
    imageUrl: row.avatarUrl ?? null,
    locale: row.locale ?? null,
    timezone: row.timezone ?? null,
  }
}

// PATCH body:全可选,前端始终发全字段、空串转 null。仅取这五字段,忽略其它(不接受 metadata/username/external_id)。
// 形状失败带 meta.paramName=字段名,供前端精确映射(见 error-handling rule)。
const updateProfileBodySchema = v.object({
  firstName: v.optional(v.nullable(v.string())),
  lastName: v.optional(v.nullable(v.string())),
  displayName: v.optional(v.nullable(v.string())),
  locale: v.optional(v.nullable(v.string())),
  timezone: v.optional(v.nullable(v.string())),
})
type UpdateProfileBody = v.InferOutput<typeof updateProfileBodySchema>

// 组装 patch:只取白名单五字段(对照 users.ts PATCH 但收窄;不接受 metadata/username/external_id)。
function buildProfilePatch(body: UpdateProfileBody): Partial<typeof schema.users.$inferInsert> {
  const patch: Partial<typeof schema.users.$inferInsert> = {}
  if (body.firstName !== undefined) patch.firstName = body.firstName
  if (body.lastName !== undefined) patch.lastName = body.lastName
  if (body.displayName !== undefined) patch.displayName = body.displayName
  if (body.locale !== undefined) patch.locale = body.locale
  if (body.timezone !== undefined) patch.timezone = body.timezone
  return patch
}

const app = new Hono<XidHonoEnv>()

// GET /v1/me/profile
app.get('/', async (c) => {
  const session = await requireSession(c)
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const row = await db.users.findOne(
    and(
      eq(schema.users.id, session.userId),
      eq(schema.users.status, 'active'),
      isNull(schema.users.deletedAt),
    ),
  )
  if (!row) throw new AppError('unauthorized', { httpStatus: 401 })
  return c.json(await toUserProfile(c, row))
})

// PATCH /v1/me/profile
app.patch('/', async (c) => {
  const session = await requireSession(c)
  const db = createTenantDb(c.env.DB, c.get('tenant'))

  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(updateProfileBodySchema, json.value)

  const where = and(
    eq(schema.users.id, session.userId),
    eq(schema.users.status, 'active'),
    isNull(schema.users.deletedAt),
  )
  const existing = await db.users.findOne(where)
  if (!existing) throw new AppError('unauthorized', { httpStatus: 401 })

  const patch = buildProfilePatch(body)
  const updated =
    Object.keys(patch).length > 0 ? (await db.users.update(patch, where))[0] : existing
  if (!updated) throw new AppError('unauthorized', { httpStatus: 401 })

  return c.json(await toUserProfile(c, updated))
})

export function registerProfileRoutes(honoApp: Hono<XidHonoEnv>): void {
  honoApp.route('/v1/me/profile', app)
}
