import { describe, expect, it } from 'vitest'

import { createSamlPostPayload, SAML_POST_PAGE } from './saml-post-form.mjs'

describe('SAML POST handoff', () => {
  it('keeps request-derived values out of the HTML response', () => {
    expect(SAML_POST_PAGE).toContain("fetch('/saml-post-payload'")
    expect(SAML_POST_PAGE).toContain("document.createElement('form')")
    expect(SAML_POST_PAGE).not.toContain('SAMLResponse" value=')
  })

  it('prevents an implicit favicon request from polluting the browser console', () => {
    expect(SAML_POST_PAGE).toContain('<link rel="icon" href="data:,">')
  })

  it('creates a payload only for the exact expected ACS URL', () => {
    const expectedAcsUrl = 'https://xid.dev/sso/saml/connection/acs'
    const payload = createSamlPostPayload({
      acsUrl: expectedAcsUrl,
      expectedAcsUrl,
      samlResponse: 'response',
      relayState: 'relay',
    })

    expect(payload).toEqual({
      acsUrl: expectedAcsUrl,
      samlResponse: 'response',
      relayState: 'relay',
    })
  })

  it('rejects an unexpected ACS URL', () => {
    const payload = createSamlPostPayload({
      acsUrl: 'https://attacker.example/acs',
      expectedAcsUrl: 'https://xid.dev/sso/saml/connection/acs',
      samlResponse: 'response',
      relayState: null,
    })

    expect(payload).toBeNull()
  })
})
