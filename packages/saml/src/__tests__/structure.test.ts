import { beforeAll, describe, it, expect } from 'vitest'
import { Parse } from 'xmldsigjs'

import { setSamlEngine } from '../engine'
import { selectSingleSignature } from '../structure'
import { buildResponseXml, importIdpSigningKey, signResponse } from './fixtures'

const ASSERT_NS = 'urn:oasis:names:tc:SAML:2.0:assertion'

describe('selectSingleSignature', () => {
  beforeAll(() => setSamlEngine(crypto))

  it('requires a direct ds:Signature child', async () => {
    const doc = Parse(buildResponseXml())
    const assertion = doc.getElementsByTagNameNS(ASSERT_NS, 'Assertion').item(0)
    if (!assertion) throw new Error('assertion missing')
    const result = selectSingleSignature(assertion)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('signature_required')
  })

  it('accepts a single enveloped signature child', async () => {
    const key = await importIdpSigningKey()
    const xml = await signResponse(buildResponseXml(), key, { response: false, assertion: true })
    const doc = Parse(xml)
    const assertion = doc.getElementsByTagNameNS(ASSERT_NS, 'Assertion').item(0)
    if (!assertion) throw new Error('assertion missing')
    const result = selectSingleSignature(assertion)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.signature.localName).toBe('Signature')
  })
})
