// notification-safety 单元测试:失败通知记录脱敏 recipient,不存明文。
import { describe, expect, it } from 'vitest'
import { buildNotificationFailureRecord } from '../notification-safety'

describe('buildNotificationFailureRecord', () => {
  it('hashes email recipient and preserves safe metadata fields', async () => {
    const record = await buildNotificationFailureRecord({
      channel: 'email',
      type: 'verify_email',
      recipient: ' User@Example.COM ',
      payload: {
        tenantId: 'tenant_1',
        userId: 'user_1',
        locale: 'en',
        expiresInMin: 15,
        secret: 'must-not-leak',
      },
    })

    expect(record.tenantId).toBe('tenant_1')
    expect(record.recipient).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(record.recipient).not.toContain('user@example.com')
    expect(record.payload).toEqual(
      expect.objectContaining({
        channel: 'email',
        type: 'verify_email',
        recipientType: 'email',
        emailDomain: 'example.com',
        tenantId: 'tenant_1',
        userId: 'user_1',
        locale: 'en',
        expiresInMin: 15,
      }),
    )
    expect(record.payload).not.toHaveProperty('secret')
  })

  it('uses phone recipient type for SMS channel', async () => {
    const record = await buildNotificationFailureRecord({
      channel: 'sms',
      type: 'otp',
      recipient: '+14155552671',
      payload: { tenantId: 'tenant_1' },
    })

    expect(record.payload).toEqual(
      expect.objectContaining({
        channel: 'sms',
        recipientType: 'phone',
        emailDomain: null,
      }),
    )
    expect(record.recipient).toMatch(/^sha256:[a-f0-9]{64}$/)
  })

  it('scopes hash to platform when tenantId missing', async () => {
    const withTenant = await buildNotificationFailureRecord({
      channel: 'email',
      type: 'magic_link',
      recipient: 'a@b.com',
      payload: { tenantId: 'tenant_a' },
    })
    const withoutTenant = await buildNotificationFailureRecord({
      channel: 'email',
      type: 'magic_link',
      recipient: 'a@b.com',
      payload: {},
    })
    expect(withTenant.recipient).not.toBe(withoutTenant.recipient)
    expect(withoutTenant.tenantId).toBeNull()
  })
})
