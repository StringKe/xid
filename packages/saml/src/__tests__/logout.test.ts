import { describe, it, expect, beforeAll } from 'vitest'
import { Parse, SignedXml, Stringify } from 'xmldsigjs'

import { setSamlEngine } from '../engine'
import {
  buildLogoutRequestXml,
  buildLogoutResponseXml,
  decodeSamlBindingPayload,
  encodeRedirectBindingMessage,
  verifySamlLogoutRequest,
  verifySamlLogoutResponse,
} from '../logout'
import { IDP_CERT_B64, IDP_CERT_VALID_NOW, IDP_ENTITY_ID, importIdpSigningKey } from './fixtures'

const SLO_URL = 'https://acme.xid.dev/sso/saml/conn_1/slo'
const SP_ENTITY_ID = 'https://acme.xid.dev/saml/conn_1'
const ASSERT_NS = 'urn:oasis:names:tc:SAML:2.0:assertion'
const DS_NS = 'http://www.w3.org/2000/09/xmldsig#'
const RSA_SHA256 = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256'

function directChild(root: Element, namespace: string, localName: string): Element | undefined {
  for (let index = 0; index < root.childNodes.length; index += 1) {
    const node = root.childNodes.item(index)
    if (
      node?.nodeType === 1 &&
      (node as Element).namespaceURI === namespace &&
      (node as Element).localName === localName
    ) {
      return node as Element
    }
  }
  return undefined
}

async function signLogoutXml(xml: string): Promise<string> {
  const key = await importIdpSigningKey()
  const doc = Parse(xml)
  const root = doc.documentElement
  const id = root.getAttribute('ID') ?? ''
  const signedXml = new SignedXml(doc)
  await signedXml.Sign({ name: 'RSASSA-PKCS1-v1_5' }, key, doc, {
    references: [{ uri: `#${id}`, hash: 'SHA-256', transforms: ['enveloped', 'exc-c14n'] }],
  })
  const sig = signedXml.GetXml()
  if (!sig) throw new Error('signature not produced')
  const issuer = directChild(root, ASSERT_NS, 'Issuer')
  root.insertBefore(sig, issuer?.nextSibling ?? root.firstChild)
  return Stringify(doc)
}

async function signLogoutRequestXml(xml: string): Promise<string> {
  return signLogoutXml(xml)
}

async function verifyRequest(xml: string) {
  return verifySamlLogoutRequest(xml, {
    idpCertificatesB64: [IDP_CERT_B64],
    expectedIssuer: IDP_ENTITY_ID,
    expectedDestination: SLO_URL,
  })
}

