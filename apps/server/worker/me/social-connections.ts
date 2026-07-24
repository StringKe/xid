// GET /v1/me/social-connections:当前用户社交登录绑定(account/hooks.ts SocialConnection 契约,camelCase)。
// 映射 user_identities(identity_type='oauth'):id/provider/providerAccountId/email/connectedAt。
// 认证:cookie session;租户隔离:createTenantDb。token 密文(access/refresh)绝不外泄。

import { createTenantDb, schema } from '@xid-kit/db'
import { and, asc, eq, gt, isNull } from 'drizzle-orm'
import { Hono } from 'hono'
import { AppError } from '../lib/errors'
import type { XidHonoEnv } from '../lib/types'
import { readAllById, requireSession } from './shared'

type SocialConnection = {
  id: string
  provider: string
  providerAccountId: string
  email: string | null
  connectedAt: string
}

// profile_raw.email -> string | null(profile_raw 是任意 JSON,email 字段非 string 时回退 null)。
function emailFromProfile(profileRaw: Record<string, unknown> | null): string | null {
  const value = profileRaw?.['email']
  return typeof value === 'string' ? value : null
}

function toSocialConnection(row: typeof schema.userIdentities.$inferSelect): SocialConnection {
  return {
    id: row.id,
    provider: row.provider ?? '',
    providerAccountId: row.providerUserId ?? '',
    email: emailFromProfile(row.profileRaw ?? null),
    connectedAt: row.createdAt.toISOString(),
  }
}

const app = new Hono<XidHonoEnv>()

// GET /v1/me/social-connections
app.get('/', async (c) => {
  const session = await requireSession(c)
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const rows = await readAllById((cursor, limit) => {
    const active = and(
      eq(schema.userIdentities.userId, session.userId),
      eq(schema.userIdentities.identityType, 'oauth'),
      isNull(schema.userIdentities.revokedAt),
    )
    return db.userIdentities.findMany(
      cursor ? and(active, gt(schema.userIdentities.id, cursor)) : active,
      { orderBy: asc(schema.userIdentities.id), limit },
    )
  })
  return c.json(rows.map(toSocialConnection))
})

app.delete('/:id', async (c) => {
  const session = await requireSession(c)
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const id = c.req.param('id')
  const where = and(
    eq(schema.userIdentities.id, id),
    eq(schema.userIdentities.userId, session.userId),
    eq(schema.userIdentities.identityType, 'oauth'),
    isNull(schema.userIdentities.revokedAt),
  )
  const existing = await db.userIdentities.findOne(where)
  if (!existing) throw new AppError('not_found', { httpStatus: 404 })
  await db.userIdentities.update({ revokedAt: new Date() }, where)
  return new Response(null, { status: 204 })
})

export function registerSocialConnectionsRoutes(honoApp: Hono<XidHonoEnv>): void {
  honoApp.route('/v1/me/social-connections', app)
}
