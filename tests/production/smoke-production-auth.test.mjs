import { describe, it } from 'vitest'
import { runProductionAuthSmoke } from './harness/smoke-production-auth.mjs'

describe('production auth smoke', () => {
  it('signs in with email OTP on production', async () => {
    await runProductionAuthSmoke()
  }, 240000)
})
