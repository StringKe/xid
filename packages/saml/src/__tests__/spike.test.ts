// xmldsigjs + @xmldom 在 Web Crypto 下的 XML-DSig round-trip 烟测;完整路径见 verify.test.ts。

import { describe, it, expect, beforeAll } from 'vitest'
import { setSamlEngine } from '../engine'
import { verifySamlResponse } from '../verify'
import {
  ACS_URL,
  IDP_CERT_B64,
  IDP_CERT_VALID_NOW,
  IDP_ENTITY_ID,
  SP_ENTITY_ID,
  buildResponseXml,
  importIdpSigningKey,
  signResponse,
} from './fixtures'

function baseOptions() {
  return {
    idpCertificatesB64: [IDP_CERT_B64],
    expectedIssuer: IDP_ENTITY_ID,
    expectedAudience: SP_ENTITY_ID,
    acsUrl: ACS_URL,
    spInitiated: false,
    wantAuthnResponseSigned: true,
    wantAssertionsSigned: true,
    now: IDP_CERT_VALID_NOW,
  }
}

describe('SAML XML-DSig spike (xmldsigjs + @xmldom/xmldom + Web Crypto)', () => {
  beforeAll(() => {
    setSamlEngine(crypto)
  })

  it('signs and verifies a SAML Response round-trip (signature valid)', async () => {
    const key = await importIdpSigningKey()
    const signed = await signResponse(buildResponseXml(), key, { response: true, assertion: true })

    const result = await verifySamlResponse(signed, baseOptions())

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.subject.nameId).toBe('user@example.com')
      expect(result.value.issuer).toBe(IDP_ENTITY_ID)
    }
  })

  it('rejects unsigned Response (signature required)', async () => {
    const result = await verifySamlResponse(buildResponseXml(), baseOptions())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('signature_required')
  })
})
