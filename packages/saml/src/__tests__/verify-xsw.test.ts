// XSW 与结构白名单负测试:重复/注入 Assertion、扩展点、签名位置必须在验签前拒绝。

import { beforeAll, describe, expect, it } from 'vitest'
import { Parse, Stringify } from 'xmldsigjs'
import { setSamlEngine } from '../engine'
import { verifySamlResponse } from '../verify'
import { buildResponseXml } from './fixtures'
import {
  ASSERT_NS,
  DS_NS,
  directChild,
  extractSignedAssertion,
  forgedAssertion,
  injectBeforeAssertion,
  opts,
  signedMutatedResponse,
  signedResponse,
} from './verify-helpers'

describe('verifySamlResponse XSW (signature wrapping) defense', () => {
  beforeAll(() => {
    setSamlEngine(crypto)
  })

  function assertionOnly(over: Record<string, unknown> = {}) {
    return opts({ wantAuthnResponseSigned: false, wantAssertionsSigned: true, ...over })
  }

  it('rejects duplicated signed Assertion at the structural boundary', async () => {
    const signed = await signedResponse({}, { response: false, assertion: true })
    const clone = extractSignedAssertion(signed)
    const tampered = injectBeforeAssertion(signed, clone)
    const result = await verifySamlResponse(tampered, assertionOnly())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('schema_invalid')
  })

  it('rejects forged unsigned Assertion injected before the signed one', async () => {
    const signed = await signedResponse({}, { response: false, assertion: true })
    const evil = forgedAssertion('_evil_assert', 'attacker@evil.example.com')
    const tampered = injectBeforeAssertion(signed, evil)
    const result = await verifySamlResponse(tampered, assertionOnly())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('schema_invalid')
  })

  it('rejects when both want-signed flags are false (baseline forces assertion signature)', async () => {
    const unsigned = buildResponseXml()
    const result = await verifySamlResponse(
      unsigned,
      opts({ wantAuthnResponseSigned: false, wantAssertionsSigned: false }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('signature_required')
  })
})

describe('verifySamlResponse structural allowlist', () => {
  beforeAll(() => {
    setSamlEngine(crypto)
  })

  it.each([
    [
      'Response Extensions',
      (xml: string) =>
        xml.replace(
          '<samlp:Status>',
          '<samlp:Extensions><evil:Injected xmlns:evil="urn:evil"/></samlp:Extensions><samlp:Status>',
        ),
    ],
    [
      'unknown Assertion child',
      (xml: string) =>
        xml.replace(
          '<saml:AttributeStatement>',
          '<evil:Injected xmlns:evil="urn:evil"/><saml:AttributeStatement>',
        ),
    ],
    [
      'nested AttributeValue extension',
      (xml: string) =>
        xml.replace(
          '<saml:AttributeValue>Bjorn</saml:AttributeValue>',
          '<saml:AttributeValue><evil:Injected xmlns:evil="urn:evil"/>Bjorn</saml:AttributeValue>',
        ),
    ],
  ])('rejects signed %s', async (_label, mutate) => {
    const xml = await signedMutatedResponse(mutate)
    const result = await verifySamlResponse(xml, opts())

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('schema_invalid')
  })

  it('rejects ds:Object added outside SignedInfo', async () => {
    const doc = Parse(await signedResponse())
    const responseSignature = directChild(doc.documentElement, DS_NS, 'Signature')
    if (!responseSignature) throw new Error('Response Signature missing')
    const object = doc.createElementNS(DS_NS, 'ds:Object')
    object.appendChild(doc.createElementNS('urn:evil', 'evil:Injected'))
    responseSignature.appendChild(object)

    const result = await verifySamlResponse(Stringify(doc), opts())

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('schema_invalid')
  })

  it('rejects a Response Signature moved out of its fixed schema position', async () => {
    const doc = Parse(await signedResponse())
    const signature = directChild(doc.documentElement, DS_NS, 'Signature')
    if (!signature) throw new Error('Response Signature missing')
    doc.documentElement.appendChild(signature)

    const result = await verifySamlResponse(Stringify(doc), opts())

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('schema_invalid')
  })

  it('rejects an Assertion Signature moved out of its fixed schema position', async () => {
    const doc = Parse(await signedResponse({}, { response: false, assertion: true }))
    const assertion = directChild(doc.documentElement, ASSERT_NS, 'Assertion')
    if (!assertion) throw new Error('Assertion missing')
    const signature = directChild(assertion, DS_NS, 'Signature')
    if (!signature) throw new Error('Assertion Signature missing')
    assertion.appendChild(signature)

    const result = await verifySamlResponse(
      Stringify(doc),
      opts({ wantAuthnResponseSigned: false }),
    )

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('schema_invalid')
  })
})
