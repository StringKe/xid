// Email Consumer 测试:永久失败(模板缺失)与可重试失败(provider 错误)路径。
// 覆盖:recordFailure 失败不静默吞、attempts 语义一致、永久/可重试路径区分。

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderEmail, handleEmailBatch, renderEmailWithTemplates } from '../email'
import type { EmailQueueMessage } from '@xid-kit/types'

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

// renderEmail 单元测试(无 env 依赖)。
describe('renderEmail:模板渲染', () => {
  it('已知 type + locale 返回 EmailSendInput', () => {
    const msg: EmailQueueMessage = {
      type: 'verify_email',
      recipient: 'u@example.com',
      payload: { name: 'Alice', link: 'https://xid.dev/verify?t=xxx', locale: 'en' },
    }
    const result = renderEmail(msg)
    expect(result).not.toBeUndefined()
    expect(result?.to).toBe('u@example.com')
    expect(result?.subject).toBe('Verify your email')
    expect(result?.html).toContain('Alice')
    expect(result?.html).toContain('<!doctype html>')
    expect(result?.html).toContain('Identity platform')
    expect(result?.html).toContain('Verify email')
    expect(result?.html).toContain('Button not working?')
    expect(result?.text).toContain('https://xid.dev/verify?t=xxx')
  })

  it('magic link 模板使用 payload.link 渲染可点击链接', () => {
    const msg: EmailQueueMessage = {
      type: 'magic_link',
      recipient: 'u@example.com',
      payload: { link: 'https://xid.dev/auth/magic-link/verify?token=abc', expires: 15 },
    }
    const result = renderEmail(msg)
    expect(result?.text).toContain('https://xid.dev/auth/magic-link/verify?token=abc')
    expect(result?.text).toContain('This link expires in 15 minutes.')
    expect(result?.html).toContain('https://xid.dev/auth/magic-link/verify?token=abc')
    expect(result?.html).toContain('This link expires in 15 minutes.')
    expect(result?.html).toContain('Sign in')
  })

  it('otp 模板渲染验证码块和纯文本验证码', () => {
    const msg: EmailQueueMessage = {
      type: 'otp',
      recipient: 'u@example.com',
      payload: { code: '123456', expiresInMin: 10, locale: 'en' },
    }
    const result = renderEmail(msg)
    expect(result?.html).toContain('letter-spacing:6px')
    expect(result?.html).toContain('123456')
    expect(result?.html).toContain('This code expires in 10 minutes.')
    expect(result?.text).toContain('Your XID verification code is 123456.')
    expect(result?.text).toContain('This code expires in 10 minutes.')
  })

  it('password reset 模板包含 CTA、备用链接和过期提示', () => {
    const msg: EmailQueueMessage = {
      type: 'password_reset',
      recipient: 'u@example.com',
      payload: { link: 'https://xid.dev/reset-password?token=abc', expiresInMin: 15 },
    }
    const result = renderEmail(msg)
    expect(result?.html).toContain('Reset password')
    expect(result?.html).toContain('https://xid.dev/reset-password?token=abc')
    expect(result?.html).toContain('Button not working? Paste this link into your browser:')
    expect(result?.text).toContain('https://xid.dev/reset-password?token=abc')
    expect(result?.text).toContain('This link expires in 15 minutes.')
  })

  it('zh-Hans 内置模板渲染中文结构化邮件', () => {
    const msg: EmailQueueMessage = {
      type: 'verify_email',
      recipient: 'u@example.com',
      payload: { name: '阿达', link: 'https://xid.dev/verify?t=xxx', locale: 'zh-Hans' },
    }
    const result = renderEmail(msg)
    expect(result?.subject).toBe('验证你的邮箱')
    expect(result?.html).toContain('确认你的邮箱地址')
    expect(result?.html).toContain('验证邮箱')
    expect(result?.html).toContain('按钮无法打开时，请复制此链接到浏览器：')
    expect(result?.text).toContain('请确认这个 XID 账号的邮箱地址')
  })

  it('email_verification 不是有效模板类型', () => {
    const msg: EmailQueueMessage = {
      type: 'email_verification',
      recipient: 'u@example.com',
      payload: { link: 'https://xid.dev/verify-email?token=abc' },
    }
    expect(renderEmail(msg)).toBeUndefined()
  })

  it('未知 type 返回 undefined(永久失败)', () => {
    const msg: EmailQueueMessage = {
      type: 'no_such_template' as never,
      recipient: 'u@example.com',
      payload: {},
    }
    expect(renderEmail(msg)).toBeUndefined()
  })

  it('locale 缺失 fallback en', () => {
    const msg: EmailQueueMessage = {
      type: 'otp',
      recipient: 'u@example.com',
      payload: { code: '123456' },
    }
    const result = renderEmail(msg)
    expect(result?.subject).toBe('Your verification code')
  })
})

