// Webhook 队列投递写入 response_ms / last_error:非最终失败保留 pending 行与下次重试时间,
// 下一次队列尝试重新认领同一行,最终失败落 dead。真实 sqlite + 迁移链。

import { afterEach, describe, expect, it, vi } from 'vitest'
import { base64UrlEncode, envelopeEncrypt } from '@xid-kit/crypto'
import { handleWebhookBatch } from '../../queues/webhook'
import { envOf, makeDb, tenantDb, TENANT_A } from './console-fixtures'
import type { SqliteD1 } from '../../../../../packages/db/src/__tests__/sqlite-d1'

const KEK = new Uint8Array(32).fill(7)

async function seedSubscription(d1: SqliteD1): Promise<void> {
  const blob = await envelopeEncrypt(new Uint8Array(32).fill(1), KEK, 1)
  await tenantDb(d1).webhooks.insert({
    id: 'wh_fleet',
    tenantId: TENANT_A.tenantId,
    url: 'https://hooks.fleetplanner.app/xid/events',
    eventTypes: [],
    signingSecretHash: 'v3:whsec_base64',
    signingSecretIv: base64UrlEncode(blob.iv),
    signingSecretCiphertext: base64UrlEncode(blob.ciphertext),
    signingSecretTag: base64UrlEncode(blob.tag),
    status: 'active',
  })
}

function message(attempts: number) {
  return {
    id: 'queue_msg_1',
    attempts,
    body: { tenantId: TENANT_A.tenantId, event: 'user.updated', payload: { userId: 'user_ravi' } },
    ack: vi.fn(),
    retry: vi.fn(),
  }
}

async function run(d1: SqliteD1, attempts: number) {
  const env = { ...envOf(d1), KEK: btoa(String.fromCharCode(...KEK)) } as unknown as Env
  const msg = message(attempts)
  await handleWebhookBatch({ messages: [msg] } as unknown as MessageBatch<never>, env)
  return msg
}

async function deliveryRow(d1: SqliteD1) {
  const rows = await tenantDb(d1).webhookDeliveries.findMany()
  expect(rows).toHaveLength(1)
  return rows[0]
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('webhook queue delivery bookkeeping', () => {
  it('keeps a failed attempt as pending with the HTTP error and the next retry time', async () => {
    const d1 = makeDb()
    await seedSubscription(d1)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 503 })))

    const msg = await run(d1, 0)
    const row = await deliveryRow(d1)

    expect(msg.retry).toHaveBeenCalledOnce()
    expect(row).toMatchObject({
      status: 'pending',
      attemptCount: 1,
      responseStatus: 503,
      lastError: 'http',
    })
    expect(row?.responseMs).toEqual(expect.any(Number))
    expect(row?.nextRetryAt?.getTime()).toBeGreaterThan(Date.now())
  })

  it('reclaims the same row on the next queue attempt and records the success', async () => {
    const d1 = makeDb()
    await seedSubscription(d1)
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 503 }))
        .mockResolvedValueOnce(new Response(null, { status: 204 })),
    )

    await run(d1, 0)
    const second = await run(d1, 1)
    const row = await deliveryRow(d1)

    expect(second.ack).toHaveBeenCalledOnce()
    expect(row).toMatchObject({
      status: 'delivered',
      attemptCount: 2,
      responseStatus: 204,
      lastError: null,
      nextRetryAt: null,
    })
  })

  it('marks the final timed-out attempt as dead with a timeout error', async () => {
    const d1 = makeDb()
    await seedSubscription(d1)
    const timeout = new DOMException('The operation timed out.', 'TimeoutError')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(timeout))

    await run(d1, 4)
    const row = await deliveryRow(d1)

    expect(row).toMatchObject({
      status: 'dead',
      attemptCount: 5,
      responseStatus: null,
      responseMs: null,
      lastError: 'timeout',
    })
  })

  it('records an unreachable endpoint as a network error', async () => {
    const d1 = makeDb()
    await seedSubscription(d1)
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))

    await run(d1, 0)
    const row = await deliveryRow(d1)

    expect(row).toMatchObject({ status: 'pending', lastError: 'network' })
  })
})
