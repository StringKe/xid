import { describe, it } from 'vitest'
import { runL3InboundLegacySmoke } from './harness/smoke-l3-inbound-legacy.mjs'

describe('local L3 inbound legacy enterprise smoke', () => {
  it('passes LDAP, WS-Fed, SWA, and header SSO happy paths', async () => {
    await runL3InboundLegacySmoke()
  }, 600000)
})