function makeStorage(entries: Record<string, string> = {}): R2Bucket {
  return {
    get: vi.fn((key: string) => {
      const value = entries[key]
      if (value === undefined) return Promise.resolve(null)
      return Promise.resolve({ text: () => Promise.resolve(value) })
    }),
  } as unknown as R2Bucket
}

// handleEmailBatch 集成测试(mock env.DB + provider)。
describe('handleEmailBatch:永久失败路径(模板缺失)', () => {
  let dbRun: ReturnType<typeof vi.fn>
  let fakeEnv: Env

  beforeEach(() => {
    dbRun = vi.fn().mockResolvedValue(undefined)
    fakeEnv = {
      EMAIL: {} as SendEmail,
      STORAGE: makeStorage(),
      DB: {
        prepare: () => ({
          bind: (..._args: unknown[]) => ({ run: dbRun }),
        }),
      },
    } as unknown as Env
  })

  it('模板缺失:ack 消息 + 落 notification_failures,不调 retry', async () => {
    const ack = vi.fn()
    const retry = vi.fn()
    const msg = {
      id: 'email-template-missing',
      body: {
        type: 'no_such_template',
        recipient: 'u@example.com',
        payload: {},
      } as EmailQueueMessage,
      attempts: 1,
      ack,
      retry,
    }
    const batch = { messages: [msg] } as unknown as MessageBatch<never>
    await handleEmailBatch(batch as MessageBatch<never>, fakeEnv)
    expect(ack).toHaveBeenCalledOnce()
    expect(retry).not.toHaveBeenCalled()
    expect(dbRun).toHaveBeenCalledOnce()
  })

  it('模板缺失:recordFailure 落库失败时 retry,不 ack', async () => {
    dbRun.mockRejectedValue(new Error('D1 write failed'))
    const ack = vi.fn()
    const retry = vi.fn()
    const msg = {
      id: 'email-dead-letter-write-failure',
      body: {
        type: 'no_such_template',
        recipient: 'u@example.com',
        payload: {},
      } as EmailQueueMessage,
      attempts: 1,
      ack,
      retry,
    }
    const batch = { messages: [msg] } as unknown as MessageBatch<never>
    await handleEmailBatch(batch as MessageBatch<never>, fakeEnv)
    expect(retry).toHaveBeenCalledOnce()
    expect(ack).not.toHaveBeenCalled()
  })

  it('模板缺失:传给 recordFailure 的 attempts = message.attempts(语义一致)', async () => {
    // INSERT bind 参数顺序:id(0), source_message_id(1), tenant_id(2), recipient(3), type(4), payload(5), reason(6), attempts(7), failed_at(8)。
    let capturedAttempts: number | undefined
    fakeEnv = {
      EMAIL: {} as SendEmail,
      STORAGE: makeStorage(),
      DB: {
        prepare: () => ({
          bind: (...args: unknown[]) => {
            capturedAttempts = args[7] as number
            return { run: vi.fn().mockResolvedValue(undefined) }
          },
        }),
      },
    } as unknown as Env

    const msg = {
      id: 'email-attempts',
      body: {
        type: 'no_such_template',
        recipient: 'u@example.com',
        payload: {},
      } as EmailQueueMessage,
      attempts: 3,
      ack: vi.fn(),
      retry: vi.fn(),
    }
    const batch = { messages: [msg] } as unknown as MessageBatch<never>
    await handleEmailBatch(batch as MessageBatch<never>, fakeEnv)
    expect(capturedAttempts).toBe(3)
  })

  it('模板缺失:notification_failures 不落完整邮箱或链接 token', async () => {
    let capturedRecipient = ''
    let capturedPayload = ''
    fakeEnv = {
      EMAIL: {} as SendEmail,
      STORAGE: makeStorage(),
      DB: {
        prepare: () => ({
          bind: (...args: unknown[]) => {
            capturedRecipient = String(args[3])
            capturedPayload = String(args[5])
            return { run: vi.fn().mockResolvedValue(undefined) }
          },
        }),
      },
    } as unknown as Env

    const msg = {
      id: 'email-sanitized',
      body: {
        type: 'no_such_template',
        recipient: 'u@example.com',
        payload: {
          tenantId: 'tenant-1',
          userId: 'user-1',
          link: 'https://xid.dev/auth/magic-link/verify?token=secret-token',
          token: 'secret-token',
          code: '123456',
        },
      } as EmailQueueMessage,
      attempts: 1,
      ack: vi.fn(),
      retry: vi.fn(),
    }
    const batch = { messages: [msg] } as unknown as MessageBatch<never>
    await handleEmailBatch(batch as MessageBatch<never>, fakeEnv)

    expect(capturedRecipient).toMatch(/^sha256:/)
    expect(capturedRecipient).not.toContain('u@example.com')
    expect(capturedPayload).not.toContain('u@example.com')
    expect(capturedPayload).not.toContain('https://')
    expect(capturedPayload).not.toContain('secret-token')
    expect(capturedPayload).not.toContain('123456')
    expect(capturedPayload).toContain('"recipientHash"')
    expect(capturedPayload).toContain('"emailDomain":"example.com"')
  })
})

