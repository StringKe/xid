// GET /v1/platform/audit-events:汇聚所有 organization 审计事件(契约 Page<AuditEvent>,nextCursor + total)。
// 跨 org 审计走独立管理路径(requireInstanceManager + managementDb,见 shared.ts、tenant-isolation rule)。
// audit_events append-only(seq + prev_hash 链,occurred_at ISO TEXT,见 cloudflare-bindings 审计链)。
// 按最近优先排序:occurred_at DESC, id DESC(稳定 tie-break);cursor 编码 "occurredAt|id" 复合游标。
// organizationName 取 org.name(LEFT JOIN,nullable:平台级事件无对应 org)。

import { schema } from '@xid-kit/db'
import { and, count, desc, eq, lt, or } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { Hono } from 'hono'
import type { XidHonoEnv } from '../lib/types'
import { AppError } from '../lib/errors'
import {
  decodeCursor,
  encodeCursor,
  managementDb,
  parsePlatformPagination,
  requireInstanceManager,
} from './shared'

const app = new Hono<XidHonoEnv>()

type AuditEvent = {
  id: string
  seq: number
  organizationId: string
  organizationName: string | null
  orgId: string | null
  eventType: string
  actorId: string | null
  actorIp: string | null
  targetType: string | null
  targetId: string | null
  occurredAt: string
}

const CURSOR_SEP = '|'

// 复合游标编解码:occurredAt(ISO) + id。decode 失败(格式损坏)走 AppError(枚举防护 422 不泄露细节)。
function decodeAuditCursor(cursor: string): { occurredAt: string; id: string } {
  const raw = decodeCursor(cursor)
  const sep = raw.indexOf(CURSOR_SEP)
  if (sep === -1) throw new AppError('validation_failed', { httpStatus: 422 })
  return { occurredAt: raw.slice(0, sep), id: raw.slice(sep + 1) }
}

function encodeAuditCursor(occurredAt: string, id: string): string {
  return encodeCursor(`${occurredAt}${CURSOR_SEP}${id}`)
}

// occurred_at DESC, id DESC 下的 keyset 游标谓词:取严格小于 (occurredAt, id) 的行。
function afterAuditCursor(cursor: string | null): SQL | undefined {
  if (!cursor) return undefined
  const { occurredAt, id } = decodeAuditCursor(cursor)
  return or(
    lt(schema.auditEvents.occurredAt, occurredAt),
    and(eq(schema.auditEvents.occurredAt, occurredAt), lt(schema.auditEvents.id, id)),
  )
}

app.get('/', async (c) => {
  await requireInstanceManager(c)
  const db = managementDb(c.env)
  const { limit, cursor } = parsePlatformPagination(c, 30)

  const after = afterAuditCursor(cursor)
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
      occurredAt: schema.auditEvents.occurredAt,
      organizationName: schema.organizations.name,
    })
    .from(schema.auditEvents)
    .leftJoin(schema.organizations, eq(schema.organizations.id, schema.auditEvents.tenantId))
    .where(after ?? undefined)
    .orderBy(desc(schema.auditEvents.occurredAt), desc(schema.auditEvents.id))
    .limit(limit + 1)

  const [totalRow] = await db.select({ value: count() }).from(schema.auditEvents)

  const hasMore = rows.length > limit
  const pageRows = hasMore ? rows.slice(0, limit) : rows
  const last = pageRows[pageRows.length - 1]
  const nextCursor =
    hasMore && last !== undefined ? encodeAuditCursor(last.occurredAt, last.id) : null

  const data: AuditEvent[] = pageRows.map((row) => ({
    id: row.id,
    seq: row.seq,
    organizationId: row.tenantId,
    organizationName: row.organizationName ?? null,
    orgId: row.orgId ?? null,
    eventType: row.eventType,
    actorId: row.actorId ?? null,
    actorIp: row.actorIp ?? null,
    targetType: row.targetType ?? null,
    targetId: row.targetId ?? null,
    occurredAt: row.occurredAt,
  }))

  return c.json({ data, nextCursor, total: totalRow?.value ?? 0 })
})

export function registerPlatformAuditEventsRoutes(honoApp: Hono<XidHonoEnv>): void {
  honoApp.route('/v1/platform/audit-events', app)
}
