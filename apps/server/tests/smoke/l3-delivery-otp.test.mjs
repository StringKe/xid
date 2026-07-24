import { describe, it } from 'vitest'
import { runL3DeliveryOtpSmoke } from './harness/smoke-l3-delivery-otp.mjs'

describe('local L3 delivery OTP smoke', () => {
  it('passes test SMS OTP capture gate', async () => {
    await runL3DeliveryOtpSmoke()
  }, 600000)
})