describe('handleEmailBatch:可重试失败(provider 错误)', () => {
  it('未达上限时 retry 不落 DLQ', async () => {
    const dbRun = vi.fn()
    const ack = vi.fn()
    const retry = vi.fn()
    const fakeEnv = {
      EMAIL: {
        send: vi.fn().mockRejectedValue(new Error('provider timeout')),
      } as unknown as SendEmail,
      STORAGE: makeStorage(),
      DB: { prepare: () => ({ bind: () => ({ run: dbRun }) }) },
    } as unknown as Env

    const msg = {
      id: 'email-provider-retry',
      body: {
        type: 'verify_email',
        recipient: 'u@example.com',
        payload: { name: 'A', link: 'http://x', locale: 'en' },
      } as EmailQueueMessage,
      attempts: 2,
      ack,
      retry,
    }
    const batch = { messages: [msg] } as unknown as MessageBatch<never>
    await handleEmailBatch(batch as MessageBatch<never>, fakeEnv)
    expect(retry).toHaveBeenCalledOnce()
    expect(ack).not.toHaveBeenCalled()
    expect(dbRun).not.toHaveBeenCalled()
  })

  it('provider 失败时 retry，不确认原消息', async () => {
    const dbRun = vi.fn().mockResolvedValue(undefined)
    const ack = vi.fn()
    const retry = vi.fn()
    const fakeEnv = {
      EMAIL: {
        send: vi.fn().mockRejectedValue(new Error('provider down')),
      } as unknown as SendEmail,
      STORAGE: makeStorage(),
      DB: { prepare: () => ({ bind: () => ({ run: dbRun }) }) },
    } as unknown as Env

    const msg = {
      id: 'email-provider-max-attempts',
      body: {
        type: 'verify_email',
        recipient: 'u@example.com',
        payload: { name: 'A', link: 'http://x', locale: 'en' },
      } as EmailQueueMessage,
      attempts: 5,
      ack,
      retry,
    }
    const batch = { messages: [msg] } as unknown as MessageBatch<never>
    await handleEmailBatch(batch as MessageBatch<never>, fakeEnv)
    expect(ack).not.toHaveBeenCalled()
    expect(retry).toHaveBeenCalledOnce()
    expect(dbRun).not.toHaveBeenCalled()
  })
})

