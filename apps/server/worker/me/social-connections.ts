// GET /v1/me/social-connections:当前用户社交登录绑定(account/types.ts SocialConnection 契约,camelCase)。
// 映射 user_identities(identity_type='oauth'):id/provider/providerAccountId/email/connectedAt。
// 认证:cookie session;租户隔离:createTenantDb。token 密文(access/refresh)绝不外泄。

import { createTenantDb, schema, USER_PROVISIONED_BY_ANONYMOUS } from '@xid-kit/db'
import { and, asc, eq, gt, isNull } from 'drizzle-orm'
import { Hono } from 'hono'
import * as v from 'valibot'
import { startSocialLink } from '../auth/social-link'
import { AppError } from '../lib/errors'
import { requireStepUp } from '../lib/step-up'
import type { XidHonoEnv } from '../lib/types'
import { readAllById, requireSession } from './shared'
import { hasOtherSignInMethod } from './sign-in-methods'

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

// 与 /auth/:provider/authorize 同一形状收窄;是否已配置由 startSocialLink 判断。
const providerParamSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(128))

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

// POST /v1/me/social-connections/:provider/link:返回 provider 授权地址,SPA 整页跳转;
// 新增登录方式属于敏感改动,有强因子的用户先 step-up。
app.post('/:provider/link', async (c) => {
  const session = await requireSession(c)
  const tenant = c.get('tenant')
  const parsed = v.safeParse(providerParamSchema, c.req.param('provider'))
  if (!parsed.success) throw new AppError('invalid_request')
  // 访客转正走社交登录本身(会同时完成转正);这里只关联,不能替访客转正。
  const user = await createTenantDb(c.env.DB, tenant).users.findOne(
    eq(schema.users.id, session.userId),
  )
  if (!user || user.provisionedBy === USER_PROVISIONED_BY_ANONYMOUS) {
    throw new AppError('conflict', { httpStatus: 409 })
  }
  await requireStepUp(c, tenant, session)
  const url = await startSocialLink(c, { provider: parsed.output, session })
  return c.json({ url })
})

app.delete('/:id', async (c) => {
  const session = await requireSession(c)
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const id = c.req.param('id')
  const where = and(
    eq(schema.userIdentities.id, id),
    eq(schema.userIdentities.userId, session.userId),
    eq(schema.userIdentities.identityType, 'oauth'),
    isNull(schema.userIdentities.revokedAt),
  )
  const existing = await db.userIdentities.findOne(where)
  if (!existing) throw new AppError('not_found', { httpStatus: 404 })
  await requireStepUp(c, tenant, session)
  const removed = { kind: 'identity', id: existing.id } as const
  if (!(await hasOtherSignInMethod(c, { userId: session.userId, removed }))) {
    throw new AppError('sign_in_method_required')
  }
  await db.userIdentities.update({ revokedAt: new Date() }, where)
  await c.env.AUDIT_QUEUE.send({
    tenantId: tenant.tenantId,
    action: 'connection.unlinked',
    actorId: session.userId,
    ts: Date.now(),
    payload: { provider: existing.provider, idpUserId: existing.providerUserId },
  })
  return new Response(null, { status: 204 })
})

export function registerSocialConnectionsRoutes(honoApp: Hono<XidHonoEnv>): void {
  honoApp.route('/v1/me/social-connections', app)
}
