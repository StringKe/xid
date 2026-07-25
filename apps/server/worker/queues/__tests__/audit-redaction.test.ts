import { describe, expect, it, vi } from 'vitest'
import type { AuditQueueMessage } from '@xid-kit/types'
import { redactAuditPayload } from '../audit-redaction'
import { handleAuditBatch, type AuditAppendInput } from '../audit'

type FakeMessage = {
  id: string
  attempts: number
  body: AuditQueueMessage
  ack: ReturnType<typeof vi.fn>
  retry: ReturnType<typeof vi.fn>
}

function makeMessage(payload: Record<string, unknown>): FakeMessage {
  return {
    id: 'msg_redact',
    attempts: 0,
    body: {
      tenantId: 'tenant_1',
      action: 'auth.sensitive',
      actorId: 'user_1',
      ts: 1_736_934_600_123,
      payload,
    },
    ack: vi.fn(),
    retry: vi.fn(),
  }
}

function makeCaptureEnv(captured: AuditAppendInput[]): Env {
  return {
    AUDIT_SEQ: {
      idFromName: (name: string) => name,
      get: () => ({
        append: (input: AuditAppendInput) => {
          captured.push(input)
          return Promise.resolve({ status: 'appended' })
        },
      }),
    },
  } as unknown as Env
}

describe('redactAuditPayload', () => {
  it('redacts direct PII and secret-bearing fields while retaining hashed evidence', () => {
    const payload = redactAuditPayload({
      email: 'user@example.com',
      phoneNumber: '+15551234567',
      token: 'secret-token',
      password: 'CorrectHorse12',
      resetLink: 'https://xid.dev/reset-password?token=secret',
      recipientHash: 'sha256:abc',
      tokenHash: 'hash-ok',
      statusCode: 200,
      provider: 'cloudflare',
    })

    expect(payload).toEqual({
      email: '[redacted]',
      phoneNumber: '[redacted]',
      token: '[redacted]',
      password: '[redacted]',
      resetLink: '[redacted]',
      recipientHash: 'sha256:abc',
      tokenHash: 'hash-ok',
      statusCode: 200,
      provider: 'cloudflare',
    })
  })

  it('redacts nested objects and arrays without removing non-secret operational metadata', () => {
    const payload = redactAuditPayload({
      provider: 'github',
      profile: { email: 'user@example.com', idpUserId: 'idp_1' },
      attempts: [{ code: '123456', errorCode: 'invalid_credentials' }],
    })

    expect(payload).toEqual({
      provider: 'github',
      profile: { email: '[redacted]', idpUserId: 'idp_1' },
      attempts: [{ code: '[redacted]', errorCode: 'invalid_credentials' }],
    })
  })
})

describe('handleAuditBatch audit redaction', () => {
  it('writes redacted meta before hash-chain input is computed', async () => {
    const captured: AuditAppendInput[] = []
    const env = makeCaptureEnv(captured)
    const message = makeMessage({
      actorIp: '203.0.113.10',
      targetType: 'user',
      targetId: 'user_1',
      email: 'user@example.com',
      token: 'secret-token',
      provider: 'github',
    })

    await handleAuditBatch(
      { messages: [message] } as unknown as MessageBatch<AuditQueueMessage>,
      env,
    )

    expect(message.ack).toHaveBeenCalledOnce()
    expect(captured).toHaveLength(1)
    const meta = captured[0]?.fields.meta

    expect(meta).toEqual({ email: '[redacted]', provider: 'github', token: '[redacted]' })
    expect(JSON.stringify(meta)).not.toContain('user@example.com')
    expect(JSON.stringify(meta)).not.toContain('secret-token')
  })
})
