import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { createSamlPostPayload } from './saml-post-form.mjs'

describe('createSamlPostPayload properties', () => {
  it('rejects every non-matching ACS URL', () => {
    const expectedAcsUrl = 'https://xid.dev/sso/saml/connection/acs'
    fc.assert(
      fc.property(
        fc.string({ maxLength: 4096 }).filter((value) => value !== expectedAcsUrl),
        fc.string({ maxLength: 4096 }),
        fc.option(fc.string({ maxLength: 4096 }), { nil: null }),
        (acsUrl, samlResponse, relayState) => {
          expect(
            createSamlPostPayload({
              acsUrl,
              expectedAcsUrl,
              samlResponse,
              relayState,
            }),
          ).toBeNull()
        },
      ),
      { numRuns: 500 },
    )
  })
})
