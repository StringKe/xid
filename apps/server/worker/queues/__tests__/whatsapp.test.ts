// WhatsApp Consumer 测试:Twilio Content 模板与 Meta authentication 模板请求、失败重试和 notification_failures。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WhatsappQueueMessage } from '@xid-kit/types'
import { handleWhatsappBatch } from '../whatsapp'

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

const TWILIO_ENV = {
  WHATSAPP_PROVIDER: 'twilio',
  TWILIO_ACCOUNT_SID: 'AC123',
  TWILIO_AUTH_TOKEN: 'token',
  TWILIO_WHATSAPP_CONTENT_SID: 'HX0123456789abcdef0123456789abcdef',
}

const META_ENV = {
  WHATSAPP_PROVIDER: 'meta',
  WHATSAPP_META_PHONE_NUMBER_ID: '1234567890',
  WHATSAPP_META_ACCESS_TOKEN: 'meta-token',
  WHATSAPP_TEMPLATE_NAME: 'xid_otp',
  WHATSAPP_TEMPLATE_LANGUAGE: 'en_US',
}

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

function otpMessage(payload: Record<string, unknown> = {}) {
  return makeMessage({
    type: 'otp',
    recipient: '+15551234567',
    payload: {
      tenantId: 'tenant-1',
      userId: 'user-1',
      code: '123456',
      expiresInMin: 5,
      ...payload,
    },
  })
}

function makeBatch(message: ReturnType<typeof makeMessage>): MessageBatch<WhatsappQueueMessage> {
  return { messages: [message] } as unknown as MessageBatch<WhatsappQueueMessage>
}

function twilioBody(): URLSearchParams {
  const call = vi.mocked(fetch).mock.calls[0]
  if (call === undefined) throw new Error('missing twilio fetch call')
  return (call[1] as { body: URLSearchParams }).body
}

