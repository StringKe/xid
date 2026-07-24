import { describe, it } from 'vitest'
import { runProductionPhoneOtpSmoke } from './harness/smoke-production-phone-otp.mjs'

describe('production phone OTP smoke', () => {
  it('passes production phone OTP send or full verify flow', async () => {
    await runProductionPhoneOtpSmoke()
  }, 300000)
})
