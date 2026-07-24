// Webhook svix 风格 HMAC-SHA256 签名测试:签名确定性、内容绑定、验证、跨 secret 不匹配。
// 补充:用正确的解密 secret 验签通过、markDead 用快照不重新拉取订阅。

import { describe, it, expect, vi } from 'vitest'
import {
  hmacSha256Base64,
  hmacSha256Verify,
  envelopeEncrypt,
  envelopeDecrypt,
  base64UrlEncode,
} from '@xid-kit/crypto'
import { signWebhook } from '../webhook'

const secret = new TextEncoder().encode('whsec_test_key')

describe('signWebhook:svix 头', () => {
  it('返回 svix-id / svix-timestamp / svix-signature 三头', async () => {
    const headers = await signWebhook(secret, 'msg_1', 1700000000, '{"a":1}')
    expect(headers['svix-id']).toBe('msg_1')
    expect(headers['svix-timestamp']).toBe('1700000000')
    expect(headers['svix-signature']).toMatch(/^v1,/)
  })

  it('签名 = base64(HMAC-SHA256(secret, `id.ts.payload`))', async () => {
    const id = 'msg_1'
    const ts = 1700000000
    const payload = '{"event":"user.created"}'
    const headers = await signWebhook(secret, id, ts, payload)
    const expected = await hmacSha256Base64(secret, `${id}.${ts}.${payload}`)
    expect(headers['svix-signature']).toBe(`v1,${expected}`)
  })

  it('签名确定性:相同输入相同签名', async () => {
    const a = await signWebhook(secret, 'm', 1, 'p')
    const b = await signWebhook(secret, 'm', 1, 'p')
    expect(a['svix-signature']).toBe(b['svix-signature'])
  })

  it('payload 不同则签名不同(内容绑定)', async () => {
    const a = await signWebhook(secret, 'm', 1, 'p1')
    const b = await signWebhook(secret, 'm', 1, 'p2')
    expect(a['svix-signature']).not.toBe(b['svix-signature'])
  })

  it('timestamp 不同则签名不同(防重放绑定)', async () => {
    const a = await signWebhook(secret, 'm', 1, 'p')
    const b = await signWebhook(secret, 'm', 2, 'p')
    expect(a['svix-signature']).not.toBe(b['svix-signature'])
  })
})

describe('hmacSha256Verify:验证', () => {
  it('正确签名验证通过', async () => {
    const content = 'msg_1.1700000000.{"a":1}'
    const sig = await hmacSha256Base64(secret, content)
    expect(await hmacSha256Verify(secret, content, sig)).toBe(true)
  })

  it('错误 secret 验证失败', async () => {
    const content = 'msg_1.1.p'
    const sig = await hmacSha256Base64(secret, content)
    const other = new TextEncoder().encode('whsec_other')
    expect(await hmacSha256Verify(other, content, sig)).toBe(false)
  })

  it('篡改内容验证失败', async () => {
    const sig = await hmacSha256Base64(secret, 'msg_1.1.p')
    expect(await hmacSha256Verify(secret, 'msg_1.1.tampered', sig)).toBe(false)
  })
})

describe('webhook HMAC:用信封解密后的正确 secret 验签', () => {
  it('envelopeDecrypt 后的 secret 与签名匹配(非哈希)', async () => {
    // 模拟 findSubscriptions 路径:secret 原值 -> 信封加密存 D1 -> 解密 -> HMAC。
    const rawSecret = new TextEncoder().encode('real_signing_secret_32bytes_paddd')
    const kek = crypto.getRandomValues(new Uint8Array(32))
    const blob = await envelopeEncrypt(rawSecret, kek, 1)
    const decrypted = await envelopeDecrypt(blob, kek)

    const id = 'msg_abc'
    const ts = 1700000001
    const payload = '{"event":"user.created"}'
    const headers = await signWebhook(decrypted, id, ts, payload)

    // 用解密后的 secret 验签应通过。
    const content = `${id}.${ts}.${payload}`
    const sigValue = headers['svix-signature'].replace(/^v1,/, '')
    expect(await hmacSha256Verify(decrypted, content, sigValue)).toBe(true)

    // 用 SHA-256 哈希作 secret(旧错误用法)验签应失败。
    const hashBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', rawSecret))
    expect(await hmacSha256Verify(hashBytes, content, sigValue)).toBe(false)
  })
})

