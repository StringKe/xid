// SMS Consumer 测试:provider readiness、provider 请求、失败重试和 notification_failures。

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { SmsQueueMessage } from '@xid-kit/types'
import { handleSmsBatch } from '../sms'

vi.mock('../notification-delivery-state', () => ({
  DELIVERY_RETRY_SECONDS: 15,
  deliveryRetryDelaySeconds: () => 15,
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

function makeMessage(body: SmsQueueMessage, attempts = 1, id = 'sms-message') {
  return {
    id,
    body,
    attempts,
    ack: vi.fn(),
    retry: vi.fn(),
  }
}

function makeBatch(message: ReturnType<typeof makeMessage>): MessageBatch<SmsQueueMessage> {
  return { messages: [message] } as unknown as MessageBatch<SmsQueueMessage>
}

describe('handleSmsBatch', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('Twilio provider 发送 form encoded message 并 ack', async () => {
    const message = makeMessage({
      type: 'otp',
      recipient: '+15551234567',
      payload: { tenantId: 'tenant-1', userId: 'user-1', code: '123456', expiresInMin: 5 },
    })
    const auditSend = vi.fn().mockResolvedValue(undefined)
    const env = makeEnv({
      SMS_PROVIDER: 'twilio',
      TWILIO_ACCOUNT_SID: 'AC123',
      TWILIO_AUTH_TOKEN: 'token',
      SMS_FROM: '+15550000000',
      AUDIT_QUEUE: { send: auditSend },
    })

    await handleSmsBatch(makeBatch(message), env)

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
    const request = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as RequestInit
    const body = request.body as URLSearchParams
    expect(body.get('Body')).toBe('Your XID verification code is 123456. It expires in 5 minutes.')
    expect(auditSend).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        actorId: 'user-1',
        action: 'notification.sent',
        payload: expect.objectContaining({
          channel: 'sms',
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

  it('Vonage provider 发送 JSON message 并 ack', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ messages: [{ status: '0' }] }), { status: 200 }),
        ),
    )
    const message = makeMessage({
      type: 'otp',
      recipient: '+15551234567',
      payload: { tenantId: 'tenant-1', code: '123456', expiresInMin: 5 },
    })
    const auditSend = vi.fn().mockResolvedValue(undefined)
    const env = makeEnv({
      SMS_PROVIDER: 'vonage',
      VONAGE_API_KEY: 'key',
      VONAGE_API_SECRET: 'secret',
      SMS_FROM: 'XID',
      AUDIT_QUEUE: { send: auditSend },
    })

    await handleSmsBatch(makeBatch(message), env)

    expect(fetch).toHaveBeenCalledWith(
      'https://rest.nexmo.com/sms/json',
      expect.objectContaining({ method: 'POST', headers: { 'content-type': 'application/json' } }),
    )
    const request = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as RequestInit
    expect(String(request.body)).toContain(
      '"text":"Your XID verification code is 123456. It expires in 5 minutes."',
    )
    expect(auditSend).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        action: 'notification.sent',
        payload: expect.objectContaining({
          channel: 'sms',
          type: 'otp',
          provider: 'vonage',
          recipientType: 'phone',
        }),
      }),
    )
    const auditPayload = auditSend.mock.calls[0]?.[0]?.payload as Record<string, unknown>
    expect(JSON.stringify(auditPayload)).not.toContain('+15551234567')
    expect(JSON.stringify(auditPayload)).not.toContain('123456')
    expect(message.ack).toHaveBeenCalledOnce()
  })

  it('Infobip provider 按 v3 字段发送 JSON message 并 ack', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          messages: [{ messageId: 'm1', status: { groupId: 1, groupName: 'PENDING' } }],
        }),
      ),
    )
    const message = makeMessage({
      type: 'otp',
      recipient: '+15551234567',
      payload: { tenantId: 'tenant-1', code: '123456', expiresInMin: 5 },
    })
    const auditSend = vi.fn().mockResolvedValue(undefined)
    const env = makeEnv({
      SMS_PROVIDER: 'infobip',
      INFOBIP_API_KEY: 'key',
      INFOBIP_BASE_URL: 'https://example.api.infobip.com/',
      SMS_FROM: 'XID',
      AUDIT_QUEUE: { send: auditSend },
    })

    await handleSmsBatch(makeBatch(message), env)

    expect(fetch).toHaveBeenCalledWith(
      'https://example.api.infobip.com/sms/3/messages',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          authorization: 'App key',
          'content-type': 'application/json',
        }),
      }),
    )
    const request = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as RequestInit
    expect(JSON.parse(String(request.body))).toEqual({
      messages: [
        {
          sender: 'XID',
          destinations: [{ to: '+15551234567' }],
          content: { text: 'Your XID verification code is 123456. It expires in 5 minutes.' },
        },
      ],
    })
    expect(auditSend).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        action: 'notification.sent',
        payload: expect.objectContaining({
          channel: 'sms',
          type: 'otp',
          provider: 'infobip',
          recipientType: 'phone',
        }),
      }),
    )
    const auditPayload = auditSend.mock.calls[0]?.[0]?.payload as Record<string, unknown>
    expect(JSON.stringify(auditPayload)).not.toContain('+15551234567')
    expect(JSON.stringify(auditPayload)).not.toContain('123456')
    expect(message.ack).toHaveBeenCalledOnce()
  })

  it('Bird provider 经 Channels API 发送 JSON message 并 ack', async () => {
    const message = makeMessage({
      type: 'otp',
      recipient: '+15551234567',
      payload: { tenantId: 'tenant-1', code: '123456', expiresInMin: 5 },
    })
    const auditSend = vi.fn().mockResolvedValue(undefined)
    const env = makeEnv({
      SMS_PROVIDER: 'messagebird',
      MESSAGEBIRD_ACCESS_KEY: 'key',
      BIRD_WORKSPACE_ID: 'ws-1',
      BIRD_CHANNEL_ID: 'ch-1',
      AUDIT_QUEUE: { send: auditSend },
    })

    await handleSmsBatch(makeBatch(message), env)

    expect(fetch).toHaveBeenCalledWith(
      'https://api.bird.com/workspaces/ws-1/channels/ch-1/messages',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          authorization: 'AccessKey key',
          'content-type': 'application/json',
        }),
      }),
    )
    const request = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as RequestInit
    expect(JSON.parse(String(request.body))).toEqual({
      receiver: { contacts: [{ identifierValue: '+15551234567' }] },
      body: {
        type: 'text',
        text: { text: 'Your XID verification code is 123456. It expires in 5 minutes.' },
      },
    })
    expect(auditSend).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        action: 'notification.sent',
        payload: expect.objectContaining({
          channel: 'sms',
          type: 'otp',
          provider: 'messagebird',
          recipientType: 'phone',
        }),
      }),
    )
    const auditPayload = auditSend.mock.calls[0]?.[0]?.payload as Record<string, unknown>
    expect(JSON.stringify(auditPayload)).not.toContain('+15551234567')
    expect(JSON.stringify(auditPayload)).not.toContain('123456')
    expect(message.ack).toHaveBeenCalledOnce()
  })

  it('R2 SMS 模板命中时优先渲染模板文本', async () => {
    const message = makeMessage({
      type: 'otp',
      recipient: '+15551234567',
      payload: { tenantId: 'tenant-1', code: '123456', expiresInMin: 5, locale: 'zh-Hans' },
    })
    const env = makeEnv({
      SMS_PROVIDER: 'twilio',
      TWILIO_ACCOUNT_SID: 'AC123',
      TWILIO_AUTH_TOKEN: 'token',
      SMS_FROM: '+15550000000',
      STORAGE: {
        get: vi.fn().mockImplementation(async (key: string) => {
          if (key === 'phone-otp-templates/sms/zh-Hans/otp.txt') {
            return { text: async () => 'R2 验证码 {{ code }} 有效 {{ expiresInMin }} 分钟' }
          }
          return null
        }),
      },
    })

    await handleSmsBatch(makeBatch(message), env)

    const request = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as RequestInit
    const body = request.body as URLSearchParams
    expect(body.get('Body')).toBe('R2 验证码 123456 有效 5 分钟')
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

    await handleSmsBatch(makeBatch(message), env)

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
      SMS_PROVIDER: 'twilio',
      TWILIO_ACCOUNT_SID: 'AC123',
      TWILIO_AUTH_TOKEN: 'token',
      SMS_FROM: '+15550000000',
      DB: { prepare: () => ({ bind: () => ({ run: dbRun }) }) },
    })
    const message = makeMessage({
      type: 'otp',
      recipient: '+15551234567',
      payload: { tenantId: 'tenant-1', code: '123456', expiresInMin: 5 },
    })

    await handleSmsBatch(makeBatch(message), env)

    expect(message.retry).toHaveBeenCalledOnce()
    expect(message.ack).not.toHaveBeenCalled()
    expect(dbRun).not.toHaveBeenCalled()
  })

  it('provider 请求带超时信号,超时后 retry 不 ack', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new DOMException('The operation timed out.', 'TimeoutError'))
    vi.stubGlobal('fetch', fetchMock)
    const env = makeEnv({
      SMS_PROVIDER: 'twilio',
      TWILIO_ACCOUNT_SID: 'AC123',
      TWILIO_AUTH_TOKEN: 'token',
      SMS_FROM: '+15550000000',
    })
    const message = makeMessage({
      type: 'otp',
      recipient: '+15551234567',
      payload: { tenantId: 'tenant-1', code: '123456', expiresInMin: 5 },
    })

    await handleSmsBatch(makeBatch(message), env)

    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
    expect(message.retry).toHaveBeenCalledOnce()
    expect(message.ack).not.toHaveBeenCalled()
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
      'sms-dead-letter-write-failure',
    )

    await handleSmsBatch(makeBatch(message), env)

    expect(message.retry).toHaveBeenCalledOnce()
    expect(message.ack).not.toHaveBeenCalled()
  })

  it('production 环境拒绝 test provider 并记录失败', async () => {
    const dbRun = vi.fn().mockResolvedValue(undefined)
    const env = makeEnv({
      SMS_PROVIDER: 'test',
      ENVIRONMENT: 'production',
      DB: { prepare: () => ({ bind: () => ({ run: dbRun }) }) },
    })
    const message = makeMessage({
      type: 'otp',
      recipient: '+15551234567',
      payload: { tenantId: 'tenant-1', code: '123456', expiresInMin: 5, provider: 'test' },
    })

    await handleSmsBatch(makeBatch(message), env)

    expect(message.ack).toHaveBeenCalledOnce()
    expect(dbRun).toHaveBeenCalledOnce()
  })
})
