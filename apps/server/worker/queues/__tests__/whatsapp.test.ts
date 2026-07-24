// WhatsApp Consumer 测试:provider readiness、Twilio/Meta 请求、失败重试和 notification_failures。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WhatsappQueueMessage } from '@xid-kit/types'
import { handleWhatsappBatch, whatsappProviderReady } from '../whatsapp'

vi.mock('../notification-delivery-state', () => ({
  DELIVERY_RETRY_SECONDS: 15,
  executeNotificationDelivery: async (
    _env: Env,
    _input: unknown,
    callbacks: { send(): Promise<void>; recordAudit(): Promise<void> },
  ) => {
    await callbacks.send()
    await callbacks.recordAudit()
    return 'ack'
  },
}))

function makeEnv(overrides: Record<string, unknown> = {}): Env {
  return {
    DB: { prepare: () => ({ bind: () => ({ run: vi.fn().mockResolvedValue(undefined) }) }) },
    STORAGE: { get: vi.fn().mockResolvedValue(null) },
    AUDIT_QUEUE: { send: vi.fn().mockResolvedValue(undefined) },
    ...overrides,
  } as unknown as Env
}

function makeMessage(body: WhatsappQueueMessage, attempts = 1, id = 'whatsapp-message') {
  return {
    id,
    body,
    attempts,
    ack: vi.fn(),
    retry: vi.fn(),
  }
}

function makeBatch(message: ReturnType<typeof makeMessage>): MessageBatch<WhatsappQueueMessage> {
  return { messages: [message] } as unknown as MessageBatch<WhatsappQueueMessage>
}

describe('whatsappProviderReady', () => {
  it('Twilio 要求 account sid、auth token 且 from 或 messaging service sid 存在', () => {
    expect(
      whatsappProviderReady(
        makeEnv({
          WHATSAPP_PROVIDER: 'twilio',
          TWILIO_ACCOUNT_SID: 'AC123',
          TWILIO_AUTH_TOKEN: 'token',
          WHATSAPP_FROM: '+15550000000',
        }),
      ),
    ).toBe(true)
    expect(
      whatsappProviderReady(
        makeEnv({
          WHATSAPP_PROVIDER: 'twilio',
          TWILIO_ACCOUNT_SID: 'AC123',
          TWILIO_AUTH_TOKEN: 'token',
          TWILIO_MESSAGING_SERVICE_SID: 'MG123',
        }),
      ),
    ).toBe(true)
    expect(whatsappProviderReady(makeEnv({ WHATSAPP_PROVIDER: 'twilio' }))).toBe(false)
  })

  it('Meta 要求 phone number id 和 access token', () => {
    expect(
      whatsappProviderReady(
        makeEnv({
          WHATSAPP_PROVIDER: 'meta',
          WHATSAPP_META_PHONE_NUMBER_ID: '1234567890',
          WHATSAPP_META_ACCESS_TOKEN: 'token',
        }),
      ),
    ).toBe(true)
    expect(whatsappProviderReady(makeEnv({ WHATSAPP_PROVIDER: 'meta' }))).toBe(false)
  })

  it('test provider 仅在 development/test 环境可用', () => {
    expect(
      whatsappProviderReady(makeEnv({ WHATSAPP_PROVIDER: 'test', ENVIRONMENT: 'development' })),
    ).toBe(true)
    expect(
      whatsappProviderReady(makeEnv({ WHATSAPP_PROVIDER: 'test', ENVIRONMENT: 'production' })),
    ).toBe(false)
  })
})

