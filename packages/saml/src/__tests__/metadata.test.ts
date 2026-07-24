import { describe, it, expect } from 'vitest'

import { buildSpMetadataXml } from '../metadata'
import { IDP_CERT_B64, ACS_URL, SP_ENTITY_ID } from './fixtures'

describe('buildSpMetadataXml', () => {
  it('includes required SP SSO fields and escapes XML', () => {
    const xml = buildSpMetadataXml({
      entityId: SP_ENTITY_ID,
      acsUrl: ACS_URL,
      authnRequestsSigned: true,
      wantAssertionsSigned: true,
      signingCertsB64: [IDP_CERT_B64],
      encryptionCertsB64: [IDP_CERT_B64],
    })
    expect(xml).toContain(`entityID="${SP_ENTITY_ID}"`)
    expect(xml).toContain(`Location="${ACS_URL}"`)
    expect(xml).toContain('AuthnRequestsSigned="true"')
    expect(xml).toContain('WantAssertionsSigned="true"')
    expect(xml).toContain('NameIDFormat')
    expect(xml).toContain('KeyDescriptor use="signing"')
    expect(xml).toContain('KeyDescriptor use="encryption"')
  })

  it('includes SingleLogoutService when sloUrl is provided', () => {
    const xml = buildSpMetadataXml({
      entityId: SP_ENTITY_ID,
      acsUrl: ACS_URL,
      sloUrl: 'https://acme.xid.dev/sso/saml/conn_1/slo',
      authnRequestsSigned: true,
      wantAssertionsSigned: true,
      signingCertsB64: [IDP_CERT_B64],
    })
    expect(xml).toContain('SingleLogoutService')
    expect(xml).toContain('https://acme.xid.dev/sso/saml/conn_1/slo')
  })
})
