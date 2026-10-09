// Response/Assertion 签名层组合:两层都要求时任一层有效即可,出现的签名必须有效,签名对象必须是被使用的断言。

import { beforeAll, describe, expect, it } from 'vitest'
import { Parse, Stringify } from 'xmldsigjs'
import { setSamlEngine } from '../engine'
import { verifySamlResponse } from '../verify'
import { buildResponseXml } from './fixtures'
import { ASSERT_NS, DS_NS, directChild, opts, signedResponse } from './verify-helpers'

const BOTH = { wantAuthnResponseSigned: true, wantAssertionsSigned: true }
const RESPONSE_ONLY = { wantAuthnResponseSigned: true, wantAssertionsSigned: false }
const ASSERTION_ONLY = { wantAuthnResponseSigned: false, wantAssertionsSigned: true }

function breakSignatureValue(signature: Element): void {
  const value = directChild(signature, DS_NS, 'SignatureValue')
  if (!value) throw new Error('SignatureValue missing')
  const text = value.textContent ?? ''
  value.textContent = `${text.startsWith('A') ? 'B' : 'A'}${text.slice(1)}`
}

describe('verifySamlResponse signature layers', () => {
  beforeAll(() => {
    setSamlEngine(crypto)
  })

  it.each([
    ['Response only', { response: true, assertion: false }],
    ['Assertion only', { response: false, assertion: true }],
    ['Response and Assertion', { response: true, assertion: true }],
  ])('accepts a %s signature when both layers are configured', async (_label, signOpts) => {
    const xml = await signedResponse({}, signOpts)

    const result = await verifySamlResponse(xml, opts(BOTH))

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.signingCertFingerprint.length).toBeGreaterThan(0)
  })

  it('signature_required when both layers are configured and neither is signed', async () => {
    const result = await verifySamlResponse(buildResponseXml(), opts(BOTH))

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('signature_required')
  })

  it('signature_required when only Response signing is configured and only the Assertion is signed', async () => {
    const xml = await signedResponse({}, { response: false, assertion: true })

    const result = await verifySamlResponse(xml, opts(RESPONSE_ONLY))

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('signature_required')
  })

  it('accepts a Response-only signature when only Response signing is configured', async () => {
    const xml = await signedResponse({}, { response: true, assertion: false })

    const result = await verifySamlResponse(xml, opts(RESPONSE_ONLY))

    expect(result.ok).toBe(true)
  })

  it('signature_required when only Assertion signing is configured and only the Response is signed', async () => {
    const xml = await signedResponse({}, { response: true, assertion: false })

    const result = await verifySamlResponse(xml, opts(ASSERTION_ONLY))

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('signature_required')
  })

  it('signature_invalid when the Assertion is tampered after a Response-only signature', async () => {
    const signed = await signedResponse({}, { response: true, assertion: false })
    const tampered = signed.replace(
      '>user@example.com</saml:NameID>',
      '>attacker@evil.example.com</saml:NameID>',
    )

    const result = await verifySamlResponse(tampered, opts(BOTH))

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('signature_invalid')
  })

  it('signature_invalid when the Assertion signature is broken even though the Response signature is valid', async () => {
    const doc = Parse(await signedResponse({}, { response: true, assertion: true }))
    const assertion = directChild(doc.documentElement, ASSERT_NS, 'Assertion')
    const signature = assertion ? directChild(assertion, DS_NS, 'Signature') : undefined
    if (!signature) throw new Error('Assertion Signature missing')
    breakSignatureValue(signature)

    const result = await verifySamlResponse(Stringify(doc), opts(BOTH))

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('signature_invalid')
  })

  it('signature_invalid when a Response-level Signature references the Assertion instead of the Response', async () => {
    const doc = Parse(await signedResponse({}, { response: false, assertion: true }))
    const root = doc.documentElement
    const assertion = directChild(root, ASSERT_NS, 'Assertion')
    const signature = assertion ? directChild(assertion, DS_NS, 'Signature') : undefined
    const issuer = directChild(root, ASSERT_NS, 'Issuer')
    if (!signature || !issuer) throw new Error('fixture elements missing')
    root.insertBefore(signature, issuer.nextSibling)

    const result = await verifySamlResponse(Stringify(doc), opts(BOTH))

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('signature_invalid')
  })
})
