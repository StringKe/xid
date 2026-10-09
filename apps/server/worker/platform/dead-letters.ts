import { schema } from '@xid-kit/db'
import type { QueueDeadLetter, QueueDeadLetterReplay } from '@xid-kit/types'
import { and, count, desc, eq, inArray, lt, ne, or } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { Hono } from 'hono'
import * as v from 'valibot'
import { AppError } from '../lib/errors'
import type { XidHonoEnv } from '../lib/types'
import { readJsonBody, validateBody, validateQuery } from '../lib/validate'
import { DEAD_LETTER_SOURCES, isDeadLetterReplayable, replayDeadLetter } from '../queues'
import {
  enqueuePersistedPlatformAudit,
  prepareConditionalPlatformAuditOutboxInsert,
} from './audit-outbox'
import type { PreparedConditionalPlatformAudit } from './audit-outbox'
import {
  decodeCursor,
  encodeCursor,
  managementDb,
  parsePlatformPagination,
  requireInstanceManager,
} from './shared'

const app = new Hono<XidHonoEnv>()
const CURSOR_SEPARATOR = '|'
export const MAX_BATCH_REPLAY = 25
const deadLetterIdSchema = v.pipe(v.string(), v.trim(), v.regex(/^[A-Za-z0-9_:.-]{1,128}$/u))
const DEAD_LETTER_STATUS_FILTERS = ['all', 'open'] as const

type DeadLetterRow = typeof schema.queueDeadLetters.$inferSelect

export type PlatformDeadLetter = QueueDeadLetter & { organizationName: string | null }

export type DeadLetterQueueCount = { queue: string; count: number }

export type DeadLetterBatchReplayItem =
  | (QueueDeadLetterReplay & { outcome: 'replayed' | 'already_replayed' | 'lease_held' })
  | {
      id: string
      outcome: 'failed'
      status: null
      reason: 'returned_to_quarantine' | 'needs_operator'
    }

// 来源队列枚举只在请求内读取:测试会以 mock 替换 '../queues',模块加载时不能依赖它。
function listQuerySchema() {
  return v.object({
    limit: v.optional(v.string()),
    cursor: v.optional(v.string()),
    queue: v.optional(v.picklist(DEAD_LETTER_SOURCES.map((source) => source.sourceQueue))),
    status: v.optional(v.picklist(DEAD_LETTER_STATUS_FILTERS)),
  })
}

const batchReplaySchema = v.object({
  ids: v.pipe(v.array(deadLetterIdSchema), v.minLength(1), v.maxLength(MAX_BATCH_REPLAY)),
})

function mapDeadLetter(
  row: DeadLetterRow,
  now: number,
  organizationName: string | null = null,
): PlatformDeadLetter {
  return {
    id: row.id,
    sourceQueue: row.sourceQueue,
    deadLetterQueue: row.deadLetterQueue,
    messageId: row.messageId,
    tenantId: row.tenantId ?? null,
    orgId: row.orgId ?? null,
    organizationName,
    eventType: row.eventType,
    errorCode: row.errorCode,
    status: row.status as QueueDeadLetter['status'],
    replayable: isDeadLetterReplayable(
      { status: row.status, replayRequestedAt: row.replayRequestedAt?.getTime() ?? null },
      now,
    ),
    attempts: row.attempts,
    sourceEnqueuedAt: row.sourceEnqueuedAt.toISOString(),
    failedAt: row.failedAt.toISOString(),
    replayRequestedAt: row.replayRequestedAt?.toISOString() ?? null,
    replayedAt: row.replayedAt?.toISOString() ?? null,
    replayedBy: row.replayedBy ?? null,
    replayCount: row.replayCount,
    lastReplayErrorCode: row.lastReplayErrorCode ?? null,
  }
}

function decodeDeadLetterCursor(cursor: string): { failedAt: Date; id: string } {
  const decoded = decodeCursor(cursor)
  const separatorIndex = decoded.indexOf(CURSOR_SEPARATOR)
  if (separatorIndex === -1) throw new AppError('validation_failed', { httpStatus: 422 })
  const failedAtMs = Number(decoded.slice(0, separatorIndex))
  const id = decoded.slice(separatorIndex + 1)
  if (!Number.isFinite(failedAtMs) || id.length === 0) {
    throw new AppError('validation_failed', { httpStatus: 422 })
  }
  return { failedAt: new Date(failedAtMs), id }
}

