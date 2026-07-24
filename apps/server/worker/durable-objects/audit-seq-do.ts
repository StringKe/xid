// AuditSeqDO 是每租户审计链的唯一提交者。
// D1 和 DO storage 不能组成跨存储事务，因此先把待提交行写入 DO，再写 D1；
// D1 成功后才推进 next。崩溃窗口由 source_message_id 查询恢复，不会重复或跳号。

/// <reference types="@cloudflare/workers-types" />

import { sha256Hex } from '@xid-kit/crypto'
import { DurableObject } from 'cloudflare:workers'
import { buildAuditInput, type AuditAppendInput, type AuditRow } from '../queues/audit'

const GENESIS_HASH = '0'.repeat(64)
const NEXT_STORAGE_KEY = 'next'
const LAST_HASH_STORAGE_KEY = 'last_hash'
const PENDING_STORAGE_KEY = 'pending'

type PersistedAuditEvent = Pick<AuditRow, 'seq' | 'id' | 'hash'>

type PendingAuditEvent = {
  sourceMessageId: string
  row: AuditRow
}

type AppendResult = { status: 'appended' | 'blocked' | 'terminal' }

type TerminalInput = {
  sourceMessageId: string
  messageId: string
  tenantId: string
  attempts: number
  body: unknown
}

