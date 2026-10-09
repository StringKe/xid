// GET /v1/platform/audit-events:汇聚所有 organization 审计事件(PlatformPage<PlatformAuditEvent> 超集,nextCursor + total)。
// 跨 org 审计走独立管理路径(requireInstanceManager + managementDb,见 shared.ts、tenant-isolation rule)。
// audit_events append-only(seq + prev_hash 链,occurred_at ISO TEXT,见 cloudflare-bindings 审计链)。
// 按最近优先排序:occurred_at DESC, id DESC(稳定 tie-break);cursor 编码 "occurredAt|id" 复合游标。

import { schema } from '@xid-kit/db'
import type { PlatformAuditEvent } from '@xid-kit/types'
import { and, count, desc, eq, gte, inArray, lt, or } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { Hono } from 'hono'
import * as v from 'valibot'
import type { XidHonoEnv } from '../lib/types'
import { AppError } from '../lib/errors'
import { auditActorDisplay } from '../lib/audit-actor'
import { validateQuery } from '../lib/validate'
import { displayNameOf } from './user-display'
import {
  decodeCursor,
  encodeCursor,
  managementDb,
  parsePlatformPagination,
  requireInstanceManager,
} from './shared'

const app = new Hono<XidHonoEnv>()

const CURSOR_SEP = '|'
// U+FFFF 高于所有 ASCII 字符,区间查询等价于前缀匹配且可走 event_type 索引(与组织审计一致)。
const PREFIX_UPPER_BOUND = '￿'
const identifierSchema = v.pipe(v.string(), v.trim(), v.regex(/^[A-Za-z0-9_:.-]{1,128}$/u))

const auditQuerySchema = v.object({
  limit: v.optional(v.string()),
  cursor: v.optional(v.string()),
  actor_id: v.optional(identifierSchema),
  organization_id: v.optional(identifierSchema),
  event_type: v.optional(v.pipe(v.string(), v.trim(), v.regex(/^[A-Za-z0-9_.-]{1,100}\*?$/u))),
})

export type PlatformAuditEventDetail = PlatformAuditEvent & {
  actorName: string | null
  details: Record<string, unknown>
}

type Db = ReturnType<typeof managementDb>

// 审计 actor 与平台操作者的显示名:display name 优先,其次主邮箱;已删除或已擦除的用户不回显。
export async function loadUserDisplayNames(
  db: Db,
  userIds: readonly string[],
): Promise<Map<string, string>> {
  const ids = [...new Set(userIds)]
  if (ids.length === 0) return new Map()
  const rows = await db
    .select({
      id: schema.users.id,
      displayName: schema.users.displayName,
      firstName: schema.users.firstName,
      lastName: schema.users.lastName,
      email: schema.userEmails.email,
    })
    .from(schema.users)
    .leftJoin(
      schema.userEmails,
      and(
        eq(schema.userEmails.id, schema.users.primaryEmailId),
        eq(schema.userEmails.userId, schema.users.id),
      ),
    )
    .where(and(inArray(schema.users.id, ids), eq(schema.users.status, 'active')))
  const names = new Map<string, string>()
  for (const row of rows) {
    const name = displayNameOf(row) ?? row.email
    if (name) names.set(row.id, name)
  }
  return names
}

function decodeAuditCursor(cursor: string): { occurredAt: string; id: string } {
  const raw = decodeCursor(cursor)
  const sep = raw.indexOf(CURSOR_SEP)
  if (sep === -1) throw new AppError('validation_failed', { httpStatus: 422 })
  return { occurredAt: raw.slice(0, sep), id: raw.slice(sep + 1) }
}

function encodeAuditCursor(occurredAt: string, id: string): string {
  return encodeCursor(`${occurredAt}${CURSOR_SEP}${id}`)
}

function afterAuditCursor(cursor: string | null): SQL | undefined {
  if (!cursor) return undefined
  const { occurredAt, id } = decodeAuditCursor(cursor)
  return or(
    lt(schema.auditEvents.occurredAt, occurredAt),
    and(eq(schema.auditEvents.occurredAt, occurredAt), lt(schema.auditEvents.id, id)),
  )
}