describe('markDead:用投递时的订阅快照,不重新拉取', () => {
  it('handleWebhookBatch 失败时 markDead 使用快照而非重新查询', async () => {
    // findSubscriptions 只在投递时调一次;死信时直接复用快照。
    // 此测试验证 DB.prepare 调用次数:空 batch 不查 DB,达上限时查一次。
    const dbCalls: string[] = []
    const fakeDb = {
      prepare: (sql: string) => {
        dbCalls.push(sql)
        return {
          bind: () => ({
            all: () => Promise.resolve({ results: [] }),
            run: () => Promise.resolve(),
          }),
        }
      },
    }
    // KEK 是 base64 标准编码的 32 字节(decodeKek 在 findSubscriptions 内解码)。
    // 此测试 results=[] 不走解密路径,KEK 值无影响,用全零 base64 占位。
    const fakeEnv = {
      DB: fakeDb,
      KEK: btoa(String.fromCharCode(...new Array(32).fill(0))),
    } as unknown as Env

    // 构造 attempt >= MAX_ATTEMPTS(5) 的消息,触发死信路径。
    const fakeMsg = {
      body: { tenantId: 't1', event: 'user.created', payload: {} },
      attempts: 5,
      ack: vi.fn(),
      retry: vi.fn(),
    }
    const fakeBatch = {
      messages: [fakeMsg],
    } as unknown as MessageBatch<never>

    const { handleWebhookBatch } = await import('../webhook')
    await handleWebhookBatch(fakeBatch as MessageBatch<never>, fakeEnv)

    // 只有 findSubscriptions 调一次 SELECT,markDead 不再 SELECT。
    const selectCalls = dbCalls.filter((s) => s.includes('FROM webhooks'))
    expect(selectCalls).toHaveLength(1)
    expect(fakeMsg.ack).toHaveBeenCalledOnce()
  })
})

describe('deliver:SSRF 防御深度', () => {
  const headers = {
    'svix-id': 'msg_1',
    'svix-timestamp': '1700000000',
    'svix-signature': 'v1,sig',
  }

  it('内网/明文 URL 直接拒绝,不发起 fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { deliver } = await import('../webhook')

    for (const url of ['http://hooks.example.com/x', 'https://169.254.169.254/latest']) {
      await expect(
        deliver({ id: 'wh_1', url, signingSecret: secret }, 'user.created', '{}', headers),
      ).rejects.toThrow('SSRF guard')
    }
    expect(fetchMock).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('公网 https URL 正常投递且 redirect: manual(拒 302 二跳)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const { deliver } = await import('../webhook')

    const status = await deliver(
      { id: 'wh_1', url: 'https://receiver.example.com/hook', signingSecret: secret },
      'user.created',
      '{"a":1}',
      headers,
    )

    expect(status).toBe(200)
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect(init.redirect).toBe('manual')
    vi.unstubAllGlobals()
  })
})