describe('handleWhatsappBatch', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('Twilio 用 Content 模板发送验证码，不发自由文本', async () => {
    const message = otpMessage()
    const auditSend = vi.fn().mockResolvedValue(undefined)
    const env = makeEnv({
      ...TWILIO_ENV,
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
    const body = twilioBody()
    expect(body.get('To')).toBe('whatsapp:+15551234567')
    expect(body.get('From')).toBe('whatsapp:+15550000000')
    expect(body.get('ContentSid')).toBe('HX0123456789abcdef0123456789abcdef')
    expect(JSON.parse(body.get('ContentVariables') ?? '{}')).toEqual({ '1': '123456' })
    expect(body.has('Body')).toBe(false)
    const auditPayload = auditSend.mock.calls[0]?.[0]?.payload as Record<string, unknown>
    expect(auditPayload).toMatchObject({ channel: 'whatsapp', provider: 'twilio' })
    expect(JSON.stringify(auditPayload)).not.toContain('+15551234567')
    expect(JSON.stringify(auditPayload)).not.toContain('123456')
    expect(message.ack).toHaveBeenCalledOnce()
    expect(message.retry).not.toHaveBeenCalled()
  })

  it('Twilio 只配置 WhatsApp Messaging Service 时由 Sender Pool 选号', async () => {
    const message = otpMessage()
    const env = makeEnv({ ...TWILIO_ENV, TWILIO_WHATSAPP_MESSAGING_SERVICE_SID: 'MGwhatsapp' })

    await handleWhatsappBatch(makeBatch(message), env)

    const body = twilioBody()
    expect(body.get('MessagingServiceSid')).toBe('MGwhatsapp')
    expect(body.has('From')).toBe(false)
    expect(message.ack).toHaveBeenCalledOnce()
  })

  it('Twilio 配置 Messaging Service 时仍使用租户配置的 from', async () => {
    const message = otpMessage({ from: '+15557654321' })
    const env = makeEnv({ ...TWILIO_ENV, TWILIO_WHATSAPP_MESSAGING_SERVICE_SID: 'MGwhatsapp' })

    await handleWhatsappBatch(makeBatch(message), env)

    const body = twilioBody()
    expect(body.get('From')).toBe('whatsapp:+15557654321')
    expect(body.get('MessagingServiceSid')).toBe('MGwhatsapp')
  })

  it('Twilio WhatsApp 不使用 SMS 的 Messaging Service', async () => {
    const message = otpMessage()
    const env = makeEnv({ ...TWILIO_ENV, TWILIO_MESSAGING_SERVICE_SID: 'MGsms' })

    await handleWhatsappBatch(makeBatch(message), env)

    expect(fetch).not.toHaveBeenCalled()
  })

  it('Twilio 缺少 Content SID 时不调用 provider 并记录失败', async () => {
    const dbRun = vi.fn().mockResolvedValue(undefined)
    const message = otpMessage()
    const env = makeEnv({
      ...TWILIO_ENV,
      TWILIO_WHATSAPP_CONTENT_SID: undefined,
      WHATSAPP_FROM: '+15550000000',
      DB: { prepare: () => ({ bind: () => ({ run: dbRun }) }) },
    })

    await handleWhatsappBatch(makeBatch(message), env)

    expect(fetch).not.toHaveBeenCalled()
    expect(dbRun).toHaveBeenCalledOnce()
    expect(message.ack).toHaveBeenCalledOnce()
  })

  it('Meta 用 authentication 模板发送，验证码同时填 body 和 copy code 按钮', async () => {
    const message = otpMessage()
    const env = makeEnv(META_ENV)

    await handleWhatsappBatch(makeBatch(message), env)

    expect(fetch).toHaveBeenCalledWith(
      'https://graph.facebook.com/v25.0/1234567890/messages',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Bearer meta-token' }),
      }),
    )
    const call = vi.mocked(fetch).mock.calls[0]
    if (call === undefined) throw new Error('missing meta fetch call')
    const body = JSON.parse(String((call[1] as { body: string }).body))
    expect(body).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '+15551234567',
      type: 'template',
      template: {
        name: 'xid_otp',
        language: { code: 'en_US' },
        components: [
          { type: 'body', parameters: [{ type: 'text', text: '123456' }] },
          {
            type: 'button',
            sub_type: 'url',
            index: '0',
            parameters: [{ type: 'text', text: '123456' }],
          },
        ],
      },
    })
    expect(message.ack).toHaveBeenCalledOnce()
  })

  it('Meta 缺少模板配置时不调用 provider 并记录失败', async () => {
    const dbRun = vi.fn().mockResolvedValue(undefined)
    const message = otpMessage()
    const env = makeEnv({
      ...META_ENV,
      WHATSAPP_TEMPLATE_NAME: undefined,
      DB: { prepare: () => ({ bind: () => ({ run: dbRun }) }) },
    })

    await handleWhatsappBatch(makeBatch(message), env)

    expect(fetch).not.toHaveBeenCalled()
    expect(dbRun).toHaveBeenCalledOnce()
    expect(message.ack).toHaveBeenCalledOnce()
  })

  it('provider 未配置时 ack 并落脱敏的 notification_failures', async () => {
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
    const message = otpMessage()

    await handleWhatsappBatch(makeBatch(message), env)

    expect(message.ack).toHaveBeenCalledOnce()
    expect(message.retry).not.toHaveBeenCalled()
    expect(dbRun).toHaveBeenCalledOnce()
    expect(capturedRecipient).toMatch(/^sha256:/)
    expect(capturedPayload).not.toContain('+15551234567')
    expect(capturedPayload).not.toContain('123456')
    expect(capturedPayload).toContain('"recipientType":"phone"')
  })

  it('provider 错误交给投递状态机后 retry', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 502 })))
    const dbRun = vi.fn()
    const env = makeEnv({ ...META_ENV, DB: { prepare: () => ({ bind: () => ({ run: dbRun }) }) } })
    const message = otpMessage()

    await handleWhatsappBatch(makeBatch(message), env)

    expect(message.retry).toHaveBeenCalledOnce()
    expect(message.ack).not.toHaveBeenCalled()
    expect(dbRun).not.toHaveBeenCalled()
  })

  it('provider 请求带超时信号', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new DOMException('The operation timed out.', 'TimeoutError'))
    vi.stubGlobal('fetch', fetchMock)
    const message = otpMessage()

    await handleWhatsappBatch(makeBatch(message), makeEnv(META_ENV))

    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
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
    const message = otpMessage()

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
    const message = otpMessage({ provider: 'test' })

    await handleWhatsappBatch(makeBatch(message), env)

    expect(message.ack).toHaveBeenCalledOnce()
    expect(dbRun).toHaveBeenCalledOnce()
  })
})
