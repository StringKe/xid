import { describe, it } from 'vitest'
import { runL3InboundSamlSmoke } from './harness/smoke-l3-inbound-saml.mjs'

describe('local L3 inbound SAML smoke', () => {
  it('passes fake IdP SP-initiated login and ACS session gates', async () => {
    await runL3InboundSamlSmoke()
  }, 600000)
})