// `platform.*` 与 `platform.` 都按前缀匹配;不带 `*` 的完整事件名精确匹配。
function eventTypeFilter(eventType: string | undefined): SQL | undefined {
  if (!eventType) return undefined
  if (!eventType.endsWith('*')) return eq(schema.auditEvents.eventType, eventType)
  const prefix = eventType.slice(0, -1)
  if (prefix.length === 0) return undefined
  return and(
    gte(schema.auditEvents.eventType, prefix),
    lt(schema.auditEvents.eventType, `${prefix}${PREFIX_UPPER_BOUND}`),
  )
}

function auditFilters(query: v.InferOutput<typeof auditQuerySchema>): SQL | undefined {
  return and(
    query.actor_id ? eq(schema.auditEvents.actorId, query.actor_id) : undefined,
    query.organization_id ? eq(schema.auditEvents.tenantId, query.organization_id) : undefined,
    eventTypeFilter(query.event_type),
  )
}

app.get('/', async (c) => {
  await requireInstanceManager(c)
  const query = validateQuery(auditQuerySchema, c.req.query())
  const db = managementDb(c.env)
  const { limit, cursor } = parsePlatformPagination(c, 30)
  const filters = auditFilters(query)

  const rows = await db
    .select({
      id: schema.auditEvents.id,
      seq: schema.auditEvents.seq,
      tenantId: schema.auditEvents.tenantId,
      orgId: schema.auditEvents.orgId,
      eventType: schema.auditEvents.eventType,
      actorId: schema.auditEvents.actorId,
      actorIp: schema.auditEvents.actorIp,
      targetType: schema.auditEvents.targetType,
      targetId: schema.auditEvents.targetId,
      meta: schema.auditEvents.meta,
      occurredAt: schema.auditEvents.occurredAt,
      organizationName: schema.organizations.name,
      actorUserId: schema.users.id,
      actorErasedAt: schema.users.erasedAt,
    })
    .from(schema.auditEvents)
    .leftJoin(schema.organizations, eq(schema.organizations.id, schema.auditEvents.tenantId))
    .leftJoin(
      schema.users,
      and(
        eq(schema.users.id, schema.auditEvents.actorId),
        eq(schema.users.tenantId, schema.auditEvents.tenantId),
      ),
    )
    .where(and(filters, afterAuditCursor(cursor)))
    .orderBy(desc(schema.auditEvents.occurredAt), desc(schema.auditEvents.id))
    .limit(limit + 1)

  const [totalRow] = await db.select({ value: count() }).from(schema.auditEvents).where(filters)

  const hasMore = rows.length > limit
  const pageRows = hasMore ? rows.slice(0, limit) : rows
  const last = pageRows[pageRows.length - 1]
  const nextCursor =
    hasMore && last !== undefined ? encodeAuditCursor(last.occurredAt, last.id) : null
  const names = await loadUserDisplayNames(
    db,
    pageRows.flatMap((row) => (row.actorId ? [row.actorId] : [])),
  )

  const data: PlatformAuditEventDetail[] = pageRows.map((row) => {
    // 平台级事件的 tenant_id 是 'platform',操作者属于某个租户,只能按 id 认领。
    const platformActorFound = row.tenantId === 'platform' && names.has(row.actorId ?? '')
    const actorDisplay = auditActorDisplay(row.actorId ?? null, {
      found: platformActorFound || typeof row.actorUserId === 'string',
      erasedAt: platformActorFound ? null : (row.actorErasedAt ?? null),
    })
    return {
      id: row.id,
      seq: row.seq,
      organizationId: row.tenantId,
      organizationName: row.organizationName ?? null,
      orgId: row.orgId ?? null,
      eventType: row.eventType,
      actorId: row.actorId ?? null,
      actorDisplay,
      actorName: row.actorId ? (names.get(row.actorId) ?? null) : null,
      actorIp: row.actorIp ?? null,
      targetType: row.targetType ?? null,
      targetId: row.targetId ?? null,
      details: row.meta ?? {},
      occurredAt: row.occurredAt,
    }
  })

  return c.json({ data, nextCursor, total: totalRow?.value ?? 0 })
})

export function registerPlatformAuditEventsRoutes(honoApp: Hono<XidHonoEnv>): void {
  honoApp.route('/v1/platform/audit-events', app)
}
