// verifySamlAssertion:以断言为根元素的 SAML 2.0 令牌(WS-Fed),用独立实现签名的样本验证正负路径。

import { beforeAll, describe, expect, it } from 'vitest'
import { setSamlEngine } from '../engine'
import { verifySamlAssertion } from '../verify-assertion'
import { OTHER_CERT_B64 } from './verify-helpers'
import samples from './samples/independent-signatures.json'

const NOW = Date.parse('2026-10-10T00:05:00Z')
const ACS = 'https://acme.xid.dev/sso/saml/conn_1/acs'

function verify(xml: string, over: Record<string, unknown> = {}) {
  return verifySamlAssertion(xml, {
    idpCertificatesB64: [samples.certificateB64],
    expectedIssuer: 'https://independent-idp.example.com/metadata',
    expectedAudience: 'https://acme.xid.dev/saml/conn_1',
    acsUrl: ACS,
    now: NOW,
    ...over,
  })
}

function unsign(xml: string): string {
  return xml.replace(/<ds:Signature[\s\S]*<\/ds:Signature>/, '')
}

describe('verifySamlAssertion', () => {
  beforeAll(() => {
    setSamlEngine(crypto)
  })

  it.each([
    ['a prefixed', samples.prefixedAssertionSignedStandalone],
    ['a default-namespace', samples.defaultNamespaceAssertionSignedStandalone],
  ])('accepts %s assertion signed by an independent implementation', async (_label, xml) => {
    const result = await verify(xml)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.subject.nameId).toBe('user@example.com')
      expect(result.value.attributes.email).toBe('user@example.com')
      expect(result.value.sessionIndex).toBe('_s1')
      expect(result.value.subjectConfirmationNotOnOrAfter).toBe(Date.parse('2126-01-01T00:00:00Z'))
    }
  })

  it('signature_required when the assertion carries no signature', async () => {
    const result = await verify(unsign(samples.prefixedAssertionSignedStandalone))

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('signature_required')
  })

  it('signature_invalid when a signed assertion is tampered', async () => {
    const tampered = samples.prefixedAssertionSignedStandalone.replace(
      '>user@example.com</saml:NameID>',
      '>attacker@evil.example.com</saml:NameID>',
    )

    const result = await verify(tampered)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('signature_invalid')
  })

  it('signature_invalid when verified with an unrelated certificate', async () => {
    const result = await verify(samples.prefixedAssertionSignedStandalone, {
      idpCertificatesB64: [OTHER_CERT_B64],
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('signature_invalid')
  })

  it('malformed_xml when given a Response instead of an assertion root', async () => {
    const result = await verify(samples.responseSignedPrefixedAssertion)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('malformed_xml')
  })

  it.each([
    ['issuer_mismatch', { expectedIssuer: 'https://other-idp.example.com/metadata' }],
    ['audience_mismatch', { expectedAudience: 'https://other.example.com/sp' }],
    ['recipient_mismatch', { acsUrl: 'https://acme.xid.dev/wsfed/other' }],
    ['assertion_expired', { now: Date.parse('2026-10-09T23:50:00Z') }],
  ] as const)('%s when the expectation differs from the signed assertion', async (code, over) => {
    const result = await verify(samples.prefixedAssertionSignedStandalone, over)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe(code)
  })
})
