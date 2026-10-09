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

type TenantDb = ReturnType<typeof createTenantDb>
type AuditRow = typeof schema.auditEvents.$inferSelect

const isoInstantSchema = v.pipe(
  v.string(),
  v.maxLength(40),
  v.check((value) => !Number.isNaN(Date.parse(value))),
  v.transform((value) => new Date(value).toISOString()),
)

// 末尾 * 与不带 * 一样按前缀匹配(已发布契约是前缀语义,* 只是显式写法)。
const auditQuerySchema = v.object({
  ...paginationQuerySchema.entries,
  event_type: v.optional(
    v.pipe(
      v.string(),
      v.regex(/^[A-Za-z0-9_.-]{1,100}\*?$/),
      v.transform((value) => value.replace(/\*$/, '')),
    ),
  ),
  actor_id: v.optional(v.pipe(v.string(), v.regex(/^[A-Za-z0-9_.:|-]{1,200}$/))),
  q: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200))),
  occurred_from: v.optional(isoInstantSchema),
  occurred_to: v.optional(isoInstantSchema),
})

// U+FFFF 在 UTF-8 BINARY 排序中高于所有 ASCII 字符,区间查询等价于前缀匹配且可走 event_type 索引。
const PREFIX_UPPER_BOUND = '￿'

export const AUDIT_SOURCES = ['console', 'management_api', 'scim', 'account', 'system'] as const
export type AuditSource = (typeof AUDIT_SOURCES)[number]
export type AuditActorKind =
  | 'user'
  | 'api_key'
  | 'directory'
  | 'system'
  | 'deleted_user'
  | 'unknown'

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
  actorId: string | undefined
  q: string | undefined
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
  if (input.actorId) filters.push(eq(schema.auditEvents.actorId, input.actorId))
  if (input.q) {
    filters.push(
      or(eq(schema.auditEvents.targetId, input.q), eq(schema.auditEvents.actorIp, input.q)),
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

// D1 单条语句最多绑定 100 个参数,id 列表分批并留出租户谓词的位置。
const PARTY_BATCH_SIZE = 50

type Party = { kind: AuditActorKind; displayName: string | null; erasedAt: Date | null }

// 一页内出现的 actor / target id 一次性解析为用户、API key 或目录同步的显示名。
async function resolveParties(db: TenantDb, ids: readonly string[]): Promise<Map<string, Party>> {
  const parties = new Map<string, Party>()
  if (ids.length === 0) return parties
  const batches: string[][] = []
  for (let offset = 0; offset < ids.length; offset += PARTY_BATCH_SIZE) {
    batches.push(ids.slice(offset, offset + PARTY_BATCH_SIZE))
  }
  const read = async <T>(load: (batch: string[]) => Promise<T[]>): Promise<T[]> =>
    (await Promise.all(batches.map(load))).flat()
  const [users, emails, keys, directories] = await Promise.all([
    read((batch) => db.users.findMany(inArray(schema.users.id, batch), { limit: batch.length })),
    read((batch) =>
      db.userEmails.findMany(
        and(inArray(schema.userEmails.userId, batch), eq(schema.userEmails.isPrimary, true)),
        { limit: batch.length },
      ),
    ),
    read((batch) =>
      db.apiKeys.findMany(inArray(schema.apiKeys.id, batch), { limit: batch.length }),
    ),
    read((batch) =>
      db.directories.findMany(inArray(schema.directories.id, batch), { limit: batch.length }),
    ),
  ])
  const emailByUser = new Map(emails.map((email) => [email.userId, email.email]))
  for (const user of users) {
    const fullName = [user.firstName, user.lastName].filter(Boolean).join(' ')
    parties.set(user.id, {
      kind: user.erasedAt ? 'deleted_user' : 'user',
      displayName: user.erasedAt
        ? null
        : (user.displayName ?? (fullName || emailByUser.get(user.id) || null)),
      erasedAt: user.erasedAt ?? null,
    })
  }
  for (const key of keys)
    parties.set(key.id, { kind: 'api_key', displayName: key.name, erasedAt: null })
  for (const directory of directories) {
    parties.set(directory.id, {
      kind: 'directory',
      displayName: directory.provider,
      erasedAt: null,
    })
  }
  return parties
}

// 来源渠道:按事件命名空间与 actor 类型推断;账户门户的操作是用户对自己执行的。
export function auditSource(
  row: Pick<AuditRow, 'eventType' | 'actorId' | 'targetId'>,
  actorKind: AuditActorKind,
): AuditSource {
  if (row.eventType.startsWith('scim.') || actorKind === 'directory') return 'scim'
  if (row.eventType.startsWith('auth.')) return 'account'
  if (actorKind === 'api_key') return 'management_api'
  if (row.actorId === null || row.actorId === 'system') return 'system'
  if (row.actorId === row.targetId) return 'account'
  return 'console'
}

function toAuditView(row: AuditRow, parties: ReadonlyMap<string, Party>) {
  const actor = row.actorId ? parties.get(row.actorId) : undefined
  const actorKind: AuditActorKind =
    row.actorId === null || row.actorId === 'system' ? 'system' : (actor?.kind ?? 'unknown')
  const target = row.targetId ? parties.get(row.targetId) : undefined
  return {
    id: row.id,
    seq: row.seq,
    prevHash: row.prevHash,
    source: auditSource(row, actorKind),
    organizationId: row.tenantId,
    organizationName: null,
    orgId: row.orgId ?? null,
    eventType: row.eventType,
    actorId: row.actorId ?? null,
    actorDisplay: auditActorDisplay(row.actorId ?? null, {
      found: row.actorId === 'system' || actor?.kind === 'user' || actor?.kind === 'deleted_user',
      erasedAt: actor?.erasedAt ?? null,
    }),
    actor: { kind: actorKind, displayName: actor?.displayName ?? null },
    actorIp: row.actorIp ?? null,
    targetType: row.targetType ?? null,
    targetId: row.targetId ?? null,
    targetDisplay: target?.displayName ?? null,
    payload: row.meta,
    occurredAt: row.occurredAt,
  }
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
    eventType: query.event_type || undefined,
    actorId: query.actor_id,
    q: query.q,
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

  const partyIds = new Set<string>()
  for (const row of pageRows) {
    if (row.actorId && row.actorId !== 'system') partyIds.add(row.actorId)
    if (row.targetId) partyIds.add(row.targetId)
  }
  const parties = await resolveParties(db, [...partyIds])
  const data = pageRows.map((row) => toAuditView(row, parties))

  return c.json({ data, next_cursor: nextCursor, has_more: hasMore, total })
})

export function registerOrgAuditRoutes(parent: Hono<XidHonoEnv>): void {
  parent.route('/v1/organizations', app)
}
