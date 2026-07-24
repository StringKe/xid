import { describe, it } from 'vitest'
import { runProductionSmoke } from './harness/smoke-production.mjs'

describe('production HTTP smoke', () => {
  it('passes production HTTP and D1 gates', async () => {
    await runProductionSmoke()
  }, 240000)
})
