import { describe, it } from 'vitest'
import { runL3HostedAuthorizeSmoke } from './harness/smoke-l3-hosted-authorize.mjs'

describe('local L3 hosted authorize smoke', () => {
  it('resumes application authorization after password, WhatsApp OTP and forced MFA enrollment', async () => {
    await runL3HostedAuthorizeSmoke()
  }, 600000)
})
