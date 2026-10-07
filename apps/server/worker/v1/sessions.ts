// Management API v1: /v1/sessions 会话资源。
// list(cursor 分页,按 user_id 筛选)+ revoke(走 SessionDO 强一致)。
// 撤销:先更新 SessionDO(强一致,JWT 60s 窗口),再落 D1 status=revoked。
// 认证:sk_live_ Bearer,或顶层组织管理员 cookie 会话。租户隔离:createTenantDb。
// 响应字段白名单:不返回 refresh_token_hash 与 device_fingerprint_hash。

import { createTenantDb, schema } from '@xid-kit/db'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { XidHonoEnv } from '../lib/types'
import { AppError } from '../lib/errors'
import { sessionDoRevoke, sessionDoRevokeAll } from '../lib/session'
import {
  auditActorId,
  emitManagementAuditAsync,
  idAfterCursor,
  paginate,
  parsePagination,
  requireApiKeyOrTopLevelOrgManager,
  type OrgScopedAuth,
} from './shared'
import { notDeletedUser, userDisplayName } from './user-query'

const app = new Hono<XidHonoEnv>()

type SessionRow = typeof schema.sessions.$inferSelect

function toSessionResponse(row: SessionRow, impersonatorDisplayName: string | null) {
  return {
    id: row.id,
    userId: row.userId,
    activeOrgId: row.activeOrgId,
    deviceName: row.deviceName,
    userAgent: row.userAgent,
    ip: row.ip,
    location: row.location,
    status: row.status,
    rememberMe: row.rememberMe,
    isImpersonation: row.isImpersonation,
    impersonatorUserId: row.impersonatorUserId,
    impersonatorDisplayName,
    acr: row.acr,
    amr: row.amr,
    aal: row.aal,
    authenticatedAt: row.authenticatedAt,
    lastActiveAt: row.lastActiveAt,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  }
}

async function impersonatorNames(
  c: Context<XidHonoEnv>,
  rows: readonly SessionRow[],
): Promise<Map<string, string>> {
  const ids = [
    ...new Set(rows.map((row) => row.impersonatorUserId).filter((id): id is string => Boolean(id))),
  ]
  if (ids.length === 0) return new Map()
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const users = await db.users.findMany(inArray(schema.users.id, ids), { limit: ids.length })
  const names = new Map<string, string>()
  for (const user of users) {
    const name = userDisplayName(user)
    if (name) names.set(user.id, name)
  }
  return names
}

function auditSessionRevoke(
  c: Context<XidHonoEnv>,
  auth: OrgScopedAuth,
  input: { action: string; targetType: string; targetId: string; userId: string },
): void {
  emitManagementAuditAsync(c, {
    action: input.action,
    actorId: auditActorId(auth),
    orgId: c.get('tenant').tenantId,
    targetType: input.targetType,
    targetId: input.targetId,
    details: { userId: input.userId },
  })
}

// GET /v1/sessions?limit=&cursor=&user_id=
app.get('/', async (c) => {
  await requireApiKeyOrTopLevelOrgManager(c, 'sessions:read')
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const { limit, cursor } = parsePagination(c)
  const userId = c.req.query('user_id')
  const rows = await db.sessions.findMany(
    and(
      eq(schema.sessions.status, 'active'),
      userId ? eq(schema.sessions.userId, userId) : undefined,
      idAfterCursor(schema.sessions.id, cursor),
    ),
    { orderBy: asc(schema.sessions.id), limit: limit + 1 },
  )
  const page = paginate(rows, (row) => row.id, limit)
  const names = await impersonatorNames(c, page.data)
  return c.json({
    ...page,
    data: page.data.map((row) =>
      toSessionResponse(
        row,
        row.impersonatorUserId ? (names.get(row.impersonatorUserId) ?? null) : null,
      ),
    ),
  })
})

// GET /v1/sessions/:id
app.get('/:id', async (c) => {
  await requireApiKeyOrTopLevelOrgManager(c, 'sessions:read')
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const row = await db.sessions.findOne(
    and(eq(schema.sessions.id, c.req.param('id')), eq(schema.sessions.status, 'active')),
  )
  if (!row) throw new AppError('not_found', { httpStatus: 404 })
  const names = await impersonatorNames(c, [row])
  return c.json(
    toSessionResponse(
      row,
      row.impersonatorUserId ? (names.get(row.impersonatorUserId) ?? null) : null,
    ),
  )
})

// POST /v1/sessions/:id/revoke
app.post('/:id/revoke', async (c) => {
  const auth = await requireApiKeyOrTopLevelOrgManager(c, 'sessions:write')
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const id = c.req.param('id')
  const row = await db.sessions.findOne(eq(schema.sessions.id, id))
  if (!row) throw new AppError('not_found', { httpStatus: 404 })
  if (row.status === 'revoked') return c.json(toSessionResponse(row, null))

  await sessionDoRevoke(c.env, row.userId, id)
  await db.sessions.update({ status: 'revoked' }, eq(schema.sessions.id, id))
  auditSessionRevoke(c, auth, {
    action: 'session.revoked',
    targetType: 'session',
    targetId: id,
    userId: row.userId,
  })
  return c.json({ revoked: true, session_id: id })
})

// POST /v1/sessions/users/:userId/revoke_all:active 与 banned 用户都可撤销(暂停后立即下线);已删除用户 404。
app.post('/users/:userId/revoke_all', async (c) => {
  const auth = await requireApiKeyOrTopLevelOrgManager(c, 'sessions:write')
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const userId = c.req.param('userId')
  const user = await db.users.findOne(and(eq(schema.users.id, userId), notDeletedUser()))
  if (!user) throw new AppError('not_found', { httpStatus: 404 })

  await sessionDoRevokeAll(c.env, userId)
  await db.sessions.update(
    { status: 'revoked' },
    and(eq(schema.sessions.userId, userId), eq(schema.sessions.status, 'active')),
  )
  auditSessionRevoke(c, auth, {
    action: 'user.sessions_revoked',
    targetType: 'user',
    targetId: userId,
    userId,
  })
  return c.json({ revoked: true, user_id: userId })
})

export function registerSessionsRoutes(honoApp: Hono<XidHonoEnv>): void {
  honoApp.route('/v1/sessions', app)
}
