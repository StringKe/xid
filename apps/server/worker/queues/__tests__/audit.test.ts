import { describe, expect, it, vi } from 'vitest'
import type { AuditQueueMessage } from '@xid-kit/types'
import { sha256Hex } from '@xid-kit/crypto'
import {
  buildAuditInput,
  canonicalizeMeta,
  computeChainRows,
  handleAuditBatch,
  type AuditAppendInput,
} from '../audit'

const GENESIS = '0'.repeat(64)

type FakeMessage = {
  id: string
  attempts: number
  body: AuditQueueMessage
  ack: ReturnType<typeof vi.fn>
  retry: ReturnType<typeof vi.fn>
}

function makeMessage(id: string, body: Partial<AuditQueueMessage> = {}, attempts = 0): FakeMessage {
  return {
    id,
    attempts,
    body: {
      tenantId: 'tenant_1',
      action: 'auth.login_success',
      ts: 1_736_934_600_123,
      payload: {},
      ...body,
    } as AuditQueueMessage,
    ack: vi.fn(),
    retry: vi.fn(),
  }
}

type AppendResult = { status: 'appended' | 'blocked' | 'terminal' }

function makeEnv(
  append: (input: AuditAppendInput) => Promise<AppendResult>,
  terminalize: () => Promise<AppendResult> = () => Promise.resolve({ status: 'terminal' }),
): Env {
  return {
    AUDIT_SEQ: {
      idFromName: (name: string) => name,
      get: () => ({ append, terminalize }),
    },
    DB: {
      prepare: () => ({ bind: () => ({ run: () => Promise.resolve() }) }),
    },
  } as unknown as Env
}

describe('canonicalizeMeta', () => {
  it('按 UTF-16 排序且不保留空白', () => {
    expect(canonicalizeMeta({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
  })
})

describe('computeChainRows', () => {
  it('生成连续 seq 与可验证 hash 链', async () => {
    const rows = await computeChainRows(1, GENESIS, [
      {
        id: 'id_a',
        tenantId: 'tenant_1',
        orgId: undefined,
        eventType: 'auth.login_success',
        actorId: 'user_1',
        actorIp: undefined,
        targetType: undefined,
        targetId: undefined,
        meta: { a: 1 },
        occurredAt: '2025-01-15T10:30:00.123Z',
      },
      {
        id: 'id_b',
        tenantId: 'tenant_1',
        orgId: undefined,
        eventType: 'auth.logout',
        actorId: 'user_1',
        actorIp: undefined,
        targetType: undefined,
        targetId: undefined,
        meta: { b: 2 },
        occurredAt: '2025-01-15T10:30:01.123Z',
      },
    ])
    expect(rows.map((row) => row.seq)).toEqual([1, 2])
    expect(rows[0]?.prevHash).toBe(GENESIS)
    expect(rows[1]?.prevHash).toBe(rows[0]?.hash)
    const { hash: _hash, ...firstRow } = rows[0]!
    expect(rows[0]?.hash).toBe(await sha256Hex(buildAuditInput(firstRow)))
  })
})

describe('handleAuditBatch source identity', () => {
  it('[A,B] 失败后 [B] 重试不会写重复事件或产生序列空洞', async () => {
    const committed: Array<{ source: string; seq: number }> = []
    let pending: string | undefined
    let next = 1
    let failA = true
    const append = async (input: AuditAppendInput): Promise<AppendResult> => {
      if (committed.some((event) => event.source === input.sourceMessageId)) {
        return { status: 'appended' }
      }
      if (pending !== undefined && pending !== input.sourceMessageId) {
        return { status: 'blocked' }
      }
      pending = input.sourceMessageId
      if (input.sourceMessageId === 'A' && failA) {
        failA = false
        throw new Error('d1 unavailable')
      }
      committed.push({ source: input.sourceMessageId, seq: next })
      next += 1
      pending = undefined
      return { status: 'appended' }
    }
    const env = makeEnv(append)
    const firstA = makeMessage('A')
    const firstB = makeMessage('B')
    await handleAuditBatch({ messages: [firstA, firstB] } as MessageBatch<AuditQueueMessage>, env)
    expect(firstA.retry).toHaveBeenCalledOnce()
    expect(firstB.retry).toHaveBeenCalledOnce()

    const splitB = makeMessage('B', {}, 1)
    await handleAuditBatch({ messages: [splitB] } as MessageBatch<AuditQueueMessage>, env)
    expect(splitB.retry).toHaveBeenCalledOnce()
    expect(committed).toEqual([])

    const retryA = makeMessage('A', {}, 1)
    const retryB = makeMessage('B', {}, 2)
    await handleAuditBatch({ messages: [retryA] } as MessageBatch<AuditQueueMessage>, env)
    await handleAuditBatch({ messages: [retryB] } as MessageBatch<AuditQueueMessage>, env)
    expect(committed).toEqual([
      { source: 'A', seq: 1 },
      { source: 'B', seq: 2 },
    ])
    expect(retryA.ack).toHaveBeenCalledOnce()
    expect(retryB.ack).toHaveBeenCalledOnce()
  })

  it('ack 丢失后的重复投递复用同一 source identity', async () => {
    const sources = new Set<string>()
    const append = async (input: AuditAppendInput): Promise<AppendResult> => {
      sources.add(input.sourceMessageId)
      return { status: 'appended' }
    }
    const env = makeEnv(append)
    const first = makeMessage('queue_1')
    const replay = makeMessage('queue_1', {}, 1)
    await handleAuditBatch({ messages: [first] } as MessageBatch<AuditQueueMessage>, env)
    await handleAuditBatch({ messages: [replay] } as MessageBatch<AuditQueueMessage>, env)
    expect(sources).toEqual(new Set(['queue_1']))
    expect(first.ack).toHaveBeenCalledOnce()
    expect(replay.ack).toHaveBeenCalledOnce()
  })

  it('notification payload 的 sourceMessageId 优先于 Queue id', async () => {
    const appended: AuditAppendInput[] = []
    const env = makeEnv(async (input) => {
      appended.push(input)
      return { status: 'appended' }
    })
    const message = makeMessage('queue_id', {
      payload: { sourceMessageId: 'notification:email:delivery_1' },
    })
    await handleAuditBatch({ messages: [message] } as MessageBatch<AuditQueueMessage>, env)
    expect(appended[0]?.sourceMessageId).toBe('notification:email:delivery_1')
  })

  it('超过重试上限时由 DO 原子终态化并 ack', async () => {
    const terminalize = vi
      .fn<() => Promise<AppendResult>>()
      .mockResolvedValue({ status: 'terminal' })
    const env = makeEnv(() => Promise.reject(new Error('d1 unavailable')), terminalize)
    const message = makeMessage('poison', {}, 5)
    await handleAuditBatch({ messages: [message] } as MessageBatch<AuditQueueMessage>, env)
    expect(terminalize).toHaveBeenCalledOnce()
    expect(message.ack).toHaveBeenCalledOnce()
    expect(message.retry).not.toHaveBeenCalled()
  })

  it('前序待提交时超过上限仍 retry，不能把后序误终态化', async () => {
    const terminalize = vi
      .fn<() => Promise<AppendResult>>()
      .mockResolvedValue({ status: 'blocked' })
    const env = makeEnv(async () => ({ status: 'blocked' }), terminalize)
    const message = makeMessage('B', {}, 5)
    await handleAuditBatch({ messages: [message] } as MessageBatch<AuditQueueMessage>, env)
    expect(terminalize).not.toHaveBeenCalled()
    expect(message.retry).toHaveBeenCalledOnce()
  })
})
