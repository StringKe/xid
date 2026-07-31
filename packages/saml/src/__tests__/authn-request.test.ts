import { beforeAll, describe, expect, it } from 'vitest'

import { generateAuthnRequest, signAuthnRequest, verifySamlAuthnRequest } from '../authn-request'
import { setSamlEngine } from '../engine'
import { encodeRedirectBindingMessage } from '../logout'
import { IDP_CERT_B64, SP_ENTITY_ID, importIdpSigningKey } from './fixtures'

const IDP_SSO_URL = 'https://idp.example.com/sso'
const ACS_URL = 'https://sp.example.com/acs'
const RSA_SHA256 = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256'

function verify(
  xml: string,
  overrides: Partial<Parameters<typeof verifySamlAuthnRequest>[1]> = {},
) {
  return verifySamlAuthnRequest(xml, {
    expectedIssuer: SP_ENTITY_ID,
    expectedDestination: IDP_SSO_URL,
    expectedAcsUrl: ACS_URL,
    ...overrides,
  })
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function requestSignatureInput(encoded: string, relayState: string, sigAlg: string): string {
  return [
    `SAMLRequest=${encodeURIComponent(encoded)}`,
    `RelayState=${encodeURIComponent(relayState)}`,
    `SigAlg=${encodeURIComponent(sigAlg)}`,
  ].join('&')
}

describe('generateAuthnRequest', () => {
  beforeAll(() => {
    setSamlEngine(globalThis.crypto)
  })

  it('builds SP-initiated AuthnRequest with underscore-prefixed id', () => {
    const result = generateAuthnRequest({
      spEntityId: SP_ENTITY_ID,
      idpSsoUrl: IDP_SSO_URL,
      acsUrl: ACS_URL,
      forceAuthn: true,
      now: Date.parse('2026-06-01T08:00:00Z'),
    })
    expect(result.id.startsWith('_')).toBe(true)
    expect(result.xml).toContain('AuthnRequest')
    expect(result.xml).toContain(IDP_SSO_URL)
    expect(result.xml).toContain('ForceAuthn="true"')
    expect(result.xml).toContain(ACS_URL)
  })

  it('accepts the advertised unsigned profile after exact SP binding checks', async () => {
    const request = generateAuthnRequest({
      spEntityId: SP_ENTITY_ID,
      idpSsoUrl: IDP_SSO_URL,
      acsUrl: ACS_URL,
    })
    await expect(verify(request.xml)).resolves.toEqual({
      ok: true,
      value: {
        requestId: request.id,
        issuer: SP_ENTITY_ID,
        destination: IDP_SSO_URL,
        acsUrl: ACS_URL,
        signatureVerified: false,
      },
    })
  })

  it.each([
    ['Issuer', { expectedIssuer: 'https://other.example/sp' }],
    ['Destination', { expectedDestination: 'https://other.example/sso' }],
    ['ACS', { expectedAcsUrl: 'https://other.example/acs' }],
  ])('rejects an AuthnRequest whose %s does not match registration', async (_label, override) => {
    const request = generateAuthnRequest({
      spEntityId: SP_ENTITY_ID,
      idpSsoUrl: IDP_SSO_URL,
      acsUrl: ACS_URL,
    })
    const result = await verify(request.xml, override)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(['issuer_mismatch', 'recipient_mismatch']).toContain(result.error.code)
    }
  })

  it.each([
    [
      'unknown child',
      (xml: string) =>
        xml.replace(
          '</samlp:AuthnRequest>',
          '<evil:Injected xmlns:evil="urn:evil"/></samlp:AuthnRequest>',
        ),
    ],
    [
      'duplicate Issuer',
      (xml: string) =>
        xml.replace('</saml:Issuer>', `</saml:Issuer><saml:Issuer>${SP_ENTITY_ID}</saml:Issuer>`),
    ],
    [
      'unknown attribute',
      (xml: string) => xml.replace('<samlp:AuthnRequest ', '<samlp:AuthnRequest Injected="1" '),
    ],
  ])('rejects %s through the fixed AuthnRequest grammar', async (_label, mutate) => {
    const request = generateAuthnRequest({
      spEntityId: SP_ENTITY_ID,
      idpSsoUrl: IDP_SSO_URL,
      acsUrl: ACS_URL,
    })
    const result = await verify(mutate(request.xml))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('schema_invalid')
  })

  it('rejects an AuthnRequest containing a DTD before DOM parsing', async () => {
    const request = generateAuthnRequest({
      spEntityId: SP_ENTITY_ID,
      idpSsoUrl: IDP_SSO_URL,
      acsUrl: ACS_URL,
    })
    const result = await verify(`<!DOCTYPE samlp:AuthnRequest [<!ENTITY x "x">]>${request.xml}`)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('malformed_xml')
  })

  it('enforces a configured signature requirement', async () => {
    const request = generateAuthnRequest({
      spEntityId: SP_ENTITY_ID,
      idpSsoUrl: IDP_SSO_URL,
      acsUrl: ACS_URL,
    })
    const result = await verify(request.xml, {
      requireSignature: true,
      spCertificatesB64: [IDP_CERT_B64],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('signature_required')
  })

  it('verifies an embedded AuthnRequest signature', async () => {
    const request = generateAuthnRequest({
      spEntityId: SP_ENTITY_ID,
      idpSsoUrl: IDP_SSO_URL,
      acsUrl: ACS_URL,
    })
    const signed = await signAuthnRequest(request, await importIdpSigningKey(), {
      name: 'RSASSA-PKCS1-v1_5',
    })
    if (!signed.ok) throw new Error(signed.error.reason)
    const verified = await verify(signed.value, {
      requireSignature: true,
      spCertificatesB64: [IDP_CERT_B64],
    })
    expect(verified.ok).toBe(true)
    if (verified.ok) expect(verified.value.signatureVerified).toBe(true)
  })

  it('rejects a present invalid Redirect signature even when the embedded signature is valid', async () => {
    const request = generateAuthnRequest({
      spEntityId: SP_ENTITY_ID,
      idpSsoUrl: IDP_SSO_URL,
      acsUrl: ACS_URL,
    })
    const signed = await signAuthnRequest(request, await importIdpSigningKey(), {
      name: 'RSASSA-PKCS1-v1_5',
    })
    if (!signed.ok) throw new Error(signed.error.reason)
    const encoded = await encodeRedirectBindingMessage(signed.value)
    const verified = await verify(signed.value, {
      requireSignature: true,
      spCertificatesB64: [IDP_CERT_B64],
      redirectSignature: {
        samlRequestEncoded: encoded,
        signature: 'AA==',
        sigAlg: RSA_SHA256,
      },
    })
    expect(verified.ok).toBe(false)
    if (!verified.ok) expect(verified.error.code).toBe('signature_invalid')
  })

  it('verifies a Redirect binding query signature', async () => {
    const request = generateAuthnRequest({
      spEntityId: SP_ENTITY_ID,
      idpSsoUrl: IDP_SSO_URL,
      acsUrl: ACS_URL,
    })
    const encoded = await encodeRedirectBindingMessage(request.xml)
    const relayState = 'relay-state'
    const content = requestSignatureInput(encoded, relayState, RSA_SHA256)
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        { name: 'RSASSA-PKCS1-v1_5' },
        await importIdpSigningKey(),
        new TextEncoder().encode(content),
      ),
    )
    const verified = await verify(request.xml, {
      requireSignature: true,
      spCertificatesB64: [IDP_CERT_B64],
      redirectSignature: {
        samlRequestEncoded: encoded,
        relayState,
        signature: bytesToBase64(signature),
        sigAlg: RSA_SHA256,
      },
    })
    expect(verified.ok).toBe(true)
    if (verified.ok) expect(verified.value.signatureVerified).toBe(true)
  })

  it('rejects an invalid Redirect binding query signature instead of ignoring it', async () => {
    const request = generateAuthnRequest({
      spEntityId: SP_ENTITY_ID,
      idpSsoUrl: IDP_SSO_URL,
      acsUrl: ACS_URL,
    })
    const encoded = await encodeRedirectBindingMessage(request.xml)
    const verified = await verify(request.xml, {
      spCertificatesB64: [IDP_CERT_B64],
      redirectSignature: {
        samlRequestEncoded: encoded,
        signature: 'AA==',
        sigAlg: RSA_SHA256,
      },
    })
    expect(verified.ok).toBe(false)
    if (!verified.ok) expect(verified.error.code).toBe('signature_invalid')
  })
})
