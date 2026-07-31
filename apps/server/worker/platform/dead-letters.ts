import { schema } from '@xid-kit/db'
import { and, count, desc, eq, lt, or } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { Hono } from 'hono'
import { AppError } from '../lib/errors'
import type { XidHonoEnv } from '../lib/types'
import { replayDeadLetter } from '../queues'
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

type DeadLetterRow = typeof schema.queueDeadLetters.$inferSelect

function mapDeadLetter(row: DeadLetterRow) {
  return {
    id: row.id,
    sourceQueue: row.sourceQueue,
    deadLetterQueue: row.deadLetterQueue,
    messageId: row.messageId,
    tenantId: row.tenantId ?? null,
    orgId: row.orgId ?? null,
    eventType: row.eventType,
    errorCode: row.errorCode,
    status: row.status,
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

app.get('/', async (c) => {
  await requireInstanceManager(c)
  const db = managementDb(c.env)
  const { limit, cursor } = parsePlatformPagination(c, 30)
  const after = afterDeadLetterCursor(cursor)
  const rows = await db
    .select()
    .from(schema.queueDeadLetters)
    .where(after)
    .orderBy(desc(schema.queueDeadLetters.failedAt), desc(schema.queueDeadLetters.id))
    .limit(limit + 1)
  const [totalRow] = await db.select({ value: count() }).from(schema.queueDeadLetters)

  const hasMore = rows.length > limit
  const pageRows = hasMore ? rows.slice(0, limit) : rows
  const last = pageRows[pageRows.length - 1]
  return c.json({
    data: pageRows.map(mapDeadLetter),
    nextCursor: hasMore && last ? encodeDeadLetterCursor(last) : null,
    total: totalRow?.value ?? 0,
  })
})

app.get('/:id', async (c) => {
  await requireInstanceManager(c)
  const row = await findDeadLetter(c.env, c.req.param('id'))
  if (!row) throw new AppError('not_found', { httpStatus: 404 })
  return c.json(mapDeadLetter(row))
})

app.post('/:id/replay', async (c) => {
  const session = await requireInstanceManager(c)
  const row = await findDeadLetter(c.env, c.req.param('id'))
  if (!row) throw new AppError('not_found', { httpStatus: 404 })

  let result
  let replayAudit: PreparedConditionalPlatformAudit | undefined
  try {
    result = await replayDeadLetter(c.env, row.id, session.userId, (claimedAt) => {
      replayAudit = prepareConditionalPlatformAuditOutboxInsert(
        c.env,
        {
          tenantId: row.tenantId ?? 'platform',
          ...(row.orgId ? { orgId: row.orgId } : {}),
          action: 'platform.queue_dead_letter.replayed',
          actorId: session.userId,
          payload: {
            targetType: 'queue_dead_letter',
            targetId: row.id,
            sourceQueue: row.sourceQueue,
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
  } catch (error) {
    throw new AppError('temporarily_unavailable', { httpStatus: 503, cause: error })
  }
  if (!result) throw new AppError('not_found', { httpStatus: 404 })

  if (result.replayed) {
    if (!replayAudit) throw new AppError('internal_error', { httpStatus: 500 })
    await enqueuePersistedPlatformAudit(c.env, replayAudit)
  }

  return c.json(result)
})

export function registerPlatformDeadLetterRoutes(honoApp: Hono<XidHonoEnv>): void {
  honoApp.route('/v1/platform/dead-letters', app)
}
