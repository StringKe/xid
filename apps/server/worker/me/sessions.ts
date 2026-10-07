// GET /v1/me/sessions + POST /v1/me/sessions/revoke-all:account portal 会话自助管理。
// GET 列当前用户 status='active' 且未过期会话(camelCase,account/types.ts ActiveSession 契约)。
// revoke-all 撤销「除当前会话外」的所有会话(前端 "Sign out all other sessions";与 Management API 全撤不同)。
// 认证:cookie session;租户隔离:createTenantDb;撤销走 per-user SessionDO(强一致)再落 D1。
// refresh_token_hash 绝不外泄(对照 v1/sessions.ts safeSession,但转 camelCase + 脱敏指纹)。

import { createTenantDb, schema } from '@xid-kit/db'
import type { BrowserImpersonator } from '@xid-kit/types'
import { and, asc, eq, gt, ne } from 'drizzle-orm'
import { Hono } from 'hono'
import { sessionDoRevoke, sessionDoRevokeAllExcept } from '../lib/session'
import { AppError } from '../lib/errors'
import type { XidHonoEnv } from '../lib/types'
import { loadImpersonators } from './impersonator'
import { maskFingerprint, readAllById, requireSession, toIso } from './shared'

type ActiveSession = {
  id: string
  deviceName: string | null
  deviceFingerprint: string | null
  ipAddress: string | null
  // 浏览器与系统名由前端解析 userAgent;location 是签发时按 IP 估算的 "City, CC",旧会话为 null。
  userAgent: string | null
  location: string | null
  amr: readonly string[]
  signedInAt: string
  lastActiveAt: string
  expiresAt: string
  isCurrent: boolean
  isImpersonation: boolean
  impersonator: BrowserImpersonator | null
}

function toActiveSession(
  row: typeof schema.sessions.$inferSelect,
  context: {
    currentSessionId: string
    impersonators: ReadonlyMap<string, BrowserImpersonator>
  },
): ActiveSession {
  const impersonator =
    row.isImpersonation && row.impersonatorUserId
      ? (context.impersonators.get(row.impersonatorUserId) ?? null)
      : null
  return {
    id: row.id,
    deviceName: row.deviceName ?? null,
    deviceFingerprint: maskFingerprint(row.deviceFingerprintHash),
    ipAddress: row.ip ?? null,
    userAgent: row.userAgent ?? null,
    location: row.location ?? null,
    amr: row.amr ?? [],
    signedInAt: row.authenticatedAt.toISOString(),
    lastActiveAt: toIso(row.lastActiveAt) ?? row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    isCurrent: row.id === context.currentSessionId,
    isImpersonation: row.isImpersonation,
    impersonator,
  }
}

const app = new Hono<XidHonoEnv>()

// GET /v1/me/sessions
app.get('/', async (c) => {
  const session = await requireSession(c)
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const rows = await readAllById((cursor, limit) => {
    const active = and(
      eq(schema.sessions.userId, session.userId),
      eq(schema.sessions.status, 'active'),
      gt(schema.sessions.expiresAt, new Date()),
    )
    return db.sessions.findMany(cursor ? and(active, gt(schema.sessions.id, cursor)) : active, {
      orderBy: asc(schema.sessions.id),
      limit,
    })
  })
  const impersonators = await loadImpersonators(
    c.env,
    c.get('tenant').instanceId,
    rows.flatMap((row) =>
      row.isImpersonation && row.impersonatorUserId ? [row.impersonatorUserId] : [],
    ),
  )
  const context = { currentSessionId: session.sessionId, impersonators }
  return c.json(rows.map((row) => toActiveSession(row, context)))
})

// POST /v1/me/sessions/revoke-all -- 撤销除当前会话外所有会话
app.post('/revoke-all', async (c) => {
  const session = await requireSession(c)
  const db = createTenantDb(c.env.DB, c.get('tenant'))

  await sessionDoRevokeAllExcept(c.env, session.userId, session.sessionId)
  await db.sessions.update(
    { status: 'revoked' },
    and(
      eq(schema.sessions.userId, session.userId),
      eq(schema.sessions.status, 'active'),
      ne(schema.sessions.id, session.sessionId),
    ),
  )

  return c.json({ revoked: true })
})

app.delete('/:id', async (c) => {
  const session = await requireSession(c)
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const id = c.req.param('id')
  const where = and(
    eq(schema.sessions.id, id),
    eq(schema.sessions.userId, session.userId),
    eq(schema.sessions.status, 'active'),
  )
  const existing = await db.sessions.findOne(where)
  if (!existing) throw new AppError('not_found', { httpStatus: 404 })
  await sessionDoRevoke(c.env, session.userId, id)
  await db.sessions.update({ status: 'revoked' }, where)
  return new Response(null, { status: 204 })
})

export function registerMeSessionsRoutes(honoApp: Hono<XidHonoEnv>): void {
  honoApp.route('/v1/me/sessions', app)
}
