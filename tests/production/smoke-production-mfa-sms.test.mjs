import { describe, it } from 'vitest'
import { runProductionMfaSmsSmoke } from './harness/smoke-production-mfa-sms.mjs'

describe('production MFA SMS smoke', () => {
  it('passes provider-ready SMS MFA send or full verify flow', async () => {
    await runProductionMfaSmsSmoke()
  }, 300000)
})
