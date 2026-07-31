// GET /v1/platform/audit/verify:按 tenant + seq 范围重算 append-only 审计链。
// 只允许 Instance Manager;跨租户读取必须走独立 managementDb 路径。
// D1 每批最多读 1000 行,避免把完整租户审计历史一次性载入 Worker 内存。

import { sha256Hex } from '@xid-kit/crypto'
import { schema } from '@xid-kit/db'
import { and, desc, eq, gt, lte } from 'drizzle-orm'
import { Hono } from 'hono'
import * as v from 'valibot'
import { AppError } from '../lib/errors'
import type { XidHonoEnv } from '../lib/types'
import { validateQuery } from '../lib/validate'
import { buildAuditInput } from '../queues/audit'
import { managementDb, requireInstanceManager } from './shared'

const app = new Hono<XidHonoEnv>()

const GENESIS_HASH = '0'.repeat(64)
const VERIFY_BATCH_SIZE = 1000

const positiveSeqSchema = v.pipe(
  v.string(),
  v.regex(/^[1-9]\d*$/),
  v.transform(Number),
  v.number(),
  v.integer(),
  v.maxValue(Number.MAX_SAFE_INTEGER),
)

const verifyQuerySchema = v.object({
  tenant_id: v.pipe(v.string(), v.minLength(1)),
  from_seq: v.optional(positiveSeqSchema),
  to_seq: v.optional(positiveSeqSchema),
})

export type AuditChainFailureReason =
  | 'audit_chain_broken'
  | 'audit_seq_gap'
  | 'audit_genesis_missing'

export type AuditChainVerificationState = {
  nextSeq: number
  expectedPrevHash: string
  recordCount: number
  chainValid: boolean
  brokenAtSeq: number | null
  failureReason: AuditChainFailureReason | null
}

export type AuditChainVerificationResponse = {
  tenant_id: string
  verified_range: { from: number; to: number }
  chain_valid: boolean
  broken_at_seq: number | null
  failure_reason: AuditChainFailureReason | null
  record_count: number
  computed_at: string
}

type VerifiableAuditRow = {
  seq: number
  id: string
  tenantId: string
  orgId: string | null | undefined
  eventType: string
  actorId: string | null | undefined
  actorIp: string | null | undefined
  targetType: string | null | undefined
  targetId: string | null | undefined
  meta: Record<string, unknown>
  occurredAt: string
  prevHash: string
  hash: string
}

export function createAuditVerificationState(
  fromSeq: number,
  expectedPrevHash: string,
): AuditChainVerificationState {
  return {
    nextSeq: fromSeq,
    expectedPrevHash,
    recordCount: 0,
    chainValid: true,
    brokenAtSeq: null,
    failureReason: null,
  }
}

function failAuditVerification(
  state: AuditChainVerificationState,
  brokenAtSeq: number,
  failureReason: AuditChainFailureReason,
): void {
  state.chainValid = false
  state.brokenAtSeq = brokenAtSeq
  state.failureReason = failureReason
}

export async function verifyAuditRows(
  state: AuditChainVerificationState,
  rows: readonly VerifiableAuditRow[],
): Promise<void> {
  for (const row of rows) {
    if (!state.chainValid) return
    state.recordCount += 1

    if (row.seq !== state.nextSeq) {
      failAuditVerification(state, state.nextSeq, 'audit_seq_gap')
      return
    }
    if (row.seq === 1 && row.prevHash !== GENESIS_HASH) {
      failAuditVerification(state, row.seq, 'audit_genesis_missing')
      return
    }
    if (row.prevHash !== state.expectedPrevHash) {
      failAuditVerification(state, row.seq, 'audit_chain_broken')
      return
    }

    const computedHash = await sha256Hex(
      buildAuditInput({
        seq: row.seq,
        id: row.id,
        tenantId: row.tenantId,
        orgId: row.orgId ?? undefined,
        eventType: row.eventType,
        actorId: row.actorId ?? undefined,
        actorIp: row.actorIp ?? undefined,
        targetType: row.targetType ?? undefined,
        targetId: row.targetId ?? undefined,
        meta: row.meta,
        occurredAt: row.occurredAt,
        prevHash: row.prevHash,
      }),
    )
    if (computedHash !== row.hash) {
      failAuditVerification(state, row.seq, 'audit_chain_broken')
      return
    }

    state.expectedPrevHash = row.hash
    state.nextSeq = row.seq + 1
  }
}

function finishAuditVerification(state: AuditChainVerificationState, toSeq: number): void {
  if (state.chainValid && state.nextSeq <= toSeq) {
    failAuditVerification(state, state.nextSeq, 'audit_seq_gap')
  }
}

