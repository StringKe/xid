import { describe, expect, it } from 'vitest'

import { buildSamlPostForm } from './saml-post-form.mjs'

describe('buildSamlPostForm', () => {
  it('escapes every dynamic HTML attribute', () => {
    const html = buildSamlPostForm({
      acsUrl: 'https://xid.dev/acs?next="><img src=x onerror=alert(1)>',
      samlResponse: 'response"><script>alert(1)</script>',
      relayState: 'relay"><svg onload=alert(1)>',
    })

    expect(html).not.toContain('<img')
    expect(html).not.toContain('<svg')
    expect(html).not.toContain('<script>alert')
    expect(html).toContain('&quot;&gt;&lt;img')
    expect(html).toContain('relay&quot;&gt;&lt;svg')
  })

  it('omits RelayState when none was supplied', () => {
    const html = buildSamlPostForm({
      acsUrl: 'https://xid.dev/acs',
      samlResponse: 'response',
      relayState: null,
    })

    expect(html).not.toContain('RelayState')
  })
})
