// Audit Queue Consumer:按租户把单条事件交给 AuditSeqDO 串行提交。
// Queue batch 不是稳定身份边界:retry 可以拆分或重排。DO 以 source_message_id 持久化身份，
// 仅在 D1 事件确认后推进 seq，前序未确认时阻塞后序，保证链没有重复或空洞。

import type { AuditQueueMessage } from '@xid-kit/types'
import { sha256Hex } from '@xid-kit/crypto'
import { completePlatformAuditOutbox } from '../platform/audit-outbox'
import { redactAuditPayload } from './audit-redaction'

const MAX_ATTEMPTS = 5
const PROMOTED_META_KEYS = ['actorIp', 'targetType', 'targetId'] as const

export type AuditFields = {
  tenantId: string
  orgId: string | undefined
  eventType: string
  actorId: string | undefined
  actorIp: string | undefined
  targetType: string | undefined
  targetId: string | undefined
  meta: Record<string, unknown>
  occurredAt: string
}

export type AuditRow = AuditFields & {
  seq: number
  id: string
  prevHash: string
  hash: string
}

export type AuditAppendInput = {
  sourceMessageId: string
  fields: AuditFields
}

type AuditAppendResult = { status: 'appended' | 'blocked' | 'terminal' }

type AuditTerminalInput = {
  sourceMessageId: string
  messageId: string
  tenantId: string
  attempts: number
  body: AuditQueueMessage
}

type AuditSeqStub = {
  append(input: AuditAppendInput): Promise<AuditAppendResult>
  terminalize(input: AuditTerminalInput): Promise<AuditAppendResult>
}

export function canonicalizeMeta(meta: Record<string, unknown>): string {
  const sorted = Object.fromEntries(
    Object.entries(meta).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  )
  return JSON.stringify(sorted)
}

export function buildAuditInput(row: Omit<AuditRow, 'hash'>): string {
  return [
    row.seq,
    row.id,
    row.tenantId,
    row.orgId ?? '',
    row.eventType,
    row.actorId ?? '',
    row.actorIp ?? '',
    row.targetType ?? '',
    row.targetId ?? '',
    canonicalizeMeta(row.meta),
    row.occurredAt,
    row.prevHash,
  ].join('|')
}

class PermanentAuditError extends Error {}

function assertValidMessage(body: AuditQueueMessage): void {
  const tenantOk = typeof body.tenantId === 'string' && body.tenantId.length > 0
  const actionOk = typeof body.action === 'string' && body.action.length > 0
  const tsOk = typeof body.ts === 'number' && Number.isFinite(body.ts)
  const payloadOk = typeof body.payload === 'object' && body.payload !== null
  if (!tenantOk || !actionOk || !tsOk || !payloadOk) {
    throw new PermanentAuditError('malformed audit message')
  }
}

function toFields(body: AuditQueueMessage): AuditFields {
  const payload = body.payload
  const str = (key: string): string | undefined => {
    const value = payload[key]
    return typeof value === 'string' ? value : undefined
  }
  const meta: Record<string, unknown> = redactAuditPayload(payload)
  for (const key of PROMOTED_META_KEYS) {
    delete meta[key]
  }
  return {
    tenantId: body.tenantId,
    orgId: body.orgId,
    eventType: body.action,
    actorId: body.actorId,
    actorIp: str('actorIp'),
    targetType: str('targetType'),
    targetId: str('targetId'),
    meta,
    occurredAt: new Date(body.ts).toISOString(),
  }
}

function sourceMessageId(message: Message<AuditQueueMessage>): string {
  const source = message.body.payload.sourceMessageId
  return typeof source === 'string' && source.length > 0 ? source : message.id
}

function getSeqStub(env: Env, tenantId: string): AuditSeqStub {
  const id = env.AUDIT_SEQ.idFromName(`audit-seq:${tenantId}`)
  return env.AUDIT_SEQ.get(id) as unknown as DurableObjectStub & AuditSeqStub
}

export async function computeChainRows(
  seqStart: number,
  prevHashStart: string,
  fieldsList: Array<AuditFields & { id: string }>,
): Promise<AuditRow[]> {
  const rows: AuditRow[] = []
  let prevHash = prevHashStart
  for (let index = 0; index < fieldsList.length; index++) {
    const fields = fieldsList[index]
    if (fields === undefined) continue
    const base: Omit<AuditRow, 'hash'> = { seq: seqStart + index, prevHash, ...fields }
    const hash = await sha256Hex(buildAuditInput(base))
    rows.push({ ...base, hash })
    prevHash = hash
  }
  return rows
}

async function recordPermanentDeadLetter(
  env: Env,
  message: Message<AuditQueueMessage>,
  sourceId: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO audit_dead_letters
      (id, message_id, source_message_id, tenant_id, reason, attempts, body, failed_at, created_at)
     VALUES (?, ?, ?, ?, 'permanent', ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      message.id,
      sourceId,
      typeof message.body.tenantId === 'string' ? message.body.tenantId : null,
      message.attempts + 1,
      JSON.stringify(message.body),
      new Date().toISOString(),
      Date.now(),
    )
    .run()
}

async function handleMessage(env: Env, message: Message<AuditQueueMessage>): Promise<void> {
  const sourceId = sourceMessageId(message)
  try {
    assertValidMessage(message.body)
  } catch (error) {
    if (!(error instanceof PermanentAuditError)) throw error
    try {
      await recordPermanentDeadLetter(env, message, sourceId)
      message.ack()
    } catch {
      message.retry()
    }
    return
  }

  const stub = getSeqStub(env, message.body.tenantId)
  try {
    const result = await stub.append({ sourceMessageId: sourceId, fields: toFields(message.body) })
    if (result.status === 'blocked') {
      message.retry()
      return
    }
    await completePlatformAuditOutbox(env, sourceId)
    message.ack()
  } catch {
    if (message.attempts + 1 <= MAX_ATTEMPTS) {
      message.retry()
      return
    }
    try {
      const result = await stub.terminalize({
        sourceMessageId: sourceId,
        messageId: message.id,
        tenantId: message.body.tenantId,
        attempts: message.attempts + 1,
        body: message.body,
      })
      if (result.status === 'blocked') {
        message.retry()
        return
      }
      await completePlatformAuditOutbox(env, sourceId)
      message.ack()
    } catch {
      message.retry()
    }
  }
}

export async function handleAuditBatch(
  batch: MessageBatch<AuditQueueMessage>,
  env: Env,
): Promise<void> {
  for (const message of batch.messages) {
    await handleMessage(env, message)
  }
}
