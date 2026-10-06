// GET /v1/organizations/:id/audit-events  org 级审计(只读)。
// 双认证:org owner/admin/org_manager(cookie)或 sk_ key(audit_events:read)。
// 过滤:sk(Management API 信任域)与 instance_manager 可见本 org 事件 + 租户级事件(orgId=null,登录类);
// org admin 仅见本 org 事件,不放开 orgId=null(登录类事件含全租户用户登录 IP/时间,放开即跨 org 泄露)。
// 排序 occurred_at DESC, id DESC;复合游标 "occurredAt|id"。筛选条件在查询层执行,与游标同时生效。

import { createTenantDb, schema } from '@xid-kit/db'
import { and, desc, eq, gte, inArray, isNull, lt, or, type SQL } from 'drizzle-orm'
import { Hono } from 'hono'
import * as v from 'valibot'
import { auditActorDisplay } from '../lib/audit-actor'
import { AppError } from '../lib/errors'
import type { XidHonoEnv } from '../lib/types'
import { paginationQuerySchema, validateQuery } from '../lib/validate'
import { isInstanceManagerUser } from './org-self-service'
import { MAX_PAGE_SIZE, decodeCursor, encodeCursor, requireApiKeyOrOrgManager } from './shared'

const app = new Hono<XidHonoEnv>()

const isoInstantSchema = v.pipe(
  v.string(),
  v.maxLength(40),
  v.check((value) => !Number.isNaN(Date.parse(value))),
  v.transform((value) => new Date(value).toISOString()),
)

const auditQuerySchema = v.object({
  ...paginationQuerySchema.entries,
  event_type: v.optional(v.pipe(v.string(), v.regex(/^[A-Za-z0-9_.-]{1,100}$/))),
  occurred_from: v.optional(isoInstantSchema),
  occurred_to: v.optional(isoInstantSchema),
})

// U+FFFF 在 UTF-8 BINARY 排序中高于所有 ASCII 字符,区间查询等价于前缀匹配且可走 event_type 索引。
const PREFIX_UPPER_BOUND = '￿'

// org audit 复合游标解码(occurredAt|id);格式损坏走 422(枚举防护,不泄露细节)。
function decodeOrgAuditCursor(cursor: string): { occurredAt: string; id: string } {
  const raw = decodeCursor(cursor)
  const sep = raw.indexOf('|')
  if (sep === -1) throw new AppError('validation_failed', { httpStatus: 422 })
  return { occurredAt: raw.slice(0, sep), id: raw.slice(sep + 1) }
}

function auditFilters(input: {
  orgFilter: SQL | undefined
  eventType: string | undefined
  occurredFrom: string | undefined
  occurredTo: string | undefined
}): SQL[] {
  const filters: (SQL | undefined)[] = [input.orgFilter]
  if (input.eventType) {
    filters.push(
      gte(schema.auditEvents.eventType, input.eventType),
      lt(schema.auditEvents.eventType, `${input.eventType}${PREFIX_UPPER_BOUND}`),
    )
  }
  if (input.occurredFrom) filters.push(gte(schema.auditEvents.occurredAt, input.occurredFrom))
  if (input.occurredTo) filters.push(lt(schema.auditEvents.occurredAt, input.occurredTo))
  return filters.filter((filter): filter is SQL => filter !== undefined)
}

function afterCursorFilter(cursor: string): SQL | undefined {
  const after = decodeOrgAuditCursor(cursor)
  return or(
    lt(schema.auditEvents.occurredAt, after.occurredAt),
    and(eq(schema.auditEvents.occurredAt, after.occurredAt), lt(schema.auditEvents.id, after.id)),
  )
}

app.get('/:id/audit-events', async (c) => {
  const id = c.req.param('id')
  const auth = await requireApiKeyOrOrgManager(c, id, 'audit_events:read')
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const query = validateQuery(auditQuerySchema, c.req.query())
  const limit = query.limit ?? MAX_PAGE_SIZE

  const includeTenantWide =
    auth.kind === 'api_key' || (await isInstanceManagerUser(c, auth.session.userId))
  const filters = auditFilters({
    orgFilter: includeTenantWide
      ? or(eq(schema.auditEvents.orgId, id), isNull(schema.auditEvents.orgId))
      : eq(schema.auditEvents.orgId, id),
    eventType: query.event_type,
    occurredFrom: query.occurred_from,
    occurredTo: query.occurred_to,
  })
  const cursorFilter = query.cursor ? afterCursorFilter(query.cursor) : undefined
  const [rows, total] = await Promise.all([
    db.auditEvents.findMany(and(...filters, cursorFilter), {
      orderBy: [desc(schema.auditEvents.occurredAt), desc(schema.auditEvents.id)],
      limit: limit + 1,
    }),
    db.auditEvents.count(and(...filters)),
  ])
  const hasMore = rows.length > limit
  const pageRows = hasMore ? rows.slice(0, limit) : rows
  const last = pageRows[pageRows.length - 1]
  const nextCursor =
    hasMore && last !== undefined ? encodeCursor(`${last.occurredAt}|${last.id}`) : null

  const actorIds = [
    ...new Set(
      pageRows
        .map((row) => row.actorId)
        .filter((actorId): actorId is string => actorId !== null && actorId !== 'system'),
    ),
  ]
  const actorRows =
    actorIds.length === 0
      ? []
      : await db.users.findMany(inArray(schema.users.id, actorIds), { limit: actorIds.length })
  const actors = new Map(actorRows.map((row) => [row.id, row.erasedAt] as const))

  const data = pageRows.map((row) => ({
    id: row.id,
    seq: row.seq,
    organizationId: row.tenantId,
    organizationName: null,
    orgId: row.orgId ?? null,
    eventType: row.eventType,
    actorId: row.actorId ?? null,
    actorDisplay: auditActorDisplay(row.actorId ?? null, {
      found: row.actorId === 'system' || actors.has(row.actorId ?? ''),
      erasedAt: actors.get(row.actorId ?? '') ?? null,
    }),
    actorIp: row.actorIp ?? null,
    targetType: row.targetType ?? null,
    targetId: row.targetId ?? null,
    occurredAt: row.occurredAt,
  }))

  return c.json({ data, next_cursor: nextCursor, has_more: hasMore, total })
})

export function registerOrgAuditRoutes(parent: Hono<XidHonoEnv>): void {
  parent.route('/v1/organizations', app)
}