function withNotOnOrAfter(xml: string, notOnOrAfter: number): string {
  return xml.replace(
    ' Destination=',
    ` NotOnOrAfter="${new Date(notOnOrAfter).toISOString()}" Destination=`,
  )
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

async function signRedirectContent(content: string): Promise<string> {
  return bytesToBase64(
    new Uint8Array(
      await crypto.subtle.sign(
        { name: 'RSASSA-PKCS1-v1_5' },
        await importIdpSigningKey(),
        new TextEncoder().encode(content),
      ),
    ),
  )
}

function redirectSignatureInput(
  parameterName: 'SAMLRequest' | 'SAMLResponse',
  encoded: string,
  relayState: string | null | undefined,
  sigAlg: string,
): string {
  const parts = [`${parameterName}=${encodeURIComponent(encoded)}`]
  if (relayState !== null && relayState !== undefined) {
    parts.push(`RelayState=${encodeURIComponent(relayState)}`)
  }
  parts.push(`SigAlg=${encodeURIComponent(sigAlg)}`)
  return parts.join('&')
}

describe('SAML logout messages', () => {
  beforeAll(() => {
    setSamlEngine(globalThis.crypto)
  })
  it('builds LogoutResponse with InResponseTo', () => {
    const built = buildLogoutResponseXml({
      issuer: SP_ENTITY_ID,
      destination: 'https://idp.example.com/slo',
      inResponseTo: '_logout_req_1',
      now: Date.parse('2026-06-01T08:00:00Z'),
    })
    expect(built.xml).toContain('samlp:LogoutResponse')
    expect(built.xml).toContain('InResponseTo="_logout_req_1"')
  })

  it('builds LogoutRequest with SessionIndex', () => {
    const built = buildLogoutRequestXml({
      issuer: IDP_ENTITY_ID,
      destination: SLO_URL,
      nameId: 'user@example.com',
      nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:emailAddress',
      sessionIndex: '_session_1',
      now: Date.parse('2026-06-01T08:00:00Z'),
    })
    expect(built.xml).toContain('samlp:LogoutRequest')
    expect(built.xml).toContain('SessionIndex')
    expect(built.xml).toContain('_session_1')
  })

  it('verifies signed LogoutRequest and extracts every SessionIndex', async () => {
    const built = buildLogoutRequestXml({
      issuer: IDP_ENTITY_ID,
      destination: SLO_URL,
      nameId: 'user@example.com',
      nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:emailAddress',
      sessionIndex: '_session_abc',
    })
    const xml = built.xml.replace(
      '</samlp:LogoutRequest>',
      '<samlp:SessionIndex>_session_def</samlp:SessionIndex></samlp:LogoutRequest>',
    )
    const signed = await signLogoutRequestXml(xml)
    const verified = await verifySamlLogoutRequest(signed, {
      idpCertificatesB64: [IDP_CERT_B64],
      expectedIssuer: IDP_ENTITY_ID,
      expectedDestination: SLO_URL,
    })
    if (!verified.ok) {
      throw new Error(`${verified.error.code}: ${verified.error.reason}`)
    }
    expect(verified.value.requestId).toBe(built.requestId)
    expect(verified.value.sessionIndexes).toEqual(['_session_abc', '_session_def'])
    expect(verified.value.nameId).toBe('user@example.com')
  })

  it('rejects a LogoutRequest whose IssueInstant is five minutes old', async () => {
    const now = IDP_CERT_VALID_NOW
    const built = buildLogoutRequestXml({
      issuer: IDP_ENTITY_ID,
      destination: SLO_URL,
      nameId: 'user@example.com',
      nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:emailAddress',
      now: now - 5 * 60 * 1000,
    })
    const verified = await verifySamlLogoutRequest(await signLogoutRequestXml(built.xml), {
      idpCertificatesB64: [IDP_CERT_B64],
      expectedIssuer: IDP_ENTITY_ID,
      expectedDestination: SLO_URL,
      now,
    })

    expect(verified.ok).toBe(false)
    if (!verified.ok) expect(verified.error.code).toBe('assertion_expired')
  })

  it('rejects a LogoutRequest whose IssueInstant exceeds the configured future skew', async () => {
    const now = IDP_CERT_VALID_NOW
    const built = buildLogoutRequestXml({
      issuer: IDP_ENTITY_ID,
      destination: SLO_URL,
      nameId: 'user@example.com',
      nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:emailAddress',
      now: now + 3 * 60 * 1000 + 1,
    })
    const verified = await verifySamlLogoutRequest(await signLogoutRequestXml(built.xml), {
      idpCertificatesB64: [IDP_CERT_B64],
      expectedIssuer: IDP_ENTITY_ID,
      expectedDestination: SLO_URL,
      now,
    })

    expect(verified.ok).toBe(false)
    if (!verified.ok) expect(verified.error.code).toBe('assertion_expired')
  })

  it('rejects a LogoutRequest at its explicit NotOnOrAfter boundary', async () => {
    const now = IDP_CERT_VALID_NOW
    const built = buildLogoutRequestXml({
      issuer: IDP_ENTITY_ID,
      destination: SLO_URL,
      nameId: 'user@example.com',
      nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:emailAddress',
      now: now - 60 * 1000,
    })
    const xml = withNotOnOrAfter(built.xml, now)
    const verified = await verifySamlLogoutRequest(await signLogoutRequestXml(xml), {
      idpCertificatesB64: [IDP_CERT_B64],
      expectedIssuer: IDP_ENTITY_ID,
      expectedDestination: SLO_URL,
      now,
    })

    expect(verified.ok).toBe(false)
    if (!verified.ok) expect(verified.error.code).toBe('assertion_expired')
  })

  it('does not let a far-future NotOnOrAfter extend the five-minute freshness window', async () => {
    const now = IDP_CERT_VALID_NOW
    const built = buildLogoutRequestXml({
      issuer: IDP_ENTITY_ID,
      destination: SLO_URL,
      nameId: 'user@example.com',
      nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:emailAddress',
      now: now - 5 * 60 * 1000,
    })
    const xml = withNotOnOrAfter(built.xml, now + 60 * 60 * 1000)
    const verified = await verifySamlLogoutRequest(await signLogoutRequestXml(xml), {
      idpCertificatesB64: [IDP_CERT_B64],
      expectedIssuer: IDP_ENTITY_ID,
      expectedDestination: SLO_URL,
      now,
    })

    expect(verified.ok).toBe(false)
    if (!verified.ok) expect(verified.error.code).toBe('assertion_expired')
  })

  it('returns a bounded acceptance deadline for the maximum configured future skew', async () => {
    const now = IDP_CERT_VALID_NOW
    const issueInstant = now + 5 * 60 * 1000
    const built = buildLogoutRequestXml({
      issuer: IDP_ENTITY_ID,
      destination: SLO_URL,
      nameId: 'user@example.com',
      nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:emailAddress',
      now: issueInstant,
    })
    const xml = withNotOnOrAfter(built.xml, now + 60 * 60 * 1000)
    const verified = await verifySamlLogoutRequest(await signLogoutRequestXml(xml), {
      idpCertificatesB64: [IDP_CERT_B64],
      expectedIssuer: IDP_ENTITY_ID,
      expectedDestination: SLO_URL,
      now,
      clockSkewToleranceMs: 5 * 60 * 1000,
    })

    expect(verified.ok).toBe(true)
    if (verified.ok) expect(verified.value.validUntil).toBe(now + 10 * 60 * 1000)
  })

  it('rejects a present invalid Redirect signature even when LogoutRequest XML is signed', async () => {
    const built = buildLogoutRequestXml({
      issuer: IDP_ENTITY_ID,
      destination: SLO_URL,
      nameId: 'user@example.com',
      nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:emailAddress',
    })
    const signed = await signLogoutRequestXml(built.xml)
    const encoded = await encodeRedirectBindingMessage(signed)
    const verified = await verifySamlLogoutRequest(signed, {
      idpCertificatesB64: [IDP_CERT_B64],
      expectedIssuer: IDP_ENTITY_ID,
      expectedDestination: SLO_URL,
      redirectSignature: {
        samlRequestEncoded: encoded,
        signature: 'AA==',
        sigAlg: RSA_SHA256,
      },
    })
    expect(verified.ok).toBe(false)
    if (!verified.ok) expect(verified.error.code).toBe('signature_invalid')
  })

  it('rejects LogoutRequest when expected destination is missing', async () => {
    const built = buildLogoutRequestXml({
      issuer: IDP_ENTITY_ID,
      destination: SLO_URL,
      nameId: 'user@example.com',
      nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:emailAddress',
      sessionIndex: '_session_abc',
    })
    const unsigned = built.xml.replace(/ Destination="[^"]*"/, '')
    const signed = await signLogoutRequestXml(unsigned)
    const verified = await verifySamlLogoutRequest(signed, {
      idpCertificatesB64: [IDP_CERT_B64],
      expectedIssuer: IDP_ENTITY_ID,
      expectedDestination: SLO_URL,
    })
    expect(verified.ok).toBe(false)
    if (verified.ok) return
    expect(verified.error.code).toBe('recipient_mismatch')
  })

  it.each([
    [
      'unknown child',
      (xml: string) =>
        xml.replace('<saml:NameID', '<evil:Injected xmlns:evil="urn:evil"/><saml:NameID'),
    ],
    [
      'duplicate Issuer',
      (xml: string) =>
        xml.replace('</saml:Issuer>', `</saml:Issuer><saml:Issuer>${IDP_ENTITY_ID}</saml:Issuer>`),
    ],
    [
      'duplicate NameID',
      (xml: string) =>
        xml.replace(
          '</saml:NameID>',
          '</saml:NameID><saml:NameID>attacker@example.com</saml:NameID>',
        ),
    ],
  ])('rejects a signed POST LogoutRequest with %s', async (_label, mutate) => {
    const built = buildLogoutRequestXml({
      issuer: IDP_ENTITY_ID,
      destination: SLO_URL,
      nameId: 'user@example.com',
      nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:emailAddress',
      sessionIndex: '_session_abc',
    })
    const verified = await verifyRequest(await signLogoutRequestXml(mutate(built.xml)))
    expect(verified.ok).toBe(false)
    if (!verified.ok) expect(verified.error.code).toBe('schema_invalid')
  })

  it('rejects a LogoutRequest Signature moved out of its fixed position', async () => {
    const built = buildLogoutRequestXml({
      issuer: IDP_ENTITY_ID,
      destination: SLO_URL,
      nameId: 'user@example.com',
      nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:emailAddress',
      sessionIndex: '_session_abc',
    })
    const doc = Parse(await signLogoutRequestXml(built.xml))
    const signature = directChild(doc.documentElement, DS_NS, 'Signature')
    if (!signature) throw new Error('LogoutRequest Signature missing')
    doc.documentElement.appendChild(signature)

    const verified = await verifyRequest(Stringify(doc))
    expect(verified.ok).toBe(false)
    if (!verified.ok) expect(verified.error.code).toBe('schema_invalid')
  })

  it('rejects malformed Redirect LogoutRequest structure before query signature verification', async () => {
    const built = buildLogoutRequestXml({
      issuer: IDP_ENTITY_ID,
      destination: SLO_URL,
      nameId: 'user@example.com',
      nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:emailAddress',
    })
    const malformed = built.xml.replace(
      '<saml:NameID',
      '<evil:Injected xmlns:evil="urn:evil"/><saml:NameID',
    )
    const encoded = await encodeRedirectBindingMessage(malformed)
    const decoded = await decodeSamlBindingPayload(encoded, 'redirect')
    if (!decoded.ok) throw new Error(decoded.error.reason)

    const verified = await verifySamlLogoutRequest(decoded.value, {
      idpCertificatesB64: [IDP_CERT_B64],
      expectedIssuer: IDP_ENTITY_ID,
      expectedDestination: SLO_URL,
      redirectSignature: {
        samlRequestEncoded: encoded,
        signature: 'AA==',
        sigAlg: RSA_SHA256,
      },
    })
    expect(verified.ok).toBe(false)
    if (!verified.ok) expect(verified.error.code).toBe('schema_invalid')
  })

  it('verifies a structurally valid Redirect LogoutRequest', async () => {
    const built = buildLogoutRequestXml({
      issuer: IDP_ENTITY_ID,
      destination: SLO_URL,
      nameId: 'user@example.com',
      nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:emailAddress',
      sessionIndex: '_session_redirect',
    })
    const encoded = await encodeRedirectBindingMessage(built.xml)
    const signedContent = redirectSignatureInput('SAMLRequest', encoded, undefined, RSA_SHA256)
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        { name: 'RSASSA-PKCS1-v1_5' },
        await importIdpSigningKey(),
        new TextEncoder().encode(signedContent),
      ),
    )
    const verified = await verifySamlLogoutRequest(built.xml, {
      idpCertificatesB64: [IDP_CERT_B64],
      expectedIssuer: IDP_ENTITY_ID,
      expectedDestination: SLO_URL,
      redirectSignature: {
        samlRequestEncoded: encoded,
        signature: bytesToBase64(signature),
        sigAlg: RSA_SHA256,
      },
    })
    expect(verified.ok).toBe(true)
    if (verified.ok) expect(verified.value.sessionIndexes).toEqual(['_session_redirect'])
  })

  it('verifies LogoutRequest against lowercase percent escapes and plus exactly as received', async () => {
    const built = buildLogoutRequestXml({
      issuer: IDP_ENTITY_ID,
      destination: SLO_URL,
      nameId: 'user@example.com',
      nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:emailAddress',
    })
    const wireEncoded = {
      samlMessage: 'request%2fwire',
      relayState: 'state+value',
      sigAlg: encodeURIComponent(RSA_SHA256),
    }
    const signedContent = `SAMLRequest=${wireEncoded.samlMessage}&RelayState=${wireEncoded.relayState}&SigAlg=${wireEncoded.sigAlg}`
    const verified = await verifySamlLogoutRequest(built.xml, {
      idpCertificatesB64: [IDP_CERT_B64],
      expectedIssuer: IDP_ENTITY_ID,
      expectedDestination: SLO_URL,
      redirectSignature: {
        samlRequestEncoded: 'request/wire',
        relayState: 'state value',
        signature: await signRedirectContent(signedContent),
        sigAlg: RSA_SHA256,
        wireEncoded,
      },
    })

    expect(verified.ok).toBe(true)
  })

  it.each([
    [
      'unknown attribute',
      (xml: string) => xml.replace('<samlp:LogoutRequest ', '<samlp:LogoutRequest Injected="1" '),
    ],
    [
      'invalid IssueInstant',
      (xml: string) => xml.replace(/ IssueInstant="[^"]*"/, ' IssueInstant="not-a-date"'),
    ],
  ])('rejects a POST LogoutRequest with %s', async (_label, mutate) => {
    const built = buildLogoutRequestXml({
      issuer: IDP_ENTITY_ID,
      destination: SLO_URL,
      nameId: 'user@example.com',
      nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:emailAddress',
    })
    const verified = await verifyRequest(await signLogoutRequestXml(mutate(built.xml)))
    expect(verified.ok).toBe(false)
    if (!verified.ok) expect(verified.error.code).toBe('schema_invalid')
  })

  it('verifies a signed LogoutResponse with fixed structure', async () => {
    const built = buildLogoutResponseXml({
      issuer: SP_ENTITY_ID,
      destination: 'https://idp.example.com/slo',
      inResponseTo: '_logout_req_1',
    })
    const verified = await verifySamlLogoutResponse(await signLogoutXml(built.xml), {
      spCertificatesB64: [IDP_CERT_B64],
      expectedIssuer: SP_ENTITY_ID,
      expectedDestination: 'https://idp.example.com/slo',
      expectedInResponseTo: '_logout_req_1',
      requireSignature: true,
    })
    expect(verified.ok).toBe(true)
  })

  it('rejects a present invalid Redirect signature even when LogoutResponse XML is signed', async () => {
    const built = buildLogoutResponseXml({
      issuer: SP_ENTITY_ID,
      destination: 'https://idp.example.com/slo',
      inResponseTo: '_logout_req_both_signatures',
    })
    const signed = await signLogoutXml(built.xml)
    const encoded = await encodeRedirectBindingMessage(signed)
    const verified = await verifySamlLogoutResponse(signed, {
      spCertificatesB64: [IDP_CERT_B64],
      expectedIssuer: SP_ENTITY_ID,
      requireSignature: true,
      redirectSignature: {
        samlResponseEncoded: encoded,
        signature: 'AA==',
        sigAlg: RSA_SHA256,
      },
    })
    expect(verified.ok).toBe(false)
    if (!verified.ok) expect(verified.error.code).toBe('signature_invalid')
  })

  it('verifies a detached Redirect LogoutResponse signature', async () => {
    const built = buildLogoutResponseXml({
      issuer: SP_ENTITY_ID,
      destination: 'https://idp.example.com/slo',
      inResponseTo: '_logout_req_redirect',
    })
    const encoded = await encodeRedirectBindingMessage(built.xml)
    const relayState = 'logout-state'
    const signedContent = redirectSignatureInput('SAMLResponse', encoded, relayState, RSA_SHA256)
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        { name: 'RSASSA-PKCS1-v1_5' },
        await importIdpSigningKey(),
        new TextEncoder().encode(signedContent),
      ),
    )

    const verified = await verifySamlLogoutResponse(built.xml, {
      spCertificatesB64: [IDP_CERT_B64],
      expectedIssuer: SP_ENTITY_ID,
      expectedDestination: 'https://idp.example.com/slo',
      expectedInResponseTo: '_logout_req_redirect',
      requireSignature: true,
      redirectSignature: {
        samlResponseEncoded: encoded,
        relayState,
        signature: bytesToBase64(signature),
        sigAlg: RSA_SHA256,
      },
    })

    expect(verified.ok).toBe(true)
  })

  it('verifies LogoutResponse against uppercase percent escapes and %20 exactly as received', async () => {
    const built = buildLogoutResponseXml({
      issuer: SP_ENTITY_ID,
      destination: 'https://idp.example.com/slo',
      inResponseTo: '_logout_req_wire_response',
    })
    const wireEncoded = {
      samlMessage: 'response%2Fwire',
      relayState: 'state%20value',
      sigAlg: encodeURIComponent(RSA_SHA256),
    }
    const signedContent = `SAMLResponse=${wireEncoded.samlMessage}&RelayState=${wireEncoded.relayState}&SigAlg=${wireEncoded.sigAlg}`
    const verified = await verifySamlLogoutResponse(built.xml, {
      spCertificatesB64: [IDP_CERT_B64],
      expectedIssuer: SP_ENTITY_ID,
      expectedDestination: 'https://idp.example.com/slo',
      expectedInResponseTo: '_logout_req_wire_response',
      requireSignature: true,
      redirectSignature: {
        samlResponseEncoded: 'response/wire',
        relayState: 'state value',
        signature: await signRedirectContent(signedContent),
        sigAlg: RSA_SHA256,
        wireEncoded,
      },
    })

    expect(verified.ok).toBe(true)
  })

  it('rejects a required unsigned LogoutResponse', async () => {
    const built = buildLogoutResponseXml({
      issuer: SP_ENTITY_ID,
      destination: 'https://idp.example.com/slo',
      inResponseTo: '_logout_req_unsigned',
    })
    const verified = await verifySamlLogoutResponse(built.xml, {
      expectedIssuer: SP_ENTITY_ID,
      requireSignature: true,
    })
    expect(verified.ok).toBe(false)
    if (!verified.ok) expect(verified.error.code).toBe('signature_required')
  })

  it('rejects a signed LogoutResponse when no certificate is configured', async () => {
    const built = buildLogoutResponseXml({
      issuer: SP_ENTITY_ID,
      destination: 'https://idp.example.com/slo',
      inResponseTo: '_logout_req_no_cert',
    })
    const verified = await verifySamlLogoutResponse(await signLogoutXml(built.xml), {
      expectedIssuer: SP_ENTITY_ID,
      requireSignature: true,
    })
    expect(verified.ok).toBe(false)
    if (!verified.ok) expect(verified.error.code).toBe('signature_invalid')
  })

  it.each([
    [
      'unknown child',
      (xml: string) =>
        xml.replace('<samlp:Status>', '<evil:Injected xmlns:evil="urn:evil"/><samlp:Status>'),
    ],
    [
      'duplicate Issuer',
      (xml: string) =>
        xml.replace('</saml:Issuer>', `</saml:Issuer><saml:Issuer>${SP_ENTITY_ID}</saml:Issuer>`),
    ],
    [
      'duplicate Status',
      (xml: string) =>
        xml.replace(
          '</samlp:Status>',
          '</samlp:Status><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>',
        ),
    ],
  ])('rejects a signed POST LogoutResponse with %s', async (_label, mutate) => {
    const built = buildLogoutResponseXml({
      issuer: SP_ENTITY_ID,
      destination: 'https://idp.example.com/slo',
      inResponseTo: '_logout_req_1',
    })
    const verified = await verifySamlLogoutResponse(await signLogoutXml(mutate(built.xml)), {
      spCertificatesB64: [IDP_CERT_B64],
      expectedIssuer: SP_ENTITY_ID,
      expectedDestination: 'https://idp.example.com/slo',
      expectedInResponseTo: '_logout_req_1',
    })
    expect(verified.ok).toBe(false)
    if (!verified.ok) expect(verified.error.code).toBe('schema_invalid')
  })

  it('rejects a LogoutResponse Signature moved out of its fixed position', async () => {
    const built = buildLogoutResponseXml({
      issuer: SP_ENTITY_ID,
      destination: 'https://idp.example.com/slo',
      inResponseTo: '_logout_req_1',
    })
    const doc = Parse(await signLogoutXml(built.xml))
    const signature = directChild(doc.documentElement, DS_NS, 'Signature')
    if (!signature) throw new Error('LogoutResponse Signature missing')
    doc.documentElement.appendChild(signature)

    const verified = await verifySamlLogoutResponse(Stringify(doc), {
      spCertificatesB64: [IDP_CERT_B64],
      expectedIssuer: SP_ENTITY_ID,
    })
    expect(verified.ok).toBe(false)
    if (!verified.ok) expect(verified.error.code).toBe('schema_invalid')
  })

  it('rejects malformed Redirect LogoutResponse structure after decoding', async () => {
    const built = buildLogoutResponseXml({
      issuer: SP_ENTITY_ID,
      destination: 'https://idp.example.com/slo',
      inResponseTo: '_logout_req_1',
    })
    const malformed = built.xml.replace(
      '<samlp:Status>',
      '<evil:Injected xmlns:evil="urn:evil"/><samlp:Status>',
    )
    const encoded = await encodeRedirectBindingMessage(malformed)
    const decoded = await decodeSamlBindingPayload(encoded, 'redirect')
    if (!decoded.ok) throw new Error(decoded.error.reason)

    const verified = await verifySamlLogoutResponse(decoded.value, {
      expectedIssuer: SP_ENTITY_ID,
      expectedDestination: 'https://idp.example.com/slo',
      expectedInResponseTo: '_logout_req_1',
    })
    expect(verified.ok).toBe(false)
    if (!verified.ok) expect(verified.error.code).toBe('schema_invalid')
  })

  it.each([
    [
      'unknown attribute',
      (xml: string) => xml.replace('<samlp:LogoutResponse ', '<samlp:LogoutResponse Injected="1" '),
    ],
    [
      'invalid IssueInstant',
      (xml: string) => xml.replace(/ IssueInstant="[^"]*"/, ' IssueInstant="not-a-date"'),
    ],
  ])('rejects a POST LogoutResponse with %s', async (_label, mutate) => {
    const built = buildLogoutResponseXml({
      issuer: SP_ENTITY_ID,
      destination: 'https://idp.example.com/slo',
      inResponseTo: '_logout_req_1',
    })
    const verified = await verifySamlLogoutResponse(await signLogoutXml(mutate(built.xml)), {
      spCertificatesB64: [IDP_CERT_B64],
      expectedIssuer: SP_ENTITY_ID,
    })
    expect(verified.ok).toBe(false)
    if (!verified.ok) expect(verified.error.code).toBe('schema_invalid')
  })

  it('decodeSamlBindingPayload supports post binding base64', async () => {
    const xml = '<samlp:LogoutRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"/>'
    const encoded = btoa(xml)
    const decoded = await decodeSamlBindingPayload(encoded, 'post')
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) return
    expect(decoded.value).toContain('LogoutRequest')
  })

  it('accepts a Redirect payload at the 256 KiB decompressed boundary', async () => {
    const payload = 'x'.repeat(256 * 1024)
    const encoded = await encodeRedirectBindingMessage(payload)
    const decoded = await decodeSamlBindingPayload(encoded, 'redirect')
    expect(decoded).toEqual({ ok: true, value: payload })
  })

  it('rejects a compressed Redirect payload exceeding 256 KiB', async () => {
    const payload = 'x'.repeat(256 * 1024 + 1)
    const encoded = await encodeRedirectBindingMessage(payload)
    expect(atob(encoded).length).toBeLessThan(1024)

    const decoded = await decodeSamlBindingPayload(encoded, 'redirect')
    expect(decoded.ok).toBe(false)
    if (!decoded.ok) {
      expect(decoded.error.code).toBe('malformed_request')
      expect(decoded.error.reason).toContain('exceeds 256 KiB')
    }
  })
})