describe('webhook delivery idempotency', () => {
  it('2xx 后状态写入失败重试时复用 svix-id', async () => {
    const rawSecret = new TextEncoder().encode('real_signing_secret_32bytes_paddd')
    const kek = crypto.getRandomValues(new Uint8Array(32))
    const blob = await envelopeEncrypt(rawSecret, kek, 1)
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)

    let failDeliveredWrite = true
    const fakeDb = {
      prepare: (sql: string) => ({
        bind: () => ({
          all: () =>
            Promise.resolve({
              results: [
                {
                  id: 'wh_1',
                  url: 'https://receiver.example.com/webhook',
                  event_types: JSON.stringify(['user.created']),
                  signing_secret_iv: base64UrlEncode(blob.iv),
                  signing_secret_ciphertext: base64UrlEncode(blob.ciphertext),
                  signing_secret_tag: base64UrlEncode(blob.tag),
                },
              ],
            }),
          run: () => {
            if (sql.includes("SET status = 'delivered'") && failDeliveredWrite) {
              failDeliveredWrite = false
              return Promise.reject(new Error('simulated status write interruption'))
            }
            return Promise.resolve({ meta: { changes: 1 } })
          },
        }),
      }),
    }
    const fakeEnv = {
      DB: fakeDb,
      KEK: btoa(String.fromCharCode(...kek)),
    } as unknown as Env

    const messageBody = { tenantId: 't1', event: 'user.created', payload: { id: 'user_1' } }
    const makeMessage = (attempts: number) => ({
      id: 'queue_msg_1',
      body: messageBody,
      attempts,
      ack: vi.fn(),
      retry: vi.fn(),
    })
    const { handleWebhookBatch } = await import('../webhook')

    const first = makeMessage(0)
    await handleWebhookBatch({ messages: [first] } as unknown as MessageBatch<never>, fakeEnv)
    const retry = makeMessage(1)
    await handleWebhookBatch({ messages: [retry] } as unknown as MessageBatch<never>, fakeEnv)

    const firstInit = fetchMock.mock.calls[0]?.[1] as RequestInit
    const retryInit = fetchMock.mock.calls[1]?.[1] as RequestInit
    const firstHeaders = firstInit.headers as Record<string, string>
    const retryHeaders = retryInit.headers as Record<string, string>
    expect(firstHeaders['svix-id']).toBe(retryHeaders['svix-id'])
    expect(firstHeaders['svix-id']).toMatch(/^msg_/)
    expect(first.retry).toHaveBeenCalledOnce()
    expect(retry.ack).toHaveBeenCalledOnce()
    vi.unstubAllGlobals()
  })

  it('失去 delivery claim 后的 2xx 不会 ACK 队列消息', async () => {
    const rawSecret = new TextEncoder().encode('real_signing_secret_32bytes_paddd')
    const kek = crypto.getRandomValues(new Uint8Array(32))
    const blob = await envelopeEncrypt(rawSecret, kek, 1)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })))

    const fakeDb = {
      prepare: (sql: string) => ({
        bind: () => ({
          all: () =>
            Promise.resolve({
              results: [
                {
                  id: 'wh_1',
                  url: 'https://receiver.example.com/webhook',
                  event_types: JSON.stringify(['user.created']),
                  signing_secret_iv: base64UrlEncode(blob.iv),
                  signing_secret_ciphertext: base64UrlEncode(blob.ciphertext),
                  signing_secret_tag: base64UrlEncode(blob.tag),
                },
              ],
            }),
          run: () =>
            Promise.resolve({
              meta: { changes: sql.includes("SET status = 'delivered'") ? 0 : 1 },
            }),
        }),
      }),
    }
    const fakeEnv = {
      DB: fakeDb,
      KEK: btoa(String.fromCharCode(...kek)),
    } as unknown as Env
    const message = {
      id: 'queue_msg_fenced',
      body: { tenantId: 't1', event: 'user.created', payload: { id: 'user_1' } },
      attempts: 0,
      ack: vi.fn(),
      retry: vi.fn(),
    }
    const { handleWebhookBatch } = await import('../webhook')

    await handleWebhookBatch({ messages: [message] } as unknown as MessageBatch<never>, fakeEnv)

    expect(message.ack).not.toHaveBeenCalled()
    expect(message.retry).toHaveBeenCalledOnce()
    vi.unstubAllGlobals()
  })
})
