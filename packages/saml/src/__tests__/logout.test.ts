import { describe, it, expect, beforeAll } from 'vitest'
import { Parse, SignedXml, Stringify } from 'xmldsigjs'

import { setSamlEngine } from '../engine'
import {
  buildLogoutRequestXml,
  buildLogoutResponseXml,
  decodeSamlBindingPayload,
  verifySamlLogoutRequest,
} from '../logout'
import { IDP_CERT_B64, IDP_ENTITY_ID, importIdpSigningKey } from './fixtures'

const SLO_URL = 'https://acme.xid.dev/sso/saml/conn_1/slo'
const SP_ENTITY_ID = 'https://acme.xid.dev/saml/conn_1'

async function signLogoutRequestXml(xml: string): Promise<string> {
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
  root.appendChild(sig)
  return Stringify(doc)
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

  it('verifies signed LogoutRequest and extracts SessionIndex', async () => {
    const built = buildLogoutRequestXml({
      issuer: IDP_ENTITY_ID,
      destination: SLO_URL,
      nameId: 'user@example.com',
      nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:emailAddress',
      sessionIndex: '_session_abc',
    })
    const signed = await signLogoutRequestXml(built.xml)
    const verified = await verifySamlLogoutRequest(signed, {
      idpCertificatesB64: [IDP_CERT_B64],
      expectedIssuer: IDP_ENTITY_ID,
      expectedDestination: SLO_URL,
    })
    if (!verified.ok) {
      throw new Error(`${verified.error.code}: ${verified.error.reason}`)
    }
    expect(verified.value.requestId).toBe(built.requestId)
    expect(verified.value.sessionIndex).toBe('_session_abc')
    expect(verified.value.nameId).toBe('user@example.com')
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

  it('decodeSamlBindingPayload supports post binding base64', async () => {
    const xml = '<samlp:LogoutRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"/>'
    const encoded = btoa(xml)
    const decoded = await decodeSamlBindingPayload(encoded, 'post')
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) return
    expect(decoded.value).toContain('LogoutRequest')
  })
})
