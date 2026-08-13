import { describe, expect, it, vi } from 'vitest'
import {
  consumeVerifiableOtp,
  persistAndSendOtp,
  recordOtpFailure,
  replaceActiveOtpToken,
} from '../otp'

function makeDb() {
  return {
    verificationTokens: {
      hardDelete: vi.fn().mockResolvedValue(undefined),
      insert: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue([]),
    },
  }
}

function makeContext(locale = 'zh-Hans') {
  const emailSend = vi.fn().mockResolvedValue(undefined)
  const whatsappSend = vi.fn().mockResolvedValue(undefined)
  const smsSend = vi.fn().mockResolvedValue(undefined)
  return {
    c: {
      env: {
        EMAIL_QUEUE: { send: emailSend },
        WHATSAPP_QUEUE: { send: whatsappSend },
        SMS_QUEUE: { send: smsSend },
      },
      get: vi.fn((key: string) => {
        if (key === 'locale') return locale
        if (key === 'tenant') {
          return {
            policy: {
              deliveryChannels: {
                whatsapp: { provider: 'meta', enabled: true, secretRefs: [], from: undefined },
                sms: { provider: 'twilio', enabled: true, secretRefs: [], from: undefined },
              },
            },
          }
        }
        return undefined
      }),
    },
    emailSend,
    whatsappSend,
    smsSend,
  }
}

describe('persistAndSendOtp', () => {
  it('persists the server-resolved flow with the credential', async () => {
    const db = makeDb()
    const ctx = makeContext('en')

    await persistAndSendOtp({
      c: ctx.c as never,
      db: db as never,
      tenantId: 'tenant-1',
      channel: 'email',
      target: 'user@example.com',
      userId: 'user-1',
      flowContext: {
        version: 1,
        intent: 'sign-up',
        continuePath: '/create-organization',
        applicationClientId: null,
        invitationId: null,
      },
    })

    expect(db.verificationTokens.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        flowContext: JSON.stringify({
          version: 1,
          intent: 'sign-up',
          continuePath: '/create-organization',
          applicationClientId: null,
          invitationId: null,
        }),
      }),
    )
  })

  it('WhatsApp OTP 入队结构化 payload,不预渲染英文正文', async () => {
    const db = makeDb()
    const ctx = makeContext('zh-Hans')

    await persistAndSendOtp({
      c: ctx.c as never,
      db: db as never,
      tenantId: 'tenant-1',
      channel: 'whatsapp',
      target: '+15551234567',
      userId: 'user-1',
    })

    expect(ctx.whatsappSend).toHaveBeenCalledOnce()
    const message = ctx.whatsappSend.mock.calls[0]?.[0] as Record<string, unknown>
    expect(message).toMatchObject({
      type: 'otp',
      recipient: '+15551234567',
      payload: {
        tenantId: 'tenant-1',
        userId: 'user-1',
        expiresInMin: 5,
        locale: 'zh-Hans',
      },
    })
    const payload = message.payload as Record<string, unknown>
    expect(typeof payload.code).toBe('string')
    expect(payload.text).toBeUndefined()
    expect(JSON.stringify(message)).not.toContain('Your XID verification code')
  })

  it('SMS OTP 入队结构化 payload,不预渲染英文正文', async () => {
    const db = makeDb()
    const ctx = makeContext('en')

    await persistAndSendOtp({
      c: ctx.c as never,
      db: db as never,
      tenantId: 'tenant-1',
      channel: 'sms',
      target: '+15551234567',
      userId: 'user-1',
    })

    expect(ctx.smsSend).toHaveBeenCalledOnce()
    const message = ctx.smsSend.mock.calls[0]?.[0] as Record<string, unknown>
    expect(message).toMatchObject({
      type: 'otp',
      recipient: '+15551234567',
      payload: {
        tenantId: 'tenant-1',
        userId: 'user-1',
        expiresInMin: 5,
        locale: 'en',
      },
    })
    const payload = message.payload as Record<string, unknown>
    expect(typeof payload.code).toBe('string')
    expect(payload.text).toBeUndefined()
    expect(JSON.stringify(message)).not.toContain('Your XID verification code')
  })
})

describe('OTP concurrent state transitions', () => {
  it('only increments one failed attempt from the same stale snapshot', async () => {
    const state = { attemptCount: 0, consumed: false }
    const db = {
      verificationTokens: {
        update: vi.fn(async (values: { attemptCount?: number; consumedAt?: Date }) => {
          if (state.consumed || state.attemptCount !== 0) return []
          state.attemptCount = values.attemptCount ?? state.attemptCount
          state.consumed = values.consumedAt instanceof Date
          return [{ id: 'otp-1' }]
        }),
      },
    }
    const row = {
      tokenHash: 'otp-1',
      attemptCount: 0,
      consumedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    }

    await Promise.allSettled([
      recordOtpFailure(db as never, row as never),
      recordOtpFailure(db as never, row as never),
    ])

    expect(state.attemptCount).toBe(1)
    expect(db.verificationTokens.update).toHaveBeenCalledTimes(2)
  })

  it('allows only one concurrent OTP consumption', async () => {
    const state = { consumed: false }
    const db = {
      verificationTokens: {
        update: vi.fn(async () => {
          if (state.consumed) return []
          state.consumed = true
          return [{ id: 'otp-1' }]
        }),
      },
    }
    const row = { tokenHash: 'otp-1' }

    const outcomes = await Promise.all([
      consumeVerifiableOtp(db as never, row as never),
      consumeVerifiableOtp(db as never, row as never),
    ])

    expect(outcomes.filter(Boolean)).toHaveLength(1)
  })

  it('leaves one active OTP after concurrent resend replacement', async () => {
    let activeTokenHash: string | null = 'old'
    const db = {
      verificationTokens: {
        update: vi.fn(async () => {
          activeTokenHash = null
          return []
        }),
        insert: vi.fn(async (values: { tokenHash: string }) => {
          if (activeTokenHash !== null) throw new Error('UNIQUE constraint failed')
          activeTokenHash = values.tokenHash
          return { id: values.tokenHash }
        }),
      },
    }

    await Promise.all([
      replaceActiveOtpToken({
        db: db as never,
        channel: 'email',
        purpose: 'otp',
        values: {
          id: 'otp-a',
          tenantId: 'tenant-1',
          userId: 'user-1',
          tokenHash: 'otp-a',
          codeHash: 'code-a',
          channel: 'email',
          purpose: 'otp',
          expiresAt: new Date(Date.now() + 60_000),
        },
      }),
      replaceActiveOtpToken({
        db: db as never,
        channel: 'email',
        purpose: 'otp',
        values: {
          id: 'otp-b',
          tenantId: 'tenant-1',
          userId: 'user-1',
          tokenHash: 'otp-b',
          codeHash: 'code-b',
          channel: 'email',
          purpose: 'otp',
          expiresAt: new Date(Date.now() + 60_000),
        },
      }),
    ])

    expect(activeTokenHash).toMatch(/otp-[ab]/)
  })
})