export class AuditSeqDO extends DurableObject<Env> {
  private next = 1
  private lastHash = GENESIS_HASH
  private pending: PendingAuditEvent | undefined
  private initialized = false

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    void ctx.blockConcurrencyWhile(async () => {
      const [storedNext, storedHash, storedPending] = await Promise.all([
        ctx.storage.get<number>(NEXT_STORAGE_KEY),
        ctx.storage.get<string>(LAST_HASH_STORAGE_KEY),
        ctx.storage.get<PendingAuditEvent>(PENDING_STORAGE_KEY),
      ])
      this.pending = storedPending
      if (storedNext !== undefined && storedHash !== undefined) {
        this.next = storedNext
        this.lastHash = storedHash
        this.initialized = true
      }
    })
  }

  async append(input: AuditAppendInput): Promise<AppendResult> {
    await this.initialize(input.fields.tenantId)
    const existing = await this.findPersistedEvent(input.fields.tenantId, input.sourceMessageId)
    if (existing !== undefined) {
      await this.commitPersisted(existing)
      return { status: 'appended' }
    }
    if (await this.hasTerminalEvent(input.fields.tenantId, input.sourceMessageId)) {
      return { status: 'terminal' }
    }
    if (this.pending !== undefined && this.pending.sourceMessageId !== input.sourceMessageId) {
      return { status: 'blocked' }
    }

    const pending = this.pending ?? (await this.createPending(input))
    await this.insertAndConfirm(pending)
    await this.commitPersisted({ seq: pending.row.seq, id: pending.row.id, hash: pending.row.hash })
    return { status: 'appended' }
  }

  async terminalize(input: TerminalInput): Promise<AppendResult> {
    await this.initialize(input.tenantId)
    const existing = await this.findPersistedEvent(input.tenantId, input.sourceMessageId)
    if (existing !== undefined) {
      await this.commitPersisted(existing)
      return { status: 'appended' }
    }
    if (await this.hasTerminalEvent(input.tenantId, input.sourceMessageId)) {
      await this.discardPending(input.sourceMessageId)
      return { status: 'terminal' }
    }
    if (this.pending !== undefined && this.pending.sourceMessageId !== input.sourceMessageId) {
      return { status: 'blocked' }
    }

    await this.env.DB.prepare(
      `INSERT OR IGNORE INTO audit_dead_letters
        (id, message_id, source_message_id, tenant_id, reason, attempts, body, failed_at, created_at)
       VALUES (?, ?, ?, ?, 'max_attempts', ?, ?, ?, ?)`,
    )
      .bind(
        crypto.randomUUID(),
        input.messageId,
        input.sourceMessageId,
        input.tenantId,
        input.attempts,
        JSON.stringify(input.body),
        new Date().toISOString(),
        Date.now(),
      )
      .run()
    await this.discardPending(input.sourceMessageId)
    return { status: 'terminal' }
  }

  private async createPending(input: AuditAppendInput): Promise<PendingAuditEvent> {
    const id = await sha256Hex(`${input.fields.tenantId}\u0000${input.sourceMessageId}`)
    const base: Omit<AuditRow, 'hash'> = {
      ...input.fields,
      seq: this.next,
      id,
      prevHash: this.lastHash,
    }
    const pending: PendingAuditEvent = {
      sourceMessageId: input.sourceMessageId,
      row: { ...base, hash: await sha256Hex(buildAuditInput(base)) },
    }
    await this.ctx.storage.put(PENDING_STORAGE_KEY, pending)
    this.pending = pending
    return pending
  }

  private async initialize(tenantId: string): Promise<void> {
    if (this.initialized) return
    const latest = await this.latestPersistedEvent(tenantId)
    this.next = latest === undefined ? 1 : latest.seq + 1
    this.lastHash = latest?.hash ?? GENESIS_HASH
    await this.ctx.storage.put({
      [NEXT_STORAGE_KEY]: this.next,
      [LAST_HASH_STORAGE_KEY]: this.lastHash,
    })
    this.initialized = true
  }

  private async insertAndConfirm(pending: PendingAuditEvent): Promise<void> {
    const row = pending.row
    await this.env.DB.prepare(
      `INSERT OR IGNORE INTO audit_events
        (seq, id, source_message_id, tenant_id, org_id, event_type, actor_id, actor_ip, target_type, target_id, meta, occurred_at, prev_hash, hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        row.seq,
        row.id,
        pending.sourceMessageId,
        row.tenantId,
        row.orgId ?? null,
        row.eventType,
        row.actorId ?? null,
        row.actorIp ?? null,
        row.targetType ?? null,
        row.targetId ?? null,
        JSON.stringify(row.meta),
        row.occurredAt,
        row.prevHash,
        row.hash,
      )
      .run()
    const persisted = await this.findPersistedEvent(row.tenantId, pending.sourceMessageId)
    if (persisted === undefined) {
      throw new Error('audit event insert was not observable')
    }
    if (persisted.seq !== row.seq || persisted.id !== row.id || persisted.hash !== row.hash) {
      throw new Error('audit source identity collision')
    }
  }

  private async commitPersisted(event: PersistedAuditEvent): Promise<void> {
    if (event.seq < this.next) {
      await this.discardPendingBySeq(event.seq)
      return
    }
    if (event.seq !== this.next) {
      throw new Error('audit sequence advanced outside the tenant durable object')
    }
    const next = event.seq + 1
    await this.ctx.storage.put({
      [NEXT_STORAGE_KEY]: next,
      [LAST_HASH_STORAGE_KEY]: event.hash,
    })
    await this.ctx.storage.delete(PENDING_STORAGE_KEY)
    this.next = next
    this.lastHash = event.hash
    this.pending = undefined
  }

  private async discardPending(sourceMessageId: string): Promise<void> {
    if (this.pending?.sourceMessageId !== sourceMessageId) return
    await this.ctx.storage.delete(PENDING_STORAGE_KEY)
    this.pending = undefined
  }

  private async discardPendingBySeq(seq: number): Promise<void> {
    if (this.pending?.row.seq !== seq) return
    await this.ctx.storage.delete(PENDING_STORAGE_KEY)
    this.pending = undefined
  }

  private async latestPersistedEvent(tenantId: string): Promise<PersistedAuditEvent | undefined> {
    const result = await this.env.DB.prepare(
      `SELECT seq, id, hash FROM audit_events WHERE tenant_id = ? ORDER BY seq DESC LIMIT 1`,
    )
      .bind(tenantId)
      .first<PersistedAuditEvent>()
    return result ?? undefined
  }

  private async findPersistedEvent(
    tenantId: string,
    sourceMessageId: string,
  ): Promise<PersistedAuditEvent | undefined> {
    const result = await this.env.DB.prepare(
      `SELECT seq, id, hash FROM audit_events WHERE tenant_id = ? AND source_message_id = ? LIMIT 1`,
    )
      .bind(tenantId, sourceMessageId)
      .first<PersistedAuditEvent>()
    return result ?? undefined
  }

  private async hasTerminalEvent(tenantId: string, sourceMessageId: string): Promise<boolean> {
    const result = await this.env.DB.prepare(
      `SELECT 1 AS found FROM audit_dead_letters
       WHERE tenant_id = ? AND source_message_id = ? LIMIT 1`,
    )
      .bind(tenantId, sourceMessageId)
      .first<{ found: number }>()
    return result !== null && result !== undefined
  }
}