function responseFor(
  tenantId: string,
  fromSeq: number,
  toSeq: number,
  state: AuditChainVerificationState,
): AuditChainVerificationResponse {
  return {
    tenant_id: tenantId,
    verified_range: { from: fromSeq, to: toSeq },
    chain_valid: state.chainValid,
    broken_at_seq: state.brokenAtSeq,
    failure_reason: state.failureReason,
    record_count: state.recordCount,
    computed_at: new Date().toISOString(),
  }
}

app.get('/', async (c) => {
  await requireInstanceManager(c)
  const query = validateQuery(verifyQuerySchema, {
    tenant_id: c.req.query('tenant_id'),
    from_seq: c.req.query('from_seq'),
    to_seq: c.req.query('to_seq'),
  })
  const db = managementDb(c.env)

  const latestRows = await db
    .select({ seq: schema.auditEvents.seq })
    .from(schema.auditEvents)
    .where(eq(schema.auditEvents.tenantId, query.tenant_id))
    .orderBy(desc(schema.auditEvents.seq))
    .limit(1)
  const latestSeq = latestRows[0]?.seq
  if (latestSeq === undefined) {
    const fromSeq = query.from_seq ?? 1
    if (fromSeq !== 1 || query.to_seq !== undefined) {
      throw new AppError('validation_failed', {
        httpStatus: 422,
        meta: { paramName: fromSeq !== 1 ? 'from_seq' : 'to_seq' },
      })
    }
    const emptyState = createAuditVerificationState(1, GENESIS_HASH)
    return c.json(responseFor(query.tenant_id, 1, 0, emptyState))
  }

  const fromSeq = query.from_seq ?? 1
  const toSeq = query.to_seq ?? latestSeq
  if (fromSeq > toSeq || toSeq > latestSeq) {
    throw new AppError('validation_failed', {
      httpStatus: 422,
      meta: { paramName: fromSeq > toSeq ? 'from_seq' : 'to_seq' },
    })
  }

  let expectedPrevHash = GENESIS_HASH
  if (fromSeq > 1) {
    const predecessorRows = await db
      .select({ hash: schema.auditEvents.hash })
      .from(schema.auditEvents)
      .where(
        and(
          eq(schema.auditEvents.tenantId, query.tenant_id),
          eq(schema.auditEvents.seq, fromSeq - 1),
        ),
      )
      .limit(1)
    const predecessor = predecessorRows[0]
    if (!predecessor) {
      const missingPredecessor = createAuditVerificationState(fromSeq, GENESIS_HASH)
      failAuditVerification(missingPredecessor, fromSeq, 'audit_seq_gap')
      return c.json(responseFor(query.tenant_id, fromSeq, toSeq, missingPredecessor))
    }
    expectedPrevHash = predecessor.hash
  }

  const state = createAuditVerificationState(fromSeq, expectedPrevHash)
  let cursorSeq = fromSeq - 1
  while (state.chainValid && cursorSeq < toSeq) {
    const rows = await db
      .select({
        seq: schema.auditEvents.seq,
        id: schema.auditEvents.id,
        tenantId: schema.auditEvents.tenantId,
        orgId: schema.auditEvents.orgId,
        eventType: schema.auditEvents.eventType,
        actorId: schema.auditEvents.actorId,
        actorIp: schema.auditEvents.actorIp,
        targetType: schema.auditEvents.targetType,
        targetId: schema.auditEvents.targetId,
        meta: schema.auditEvents.meta,
        occurredAt: schema.auditEvents.occurredAt,
        prevHash: schema.auditEvents.prevHash,
        hash: schema.auditEvents.hash,
      })
      .from(schema.auditEvents)
      .where(
        and(
          eq(schema.auditEvents.tenantId, query.tenant_id),
          gt(schema.auditEvents.seq, cursorSeq),
          lte(schema.auditEvents.seq, toSeq),
        ),
      )
      .orderBy(schema.auditEvents.seq)
      .limit(VERIFY_BATCH_SIZE)

    if (rows.length === 0) break
    await verifyAuditRows(state, rows)
    cursorSeq = rows[rows.length - 1]?.seq ?? cursorSeq
    if (rows.length < VERIFY_BATCH_SIZE) break
  }

  finishAuditVerification(state, toSeq)
  return c.json(responseFor(query.tenant_id, fromSeq, toSeq, state))
})

export function registerPlatformAuditVerifyRoutes(honoApp: Hono<XidHonoEnv>): void {
  honoApp.route('/v1/platform/audit/verify', app)
}
