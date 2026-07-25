// phone-otp-template 单元测试:内置模板、R2 fallback、locale 与 code 校验。
import { describe, expect, it, vi } from 'vitest'
import { renderPhoneOtpText } from '../phone-otp-template'

function makeR2(objects: Record<string, string | null>): R2Bucket {
  return {
    get: vi.fn(async (key: string) => {
      const text = objects[key]
      if (text === null || text === undefined) return null
      return { text: async () => text }
    }),
  } as unknown as R2Bucket
}

describe('renderPhoneOtpText', () => {
  it('renders built-in English OTP template when R2 has no override', async () => {
    const text = await renderPhoneOtpText({
      storage: makeR2({}),
      channel: 'sms',
      type: 'otp',
      payload: { code: '123456', expiresInMin: 10, locale: 'en' },
    })
    expect(text).toBe('Your XID verification code is 123456. It expires in 10 minutes.')
  })

  it('falls back to English when locale template missing', async () => {
    const text = await renderPhoneOtpText({
      storage: makeR2({}),
      channel: 'whatsapp',
      type: 'otp',
      payload: { code: '654321', locale: 'fr' },
    })
    expect(text).toContain('654321')
    expect(text).toContain('5 minutes')
  })

  it('prefers R2 template over built-in catalog', async () => {
    const storage = makeR2({
      'phone-otp-templates/sms/en/otp.txt': 'Code {{ code }} ({{ expiresInMin }}m)',
    })
    const text = await renderPhoneOtpText({
      storage,
      channel: 'sms',
      type: 'otp',
      payload: { code: '999999', expiresInMin: 3 },
    })
    expect(text).toBe('Code 999999 (3m)')
  })

  it('throws when code missing or template not found', async () => {
    await expect(
      renderPhoneOtpText({
        storage: makeR2({}),
        channel: 'sms',
        type: 'otp',
        payload: { locale: 'en' },
      }),
    ).rejects.toThrow('phone_otp_code_missing')

    await expect(
      renderPhoneOtpText({
        storage: makeR2({}),
        channel: 'sms',
        type: 'unknown_type',
        payload: { code: '111111' },
      }),
    ).rejects.toThrow('phone_otp_template_not_found')
  })
})
