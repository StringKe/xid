import { describe, it } from 'vitest'
import { runL3DeviceFlowSmoke } from './harness/smoke-l3-device-flow.mjs'

describe('local L3 device flow smoke', () => {
  it('passes device authorization, activation, and token poll gates', async () => {
    await runL3DeviceFlowSmoke()
  }, 600000)
})
