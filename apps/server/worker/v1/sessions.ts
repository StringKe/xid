// Management API v1: /v1/sessions 会话资源。
// list(cursor 分页,按 user_id 筛选)+ revoke(走 SessionDO 强一致)。
// 撤销:先更新 SessionDO(强一致,JWT 60s 窗口),再异步落 D1 status=revoked。
// 见 cloudflare-bindings rule 会话存储方案 + anti-abuse rule。
// 认证:sk_live_ Bearer。租户隔离:createTenantDb。

import { createTenantDb, schema } from '@xid-kit/db'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { Hono } from 'hono'
import type { XidHonoEnv } from '../lib/types'
import { AppError } from '../lib/errors'
import { sessionDoStub, sessionDoRevokeAll } from '../lib/session'
import { requireApiKey, parsePagination, paginate, idAfterCursor } from './shared'

const app = new Hono<XidHonoEnv>()

// ---- 列表 ----

// GET /v1/sessions?limit=&cursor=&user_id=
app.get('/', async (c) => {
  await requireApiKey(c, 'sessions:read')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const { limit, cursor } = parsePagination(c)
  const userId = c.req.query('user_id') ?? null

  const afterCond = idAfterCursor(schema.sessions.id, cursor)

  let rows: (typeof schema.sessions.$inferSelect)[]
  const activeCond = eq(schema.sessions.status, 'active')
  if (userId) {
    const userCond = eq(schema.sessions.userId, userId)
    const where = afterCond ? and(activeCond, userCond, afterCond) : and(activeCond, userCond)
    rows = await db.sessions.findMany(where, {
      orderBy: asc(schema.sessions.id),
      limit: limit + 1,
    })
  } else {
    rows = await db.sessions.findMany(afterCond ? and(activeCond, afterCond) : activeCond, {
      orderBy: asc(schema.sessions.id),
      limit: limit + 1,
    })
  }

  return c.json(paginate(rows.map(safeSession), (r) => r.id, limit))
})

// ---- 单个 ----

// GET /v1/sessions/:id
app.get('/:id', async (c) => {
  await requireApiKey(c, 'sessions:read')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const id = c.req.param('id')
  const row = await db.sessions.findOne(
    and(eq(schema.sessions.id, id), eq(schema.sessions.status, 'active')),
  )
  if (!row) throw new AppError('not_found', { httpStatus: 404 })
  return c.json(safeSession(row))
})

// ---- 撤销单条 ----

// POST /v1/sessions/:id/revoke
app.post('/:id/revoke', async (c) => {
  await requireApiKey(c, 'sessions:write')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const id = c.req.param('id')

  const row = await db.sessions.findOne(eq(schema.sessions.id, id))
  if (!row) throw new AppError('not_found', { httpStatus: 404 })
  if (row.status === 'revoked') {
    return c.json(safeSession(row))
  }

  // 1. SessionDO 强一致撤销(per-user DO,统一走 sessionDoStub 命中签发时同一实例)
  await revokeInDO(c.env, row.userId, id)

  // 2. 异步落 D1
  await db.sessions.update({ status: 'revoked' }, eq(schema.sessions.id, id))
  return c.json({ revoked: true, session_id: id })
})

// ---- 撤销用户全部会话 ----

// POST /v1/users/:userId/sessions/revoke_all
app.post('/users/:userId/revoke_all', async (c) => {
  await requireApiKey(c, 'sessions:write')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const userId = c.req.param('userId')

  const user = await db.users.findOne(
    and(
      eq(schema.users.id, userId),
      eq(schema.users.status, 'active'),
      isNull(schema.users.deletedAt),
    ),
  )
  if (!user) throw new AppError('not_found', { httpStatus: 404 })

  // SessionDO revoke-all(统一走 sessionDoStub 命中签发时同一实例)
  await sessionDoRevokeAll(c.env, userId)

  // 批量落 D1
  await db.sessions.update(
    { status: 'revoked' },
    and(eq(schema.sessions.userId, userId), eq(schema.sessions.status, 'active')),
  )
  return c.json({ revoked: true, user_id: userId })
})

// revokeInDO: 向 per-user SessionDO 发单条撤销请求(走 sessionDoStub 统一实例 key)。
async function revokeInDO(env: Env, userId: string, sessionId: string): Promise<void> {
  await sessionDoStub(env, userId).fetch('https://session-do/revoke', {
    method: 'POST',
    body: JSON.stringify({ sessionId }),
    headers: { 'content-type': 'application/json' },
  })
}

// safeSession: 剔除 refreshTokenHash(不暴露给 API 响应)。
function safeSession(
  row: typeof schema.sessions.$inferSelect,
): Omit<typeof schema.sessions.$inferSelect, 'refreshTokenHash'> {
  const { refreshTokenHash: _omit, ...rest } = row
  return rest
}

export function registerSessionsRoutes(honoApp: Hono<XidHonoEnv>): void {
  honoApp.route('/v1/sessions', app)
  // 用户级 revoke_all 挂到 /v1 下(路径: /v1/sessions/users/:userId/revoke_all)
}
