import { describe, it, expect } from 'vitest'

import { generateAuthnRequest } from '../authn-request'

describe('generateAuthnRequest', () => {
  it('builds SP-initiated AuthnRequest with underscore-prefixed id', () => {
    const result = generateAuthnRequest({
      spEntityId: 'https://sp.example/saml',
      idpSsoUrl: 'https://idp.example/sso',
      acsUrl: 'https://sp.example/acs',
      forceAuthn: true,
      now: Date.parse('2026-06-01T08:00:00Z'),
    })
    expect(result.id.startsWith('_')).toBe(true)
    expect(result.xml).toContain('AuthnRequest')
    expect(result.xml).toContain('https://idp.example/sso')
    expect(result.xml).toContain('ForceAuthn="true"')
    expect(result.xml).toContain('https://sp.example/acs')
  })
})
