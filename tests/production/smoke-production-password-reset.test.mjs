import { describe, it } from 'vitest'
import { runProductionPasswordResetSmoke } from './harness/smoke-production-password-reset.mjs'

describe('production password reset smoke', () => {
  it('passes production password reset send or full click flow', async () => {
    await runProductionPasswordResetSmoke()
  }, 300000)
})
