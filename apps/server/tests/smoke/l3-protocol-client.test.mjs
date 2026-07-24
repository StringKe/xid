import { describe, it } from 'vitest'
import { runL3ProtocolClientSmoke } from './harness/smoke-l3-protocol-client.mjs'

describe('local L3 protocol client smoke', () => {
  it('passes OAuth PAR, DPoP userinfo, and SCIM CRUD client gates', async () => {
    await runL3ProtocolClientSmoke()
  }, 600000)
})
