import { describe, it } from 'vitest'
import { runL2PlatformSmoke } from './harness/smoke-l2-platform.mjs'

describe('local L2 platform smoke', () => {
  it('passes local Worker HTTP platform gates', async () => {
    await runL2PlatformSmoke()
  }, 300000)
})
