import { beforeAll, describe, it, expect } from 'vitest'
import { Parse } from 'xmldsigjs'

import { setSamlEngine } from '../engine'
import { validateAssertionSemantics } from '../semantics'
import {
  ACS_URL,
  IDP_ENTITY_ID,
  IDP_CERT_VALID_NOW,
  SP_ENTITY_ID,
  buildResponseXml,
  importIdpSigningKey,
  signResponse,
} from './fixtures'

const NOW = IDP_CERT_VALID_NOW
const ASSERT_NS = 'urn:oasis:names:tc:SAML:2.0:assertion'

async function signedParts(parts: Record<string, unknown> = {}) {
  const key = await importIdpSigningKey()
  const xml = await signResponse(buildResponseXml(parts), key, { response: true, assertion: true })
  const doc = Parse(xml)
  const assertion = doc.getElementsByTagNameNS(ASSERT_NS, 'Assertion').item(0)
  if (!assertion) throw new Error('assertion missing')
  return { responseRoot: doc.documentElement, assertion }
}

describe('validateAssertionSemantics', () => {
  beforeAll(() => setSamlEngine(crypto))

  it('accepts a valid SP-initiated assertion with InResponseTo', async () => {
    const { responseRoot, assertion } = await signedParts({
      inResponseTo: '_req_123',
      destination: ACS_URL,
    })
    const result = validateAssertionSemantics({
      responseRoot,
      assertion,
      expectedIssuer: IDP_ENTITY_ID,
      expectedAudience: SP_ENTITY_ID,
      acsUrl: ACS_URL,
      spInitiated: true,
      now: NOW,
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.inResponseTo).toBe('_req_123')
  })

  it('rejects IdP-initiated assertion that unexpectedly carries InResponseTo', async () => {
    const { responseRoot, assertion } = await signedParts({ inResponseTo: '_req_123' })
    const result = validateAssertionSemantics({
      responseRoot,
      assertion,
      expectedIssuer: IDP_ENTITY_ID,
      expectedAudience: SP_ENTITY_ID,
      acsUrl: ACS_URL,
      spInitiated: false,
      now: NOW,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('recipient_mismatch')
  })

  it('rejects assertion with NotBefore in the future beyond skew', async () => {
    const { responseRoot, assertion } = await signedParts({
      notBefore: '2026-06-01T09:00:00Z',
      notOnOrAfter: '2026-06-01T10:00:00Z',
      subjConfirmExpiry: '2026-06-01T10:00:00Z',
    })
    const result = validateAssertionSemantics({
      responseRoot,
      assertion,
      expectedIssuer: IDP_ENTITY_ID,
      expectedAudience: SP_ENTITY_ID,
      acsUrl: ACS_URL,
      spInitiated: false,
      now: NOW,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('assertion_expired')
  })

  it('rejects missing Assertion ID', async () => {
    const { responseRoot, assertion } = await signedParts()
    assertion.removeAttribute('ID')
    const result = validateAssertionSemantics({
      responseRoot,
      assertion,
      expectedIssuer: IDP_ENTITY_ID,
      expectedAudience: SP_ENTITY_ID,
      acsUrl: ACS_URL,
      spInitiated: false,
      now: NOW,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('signature_invalid')
  })
})