function afterDeadLetterCursor(cursor: string | null): SQL | undefined {
  if (!cursor) return undefined
  const decoded = decodeDeadLetterCursor(cursor)
  return or(
    lt(schema.queueDeadLetters.failedAt, decoded.failedAt),
    and(
      eq(schema.queueDeadLetters.failedAt, decoded.failedAt),
      lt(schema.queueDeadLetters.id, decoded.id),
    ),
  )
}

function encodeDeadLetterCursor(row: DeadLetterRow): string {
  return encodeCursor(`${row.failedAt.getTime()}${CURSOR_SEPARATOR}${row.id}`)
}

async function findDeadLetter(env: Env, id: string): Promise<DeadLetterRow | undefined> {
  const rows = await managementDb(env)
    .select()
    .from(schema.queueDeadLetters)
    .where(eq(schema.queueDeadLetters.id, id))
    .limit(1)
  return rows[0]
}

const OPEN_DEAD_LETTER = ne(schema.queueDeadLetters.status, 'replayed')

// 每个来源队列尚未重放(待处理或正在重放)的条数,未出现的队列补 0。
async function countsByQueue(env: Env): Promise<DeadLetterQueueCount[]> {
  const rows = await managementDb(env)
    .select({ queue: schema.queueDeadLetters.sourceQueue, count: count() })
    .from(schema.queueDeadLetters)
    .where(OPEN_DEAD_LETTER)
    .groupBy(schema.queueDeadLetters.sourceQueue)
  const counts = new Map(rows.map((row) => [row.queue, row.count]))
  return DEAD_LETTER_SOURCES.map((source) => ({
    queue: source.sourceQueue,
    count: counts.get(source.sourceQueue) ?? 0,
  }))
}

async function organizationNames(
  env: Env,
  rows: readonly DeadLetterRow[],
): Promise<Map<string, string>> {
  const ids = [...new Set(rows.flatMap((row) => (row.tenantId ? [row.tenantId] : [])))]
  if (ids.length === 0) return new Map()
  const organizations = await managementDb(env)
    .select({ id: schema.organizations.id, name: schema.organizations.name })
    .from(schema.organizations)
    .where(inArray(schema.organizations.id, ids))
  return new Map(organizations.map((organization) => [organization.id, organization.name]))
}

type ReplayOneInput = { env: Env; row: DeadLetterRow; actorId: string; batch: boolean }

// 单条重放:沿用 claim lease;只有真正送回源队列的那一次才落审计。
async function replayOne(input: ReplayOneInput): Promise<{
  result: QueueDeadLetterReplay | null
  audit: PreparedConditionalPlatformAudit | undefined
}> {
  const { env, row, actorId } = input
  let replayAudit: PreparedConditionalPlatformAudit | undefined
  const result = await replayDeadLetter(env, row.id, actorId, (claimedAt) => {
    replayAudit = prepareConditionalPlatformAuditOutboxInsert(
      env,
      {
        tenantId: row.tenantId ?? 'platform',
        ...(row.orgId ? { orgId: row.orgId } : {}),
        action: 'platform.queue_dead_letter.replayed',
        actorId,
        payload: {
          targetType: 'queue_dead_letter',
          targetId: row.id,
          sourceQueue: row.sourceQueue,
          ...(input.batch ? { batch: true } : {}),
        },
      },
      {
        sql: `EXISTS (
          SELECT 1
            FROM queue_dead_letters
           WHERE id = ? AND status = 'replaying' AND replay_requested_at = ?
        )`,
        bindings: [row.id, claimedAt],
      },
    )
    return replayAudit
  })
  if (result?.replayed && !replayAudit) throw new AppError('internal_error', { httpStatus: 500 })
  return { result, audit: result?.replayed ? replayAudit : undefined }
}

// 审计 outbox 行已与重放状态同批落库;这里只投递队列,失败由 Cron 重投,不改写重放结果。
async function enqueueReplayAudit(
  env: Env,
  audit: PreparedConditionalPlatformAudit | undefined,
): Promise<void> {
  if (audit) await enqueuePersistedPlatformAudit(env, audit)
}

// 数据不一致需要运维介入;其余失败已释放 lease,消息仍在隔离区可再次重放。
const OPERATOR_REPLAY_ERRORS = new Set([
  'source_queue_mapping_invalid',
  'dead_letter_replay_completion_not_observable',
])

function failedItem(id: string, error: unknown): DeadLetterBatchReplayItem {
  const message = error instanceof Error ? error.message : ''
  return {
    id,
    outcome: 'failed',
    status: null,
    reason: OPERATOR_REPLAY_ERRORS.has(message) ? 'needs_operator' : 'returned_to_quarantine',
  }
}

