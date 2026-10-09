// verifySamlResponse 端到端:成功路径与各错误分支,真实 crypto.subtle 验签。

import { describe, it, expect, beforeAll } from 'vitest'
import { setSamlEngine } from '../engine'
import { verifySamlResponse } from '../verify'
import { buildSpMetadataXml } from '../metadata'
import { generateAuthnRequest } from '../authn-request'
import { ACS_URL, IDP_CERT_B64, SP_ENTITY_ID, certificateWithValidity } from './fixtures'
import { NOW, OTHER_CERT_B64, opts, signedMutatedResponse, signedResponse } from './verify-helpers'

describe('verifySamlResponse end-to-end', () => {
  beforeAll(() => {
    setSamlEngine(crypto)
  })

  it('accepts a valid signed Response and maps attributes', async () => {
    const result = await verifySamlResponse(await signedResponse(), opts())
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.subject.nameId).toBe('user@example.com')
      expect(result.value.attributes.email).toBe('user@example.com')
      expect(result.value.attributes.firstName).toBe('Bjorn')
      expect(result.value.attributes.groups).toEqual(['eng', 'admin'])
      expect(result.value.signingCertFingerprint.length).toBeGreaterThan(0)
    }
  })

  it('signature_required when only assertion signing is configured and the assertion is unsigned', async () => {
    const xml = await signedResponse({}, { response: true, assertion: false })
    const result = await verifySamlResponse(xml, opts({ wantAuthnResponseSigned: false }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('signature_required')
  })

  it('signature_invalid when verified with an unrelated cert', async () => {
    const xml = await signedResponse()
    const result = await verifySamlResponse(xml, opts({ idpCertificatesB64: [OTHER_CERT_B64] }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('signature_invalid')
  })

  it('signature_invalid when the configured signing certificate is expired', async () => {
    const expired = certificateWithValidity(
      IDP_CERT_B64,
      NOW - 2 * 60 * 60 * 1000,
      NOW - 3 * 60 * 1000 - 1,
    )
    const result = await verifySamlResponse(
      await signedResponse(),
      opts({ idpCertificatesB64: [expired] }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('signature_invalid')
  })

  it('uses the valid certificate when rotation includes an expired certificate', async () => {
    const expired = certificateWithValidity(
      IDP_CERT_B64,
      NOW - 2 * 60 * 60 * 1000,
      NOW - 3 * 60 * 1000 - 1,
    )
    const result = await verifySamlResponse(
      await signedResponse(),
      opts({ idpCertificatesB64: [expired, IDP_CERT_B64] }),
    )
    expect(result.ok).toBe(true)
  })

  it('issuer_mismatch when Issuer differs from config', async () => {
    const xml = await signedResponse({ issuer: 'https://evil.example.com' })
    const result = await verifySamlResponse(xml, opts())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('issuer_mismatch')
  })

  it('recipient_mismatch when Recipient != ACS', async () => {
    const xml = await signedResponse({ recipient: 'https://acme.xid.dev/wrong/acs' })
    const result = await verifySamlResponse(xml, opts())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('recipient_mismatch')
  })

  it.each([
    [
      'missing',
      (xml: string) =>
        xml.replace(/(<saml:SubjectConfirmationData\b[^>]*?) Recipient="[^"]*"/, '$1'),
    ],
    [
      'blank',
      (xml: string) =>
        xml.replace(/(<saml:SubjectConfirmationData\b[^>]*? Recipient=")[^"]*"/, '$1 "'),
    ],
  ])('schema_invalid when SubjectConfirmationData Recipient is %s', async (_label, mutate) => {
    const result = await verifySamlResponse(await signedMutatedResponse(mutate), opts())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('schema_invalid')
  })

  it('recipient_mismatch when Response Destination != ACS', async () => {
    const xml = await signedResponse({ destination: 'https://acme.xid.dev/wrong/acs' })
    const result = await verifySamlResponse(xml, opts())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('recipient_mismatch')
  })

  it('recipient_mismatch when SubjectConfirmation Method is not bearer', async () => {
    const xml = await signedResponse({
      subjectConfirmationMethod: 'urn:oasis:names:tc:SAML:2.0:cm:holder-of-key',
    })
    const result = await verifySamlResponse(xml, opts())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('recipient_mismatch')
  })

  it.each([
    [
      'missing',
      (xml: string) =>
        xml.replace(/(<saml:SubjectConfirmationData\b[^>]*?) NotOnOrAfter="[^"]*"/, '$1'),
    ],
    [
      'blank',
      (xml: string) =>
        xml.replace(/(<saml:SubjectConfirmationData\b[^>]*? NotOnOrAfter=")[^"]*"/, '$1 "'),
    ],
    [
      'malformed',
      (xml: string) =>
        xml.replace(
          /(<saml:SubjectConfirmationData\b[^>]*? NotOnOrAfter=")[^"]*"/,
          '$1not-a-date"',
        ),
    ],
  ])('schema_invalid when SubjectConfirmationData NotOnOrAfter is %s', async (_label, mutate) => {
    const result = await verifySamlResponse(await signedMutatedResponse(mutate), opts())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('schema_invalid')
  })
})

describe('verifySamlResponse status / precheck / InResponseTo', () => {
  beforeAll(() => {
    setSamlEngine(crypto)
  })

  it('audience_mismatch when AudienceRestriction excludes SP', async () => {
    const xml = await signedResponse({ audience: 'https://other.sp/saml' })
    const result = await verifySamlResponse(xml, opts())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('audience_mismatch')
  })

  it('idp_status_error when StatusCode != Success', async () => {
    const xml = await signedResponse({ status: 'urn:oasis:names:tc:SAML:2.0:status:Requester' })
    const result = await verifySamlResponse(xml, opts())
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('idp_status_error')
      expect(result.error.idpStatus).toContain('Requester')
    }
  })

  it('malformed_xml when DTD present (XXE precheck)', async () => {
    const xml = '<!DOCTYPE x><samlp:Response/>'
    const result = await verifySamlResponse(xml, opts())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('malformed_xml')
  })
})

describe('verifySamlResponse SP-initiated InResponseTo', () => {
  beforeAll(() => {
    setSamlEngine(crypto)
  })

  it('SP-initiated requires InResponseTo present', async () => {
    const xml = await signedResponse()
    const result = await verifySamlResponse(xml, opts({ spInitiated: true }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('recipient_mismatch')
  })

  it('SP-initiated accepts matching InResponseTo', async () => {
    const xml = await signedResponse({ inResponseTo: '_req_123' })
    const result = await verifySamlResponse(xml, opts({ spInitiated: true }))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.inResponseTo).toBe('_req_123')
  })

  it('auto mode accepts IdP and SP initiated assertions', async () => {
    const idpXml = await signedResponse()
    const spXml = await signedResponse({ inResponseTo: '_req_456' })

    const idpResult = await verifySamlResponse(idpXml, opts({ spInitiated: 'auto' }))
    const spResult = await verifySamlResponse(spXml, opts({ spInitiated: 'auto' }))

    expect(idpResult.ok).toBe(true)
    expect(spResult.ok).toBe(true)
    if (spResult.ok) expect(spResult.value.inResponseTo).toBe('_req_456')
  })
})

describe('SP metadata + AuthnRequest', () => {
  it('builds SP metadata with required fields', () => {
    const xml = buildSpMetadataXml({
      entityId: SP_ENTITY_ID,
      acsUrl: ACS_URL,
      authnRequestsSigned: false,
      wantAssertionsSigned: true,
      signingCertsB64: [IDP_CERT_B64],
      encryptionCertsB64: [IDP_CERT_B64],
    })
    expect(xml).toContain(`entityID="${SP_ENTITY_ID}"`)
    expect(xml).toContain('WantAssertionsSigned="true"')
    expect(xml).toContain('AssertionConsumerService')
    expect(xml).toContain('use="encryption"')
    expect(xml).toContain('nameid-format:emailAddress')
  })

  it('generates AuthnRequest with id + Destination', () => {
    const req = generateAuthnRequest({
      spEntityId: SP_ENTITY_ID,
      idpSsoUrl: 'https://idp.example.com/sso',
      acsUrl: ACS_URL,
    })
    expect(req.id.startsWith('_')).toBe(true)
    expect(req.xml).toContain('Destination="https://idp.example.com/sso"')
    expect(req.xml).toContain(`<saml:Issuer>${SP_ENTITY_ID}</saml:Issuer>`)
  })
})