describe('handleWhatsappBatch', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('Twilio provider 发送 whatsapp form encoded message 并 ack', async () => {
    const message = makeMessage({
      type: 'otp',
      recipient: '+15551234567',
      payload: { tenantId: 'tenant-1', userId: 'user-1', code: '123456', expiresInMin: 5 },
    })
    const auditSend = vi.fn().mockResolvedValue(undefined)
    const env = makeEnv({
      WHATSAPP_PROVIDER: 'twilio',
      TWILIO_ACCOUNT_SID: 'AC123',
      TWILIO_AUTH_TOKEN: 'token',
      WHATSAPP_FROM: '+15550000000',
      AUDIT_QUEUE: { send: auditSend },
    })

    await handleWhatsappBatch(makeBatch(message), env)

    expect(fetch).toHaveBeenCalledWith(
      'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          authorization: expect.stringMatching(/^Basic /),
          'content-type': 'application/x-www-form-urlencoded',
        }),
      }),
    )
    const twilioCall = vi.mocked(fetch).mock.calls[0]
    if (twilioCall === undefined) throw new Error('missing twilio fetch call')
    const body = (twilioCall[1] as { body: URLSearchParams }).body
    expect(body.get('To')).toBe('whatsapp:+15551234567')
    expect(body.get('From')).toBe('whatsapp:+15550000000')
    expect(auditSend).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        actorId: 'user-1',
        action: 'notification.sent',
        payload: expect.objectContaining({
          channel: 'whatsapp',
          type: 'otp',
          provider: 'twilio',
          recipientType: 'phone',
        }),
      }),
    )
    const auditPayload = auditSend.mock.calls[0]?.[0]?.payload as Record<string, unknown>
    expect(JSON.stringify(auditPayload)).not.toContain('+15551234567')
    expect(JSON.stringify(auditPayload)).not.toContain('123456')
    expect(message.ack).toHaveBeenCalledOnce()
    expect(message.retry).not.toHaveBeenCalled()
  })

  it('Twilio provider 仅配置 messaging service sid 时不要求 from', async () => {
    const message = makeMessage({
      type: 'otp',
      recipient: '+15551234567',
      payload: { tenantId: 'tenant-1', code: '123456', expiresInMin: 5 },
    })
    const env = makeEnv({
      WHATSAPP_PROVIDER: 'twilio',
      TWILIO_ACCOUNT_SID: 'AC123',
      TWILIO_AUTH_TOKEN: 'token',
      TWILIO_MESSAGING_SERVICE_SID: 'MG123',
    })

    await handleWhatsappBatch(makeBatch(message), env)

    const twilioCall = vi.mocked(fetch).mock.calls[0]
    if (twilioCall === undefined) throw new Error('missing twilio fetch call')
    const body = (twilioCall[1] as { body: URLSearchParams }).body
    expect(body.get('To')).toBe('whatsapp:+15551234567')
    expect(body.get('MessagingServiceSid')).toBe('MG123')
    expect(body.has('From')).toBe(false)
    expect(message.ack).toHaveBeenCalledOnce()
    expect(message.retry).not.toHaveBeenCalled()
  })

  it('Meta provider 发送 Cloud API text message 并 ack', async () => {
    const message = makeMessage({
      type: 'otp',
      recipient: '+15551234567',
      payload: { tenantId: 'tenant-1', code: '123456', expiresInMin: 5 },
    })
    const auditSend = vi.fn().mockResolvedValue(undefined)
    const env = makeEnv({
      WHATSAPP_PROVIDER: 'meta',
      WHATSAPP_META_PHONE_NUMBER_ID: '1234567890',
      WHATSAPP_META_ACCESS_TOKEN: 'meta-token',
      AUDIT_QUEUE: { send: auditSend },
    })

    await handleWhatsappBatch(makeBatch(message), env)

    expect(fetch).toHaveBeenCalledWith(
      'https://graph.facebook.com/v25.0/1234567890/messages',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          authorization: 'Bearer meta-token',
          'content-type': 'application/json',
        }),
      }),
    )
    const metaCall = vi.mocked(fetch).mock.calls[0]
    if (metaCall === undefined) throw new Error('missing meta fetch call')
    const body = JSON.parse(String((metaCall[1] as { body: string }).body))
    expect(body).toMatchObject({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '+15551234567',
      type: 'text',
      text: {
        preview_url: false,
        body: 'Your XID verification code is 123456. It expires in 5 minutes.',
      },
    })
    expect(auditSend).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        action: 'notification.sent',
        payload: expect.objectContaining({
          channel: 'whatsapp',
          type: 'otp',
          provider: 'meta',
          recipientType: 'phone',
        }),
      }),
    )
    const auditPayload = auditSend.mock.calls[0]?.[0]?.payload as Record<string, unknown>
    expect(JSON.stringify(auditPayload)).not.toContain('+15551234567')
    expect(JSON.stringify(auditPayload)).not.toContain('123456')
    expect(message.ack).toHaveBeenCalledOnce()
  })

  it('R2 WhatsApp 模板命中时优先渲染模板文本', async () => {
    const message = makeMessage({
      type: 'otp',
      recipient: '+15551234567',
      payload: { tenantId: 'tenant-1', code: '123456', expiresInMin: 5, locale: 'zh-Hans' },
    })
    const env = makeEnv({
      WHATSAPP_PROVIDER: 'meta',
      WHATSAPP_META_PHONE_NUMBER_ID: '1234567890',
      WHATSAPP_META_ACCESS_TOKEN: 'meta-token',
      STORAGE: {
        get: vi.fn().mockImplementation(async (key: string) => {
          if (key === 'phone-otp-templates/whatsapp/zh-Hans/otp.txt') {
            return {
              text: async () => 'R2 WhatsApp 验证码 {{ code }} 有效 {{ expiresInMin }} 分钟',
            }
          }
          return null
        }),
      },
    })

    await handleWhatsappBatch(makeBatch(message), env)

    const metaCall = vi.mocked(fetch).mock.calls[0]
    if (metaCall === undefined) throw new Error('missing meta fetch call')
    const body = JSON.parse(String((metaCall[1] as { body: string }).body))
    expect(body.text.body).toBe('R2 WhatsApp 验证码 123456 有效 5 分钟')
    expect(message.ack).toHaveBeenCalledOnce()
  })

  it('provider 未配置时 ack 并落 notification_failures', async () => {
    const dbRun = vi.fn().mockResolvedValue(undefined)
    let capturedRecipient = ''
    let capturedPayload = ''
    const env = makeEnv({
      DB: {
        prepare: () => ({
          bind: (...args: unknown[]) => {
            capturedRecipient = String(args[3])
            capturedPayload = String(args[5])
            return { run: dbRun }
          },
        }),
      },
    })
    const message = makeMessage({
      type: 'otp',
      recipient: '+15551234567',
      payload: { tenantId: 'tenant-1', userId: 'user-1', code: '123456', expiresInMin: 5 },
    })

    await handleWhatsappBatch(makeBatch(message), env)

    expect(message.ack).toHaveBeenCalledOnce()
    expect(message.retry).not.toHaveBeenCalled()
    expect(dbRun).toHaveBeenCalledOnce()
    expect(capturedRecipient).toMatch(/^sha256:/)
    expect(capturedRecipient).not.toContain('+15551234567')
    expect(capturedPayload).not.toContain('+15551234567')
    expect(capturedPayload).not.toContain('123456')
    expect(capturedPayload).not.toContain('Code')
    expect(capturedPayload).toContain('"recipientType":"phone"')
    expect(capturedPayload).toContain('"recipientHash"')
  })

  it('provider 错误未达上限时 retry', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 502 })))
    const dbRun = vi.fn()
    const env = makeEnv({
      WHATSAPP_PROVIDER: 'meta',
      WHATSAPP_META_PHONE_NUMBER_ID: '1234567890',
      WHATSAPP_META_ACCESS_TOKEN: 'meta-token',
      DB: { prepare: () => ({ bind: () => ({ run: dbRun }) }) },
    })
    const message = makeMessage({
      type: 'otp',
      recipient: '+15551234567',
      payload: { tenantId: 'tenant-1', code: '123456', expiresInMin: 5 },
    })

    await handleWhatsappBatch(makeBatch(message), env)

    expect(message.retry).toHaveBeenCalledOnce()
    expect(message.ack).not.toHaveBeenCalled()
    expect(dbRun).not.toHaveBeenCalled()
  })

  it('死信落库失败时 retry,不 ack', async () => {
    const env = makeEnv({
      DB: {
        prepare: () => ({
          bind: () => ({ run: vi.fn().mockRejectedValue(new Error('d1 failed')) }),
        }),
      },
    })
    const message = makeMessage(
      {
        type: 'otp',
        recipient: '+15551234567',
        payload: { tenantId: 'tenant-1', code: '123456', expiresInMin: 5 },
      },
      1,
      'whatsapp-dead-letter-write-failure',
    )

    await handleWhatsappBatch(makeBatch(message), env)

    expect(message.retry).toHaveBeenCalledOnce()
    expect(message.ack).not.toHaveBeenCalled()
  })

  it('production 环境拒绝 test provider 并记录失败', async () => {
    const dbRun = vi.fn().mockResolvedValue(undefined)
    const env = makeEnv({
      WHATSAPP_PROVIDER: 'test',
      ENVIRONMENT: 'production',
      DB: { prepare: () => ({ bind: () => ({ run: dbRun }) }) },
    })
    const message = makeMessage({
      type: 'otp',
      recipient: '+15551234567',
      payload: { tenantId: 'tenant-1', code: '123456', expiresInMin: 5, provider: 'test' },
    })

    await handleWhatsappBatch(makeBatch(message), env)

    expect(message.ack).toHaveBeenCalledOnce()
    expect(dbRun).toHaveBeenCalledOnce()
  })
})