function batchOutcome(result: QueueDeadLetterReplay): DeadLetterBatchReplayItem {
  if (result.replayed) return { ...result, outcome: 'replayed' }
  if (result.status === 'replaying') return { ...result, outcome: 'lease_held' }
  return { ...result, outcome: 'already_replayed' }
}

app.get('/', async (c) => {
  await requireInstanceManager(c)
  const query = validateQuery(listQuerySchema(), c.req.query())
  const db = managementDb(c.env)
  const { limit, cursor } = parsePlatformPagination(c, 30)
  const filters = and(
    query.queue ? eq(schema.queueDeadLetters.sourceQueue, query.queue) : undefined,
    query.status === 'open' ? OPEN_DEAD_LETTER : undefined,
  )
  const [rows, [totalRow], counts] = await Promise.all([
    db
      .select()
      .from(schema.queueDeadLetters)
      .where(and(filters, afterDeadLetterCursor(cursor)))
      .orderBy(desc(schema.queueDeadLetters.failedAt), desc(schema.queueDeadLetters.id))
      .limit(limit + 1),
    db.select({ value: count() }).from(schema.queueDeadLetters).where(filters),
    countsByQueue(c.env),
  ])

  const hasMore = rows.length > limit
  const pageRows = hasMore ? rows.slice(0, limit) : rows
  const last = pageRows[pageRows.length - 1]
  const names = await organizationNames(c.env, pageRows)
  const now = Date.now()
  return c.json({
    data: pageRows.map((row) =>
      mapDeadLetter(row, now, row.tenantId ? (names.get(row.tenantId) ?? null) : null),
    ),
    nextCursor: hasMore && last ? encodeDeadLetterCursor(last) : null,
    total: totalRow?.value ?? 0,
    countsByQueue: counts,
  })
})

// 批量重放必须来自同一源队列;逐条走 claim lease,单条失败不影响其余条目,结果逐条返回。
app.post('/replay', async (c) => {
  const session = await requireInstanceManager(c)
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const ids = [...new Set(validateBody(batchReplaySchema, json.value).ids)]
  const rows = await managementDb(c.env)
    .select()
    .from(schema.queueDeadLetters)
    .where(inArray(schema.queueDeadLetters.id, ids))
  if (rows.length !== ids.length) throw new AppError('not_found', { httpStatus: 404 })
  if (new Set(rows.map((row) => row.sourceQueue)).size !== 1) {
    throw new AppError('validation_failed', { httpStatus: 422, meta: { paramName: 'ids' } })
  }

  const byId = new Map(rows.map((row) => [row.id, row]))
  const results: DeadLetterBatchReplayItem[] = []
  for (const id of ids) {
    const row = byId.get(id)
    if (!row) continue
    let replay: Awaited<ReturnType<typeof replayOne>>
    try {
      replay = await replayOne({ env: c.env, row, actorId: session.userId, batch: true })
    } catch (error) {
      console.error('platform.dead_letter.batch_replay_item_failed', { id, error })
      results.push(failedItem(id, error))
      continue
    }
    await enqueueReplayAudit(c.env, replay.audit)
    results.push(
      replay.result
        ? batchOutcome(replay.result)
        : { id, outcome: 'failed', status: null, reason: 'needs_operator' },
    )
  }
  return c.json({ sourceQueue: rows[0]?.sourceQueue ?? null, results })
})

app.get('/:id', async (c) => {
  await requireInstanceManager(c)
  const row = await findDeadLetter(c.env, c.req.param('id'))
  if (!row) throw new AppError('not_found', { httpStatus: 404 })
  return c.json(mapDeadLetter(row, Date.now()))
})

app.post('/:id/replay', async (c) => {
  const session = await requireInstanceManager(c)
  const row = await findDeadLetter(c.env, c.req.param('id'))
  if (!row) throw new AppError('not_found', { httpStatus: 404 })

  let replay: Awaited<ReturnType<typeof replayOne>>
  try {
    replay = await replayOne({ env: c.env, row, actorId: session.userId, batch: false })
  } catch (error) {
    if (error instanceof AppError) throw error
    throw new AppError('temporarily_unavailable', { httpStatus: 503, cause: error })
  }
  if (!replay.result) throw new AppError('not_found', { httpStatus: 404 })
  await enqueueReplayAudit(c.env, replay.audit)
  return c.json(replay.result)
})

export function registerPlatformDeadLetterRoutes(honoApp: Hono<XidHonoEnv>): void {
  honoApp.route('/v1/platform/dead-letters', app)
}
