// notification-audit 单元测试:notification.sent 审计脱敏与 no-tenant 跳过。
import { describe, expect, it, vi } from 'vitest'
import type { AuditQueueMessage } from '@xid-kit/types'
import { recordNotificationSent } from '../notification-audit'

describe('recordNotificationSent', () => {
  it('skips audit when tenantId missing from payload', async () => {
    const auditSend = vi.fn()
    const env = { AUDIT_QUEUE: { send: auditSend } } as unknown as Env
    await recordNotificationSent(env, {
      messageId: 'queue-email-1',
      channel: 'email',
      type: 'verify_email',
      recipient: 'user@example.com',
      provider: 'cloudflare',
      payload: {},
    })
    expect(auditSend).not.toHaveBeenCalled()
  })

  it('queues hashed recipient audit event for email channel', async () => {
    const auditSend = vi.fn().mockResolvedValue(undefined)
    const env = { AUDIT_QUEUE: { send: auditSend } } as unknown as Env
    await recordNotificationSent(env, {
      messageId: 'queue-email-2',
      channel: 'email',
      type: 'magic_link',
      recipient: ' User@Acme.COM ',
      provider: 'cloudflare',
      payload: { tenantId: 'tenant_1', userId: 'user_1', orgId: 'org_1' },
    })
    expect(auditSend).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant_1',
        orgId: 'org_1',
        action: 'notification.sent',
        actorId: 'user_1',
        payload: expect.objectContaining({
          sourceMessageId: 'notification:email:queue-email-2',
          channel: 'email',
          provider: 'cloudflare',
          recipientType: 'email',
          emailDomain: 'acme.com',
          recipientHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      }),
    )
    const serialized = JSON.stringify(auditSend.mock.calls[0]?.[0])
    expect(serialized).not.toContain('user@acme.com')
  })

  it('同一 delivery identity 的审计消息使用稳定 sourceMessageId', async () => {
    const auditSend = vi.fn().mockResolvedValue(undefined)
    const env = { AUDIT_QUEUE: { send: auditSend } } as unknown as Env
    const input = {
      messageId: 'queue-shared',
      channel: 'sms' as const,
      type: 'otp',
      recipient: '+15551234567',
      provider: 'twilio',
      payload: { tenantId: 'tenant_1' },
    }

    await recordNotificationSent(env, input)
    await recordNotificationSent(env, input)

    expect(
      auditSend.mock.calls.map(
        ([message]) => (message as AuditQueueMessage).payload.sourceMessageId,
      ),
    ).toEqual(['notification:sms:queue-shared', 'notification:sms:queue-shared'])
  })
})
