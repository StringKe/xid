// Queue dispatch 路由测试:按 batch.queue 名分发到对应 consumer;未知队列 retryAll 保留消息。
// 用空消息批(messages=[])避免触发真实 D1/DO 逻辑,仅验证路由分支。

import { describe, it, expect, vi } from 'vitest'
import { dispatchQueue, QUEUE_NAMES } from '../index'

type FakeBatch = {
  queue: string
  messages: unknown[]
  ackAll: ReturnType<typeof vi.fn>
  retryAll: ReturnType<typeof vi.fn>
}

function makeBatch(queue: string): FakeBatch {
  return { queue, messages: [], ackAll: vi.fn(), retryAll: vi.fn() }
}

// 各 consumer 对空消息批是 no-op(for 循环不进入),因此无需真实 env。
const env = {} as Env

describe('dispatchQueue:按队列名路由', () => {
  it('xid-email 不抛错(路由到 email consumer)', async () => {
    const batch = makeBatch(QUEUE_NAMES.email)
    await expect(
      dispatchQueue(batch as unknown as MessageBatch<never>, env),
    ).resolves.toBeUndefined()
    // 已知队列由 per-message ack,空批不调 ackAll
    expect(batch.ackAll).not.toHaveBeenCalled()
  })

  it('xid-audit 路由到 audit consumer', async () => {
    const batch = makeBatch(QUEUE_NAMES.audit)
    await dispatchQueue(batch as unknown as MessageBatch<never>, env)
    expect(batch.ackAll).not.toHaveBeenCalled()
  })

  it('xid-sms 路由到 sms consumer', async () => {
    const batch = makeBatch(QUEUE_NAMES.sms)
    await dispatchQueue(batch as unknown as MessageBatch<never>, env)
    expect(batch.ackAll).not.toHaveBeenCalled()
  })

  it('xid-whatsapp 路由到 whatsapp consumer', async () => {
    const batch = makeBatch(QUEUE_NAMES.whatsapp)
    await dispatchQueue(batch as unknown as MessageBatch<never>, env)
    expect(batch.ackAll).not.toHaveBeenCalled()
  })

  it('xid-webhook 路由到 webhook consumer', async () => {
    const batch = makeBatch(QUEUE_NAMES.webhook)
    await dispatchQueue(batch as unknown as MessageBatch<never>, env)
    expect(batch.ackAll).not.toHaveBeenCalled()
  })

  it('xid-metering 路由到 metering consumer', async () => {
    const batch = makeBatch(QUEUE_NAMES.metering)
    await dispatchQueue(batch as unknown as MessageBatch<never>, env)
    expect(batch.ackAll).not.toHaveBeenCalled()
  })

  it('未知队列名 retryAll,不确认丢弃消息', async () => {
    const batch = makeBatch('xid-unknown')
    await dispatchQueue(batch as unknown as MessageBatch<never>, env)
    expect(batch.retryAll).toHaveBeenCalledOnce()
    expect(batch.ackAll).not.toHaveBeenCalled()
  })

  it('QUEUE_NAMES 与 wrangler.jsonc consumers 队列名一致', () => {
    expect(QUEUE_NAMES).toEqual({
      email: 'xid-email',
      whatsapp: 'xid-whatsapp',
      sms: 'xid-sms',
      audit: 'xid-audit',
      webhook: 'xid-webhook',
      metering: 'xid-metering',
    })
  })
})
