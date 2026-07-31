import { describe, it, expect } from 'vitest'

import { buildIdpMetadataXml, buildSamlResponseXml } from '../idp'
import { IDP_CERT_B64, IDP_ENTITY_ID } from './fixtures'

describe('buildIdpMetadataXml', () => {
  it('includes SSO URL and signing certificate', () => {
    const xml = buildIdpMetadataXml({
      entityId: IDP_ENTITY_ID,
      ssoUrl: 'https://idp.example.com/sso',
      signingCertsB64: [IDP_CERT_B64],
    })
    expect(xml).toContain(IDP_ENTITY_ID)
    expect(xml).toContain('https://idp.example.com/sso')
    expect(xml).toContain('SingleSignOnService')
    expect(xml).toContain(IDP_CERT_B64.replace(/\s+/g, ''))
    expect(xml).toContain('WantAuthnRequestsSigned="false"')
  })

  it('advertises a required AuthnRequest signature when configured', () => {
    const xml = buildIdpMetadataXml({
      entityId: IDP_ENTITY_ID,
      ssoUrl: 'https://idp.example.com/sso',
      signingCertsB64: [IDP_CERT_B64],
      wantAuthnRequestsSigned: true,
    })
    expect(xml).toContain('WantAuthnRequestsSigned="true"')
  })

  it('includes SingleLogoutService when sloUrl is provided', () => {
    const xml = buildIdpMetadataXml({
      entityId: IDP_ENTITY_ID,
      ssoUrl: 'https://idp.example.com/sso',
      sloUrl: 'https://idp.example.com/slo',
      signingCertsB64: [IDP_CERT_B64],
    })
    expect(xml).toContain('SingleLogoutService')
    expect(xml).toContain('https://idp.example.com/slo')
  })
})

describe('buildSamlResponseXml', () => {
  it('builds unsigned response with assertion subject and attributes', () => {
    const built = buildSamlResponseXml({
      issuer: IDP_ENTITY_ID,
      audience: 'https://sp.example/saml',
      acsUrl: 'https://sp.example/acs',
      subjectNameId: 'user@example.com',
      nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:emailAddress',
      attributes: { email: 'user@example.com', groups: ['admins'] },
      inResponseTo: '_req_1',
      now: Date.parse('2026-06-01T08:00:00Z'),
    })
    expect(built.responseId.startsWith('_')).toBe(true)
    expect(built.xml).toContain('samlp:Response')
    expect(built.xml).toContain('user@example.com')
    expect(built.xml).toContain('InResponseTo="_req_1"')
  })
})
