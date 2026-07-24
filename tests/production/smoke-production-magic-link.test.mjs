import { describe, it } from 'vitest'
import { runProductionMagicLinkSmoke } from './harness/smoke-production-magic-link.mjs'

describe('production magic link smoke', () => {
  it('passes production magic link send or full click flow', async () => {
    await runProductionMagicLinkSmoke()
  }, 300000)
})