describe('renderEmailWithTemplates:R2 模板语言包', () => {
  it('R2 locale 模板命中时优先使用 R2,缺失 fallback 内置模板', async () => {
    const env = {
      STORAGE: makeStorage({
        'email-templates/zh-Hans/verify_email.json': JSON.stringify({
          subject: 'R2 验证 {{ name }}',
          html: '<p>R2 {{ link }}</p>',
          text: 'R2 {{ link }}',
        }),
      }),
    } as unknown as Env
    const msg: EmailQueueMessage = {
      type: 'verify_email',
      recipient: 'u@example.com',
      payload: { name: 'Ada', link: 'https://xid.dev/v', locale: 'zh-Hans' },
    }
    const rendered = await renderEmailWithTemplates(env, msg)
    expect(rendered?.subject).toBe('R2 验证 Ada')
    expect(rendered?.text).toBe('R2 https://xid.dev/v')
  })

  it('R2 模板不存在时 fallback 到内置 en 模板', async () => {
    const env = { STORAGE: makeStorage() } as unknown as Env
    const msg: EmailQueueMessage = {
      type: 'otp',
      recipient: 'u@example.com',
      payload: { code: '123456', locale: 'fr' },
    }
    const rendered = await renderEmailWithTemplates(env, msg)
    expect(rendered?.subject).toBe('Your verification code')
  })
})

describe('handleEmailBatch:Cloudflare Email Service provider', () => {
  it('发送结构化 html + text 邮件', async () => {
    const emailSend = vi.fn().mockResolvedValue({ messageId: 'msg_1' })
    const auditSend = vi.fn().mockResolvedValue(undefined)
    const env = {
      EMAIL: { send: emailSend } as unknown as SendEmail,
      AUDIT_QUEUE: { send: auditSend } as unknown as Queue,
      STORAGE: makeStorage(),
      DB: { prepare: () => ({ bind: () => ({ run: vi.fn() }) }) },
    } as unknown as Env
    const ack = vi.fn()
    const batch = {
      messages: [
        {
          body: {
            type: 'verify_email',
            recipient: 'u@example.com',
            payload: {
              tenantId: 'tenant-1',
              userId: 'user-1',
              name: 'Ada',
              link: 'https://xid.dev/v',
              locale: 'en',
            },
          } as EmailQueueMessage,
          attempts: 1,
          ack,
          retry: vi.fn(),
        },
      ],
    } as unknown as MessageBatch<never>
    await handleEmailBatch(batch as MessageBatch<never>, env)
    expect(emailSend).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'u@example.com',
        from: { email: 'no-reply@xid.dev', name: 'XID' },
        subject: 'Verify your email',
        html: expect.stringContaining('Ada'),
        text: expect.stringContaining('https://xid.dev/v'),
      }),
    )
    expect(auditSend).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        actorId: 'user-1',
        action: 'notification.sent',
        payload: expect.objectContaining({
          channel: 'email',
          type: 'verify_email',
          provider: 'cloudflare',
          recipientType: 'email',
          emailDomain: 'example.com',
        }),
      }),
    )
    const auditPayload = auditSend.mock.calls[0]?.[0]?.payload as Record<string, unknown>
    expect(JSON.stringify(auditPayload)).not.toContain('u@example.com')
    expect(ack).toHaveBeenCalledOnce()
  })
})
