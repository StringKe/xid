// verifySamlResponse EncryptedAssertion:decrypt-then-verify 端到端,含结构白名单对真实 IdP 加密参数的放行。

import { beforeAll, describe, expect, it } from 'vitest'
import { setSamlEngine } from '../engine'
import { verifySamlResponse } from '../verify'
import { buildResponseXml } from './fixtures'
import {
  AES128_CBC,
  AES256_GCM,
  DIGEST_SHA1,
  encryptedResponseXml,
  generateSpKeyMaterial,
} from './encryption-fixtures'
import type { EncryptOptions, SpKeyMaterial } from './encryption-fixtures'
import {
  extractSignedAssertion,
  opts,
  signStandaloneAssertion,
  standaloneAssertion,
} from './verify-helpers'

let material: SpKeyMaterial

function assertionOnly(over: Record<string, unknown> = {}) {
  return opts({ wantAuthnResponseSigned: false, wantAssertionsSigned: true, ...over })
}

async function encryptedSignedResponse(options: EncryptOptions = {}): Promise<string> {
  const unsigned = standaloneAssertion(extractSignedAssertion(buildResponseXml()))
  const assertion = await signStandaloneAssertion(unsigned)
  return encryptedResponseXml(assertion, material, options)
}

describe('verifySamlResponse EncryptedAssertion', () => {
  beforeAll(async () => {
    setSamlEngine(crypto)
    material = await generateSpKeyMaterial()
  })

  it('accepts a signed encrypted Assertion after decrypt-then-verify', async () => {
    const xml = await encryptedSignedResponse()

    const result = await verifySamlResponse(xml, assertionOnly({ spDecryptKey: material.provider }))

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.subject.nameId).toBe('user@example.com')
      expect(result.value.attributes.groups).toEqual(['eng', 'admin'])
      expect(result.value.signingCertFingerprint.length).toBeGreaterThan(0)
    }
  })

  it.each([
    [
      'inline key with SHA-1 DigestMethod and AES-128-CBC random padding',
      { digestMethod: DIGEST_SHA1, dataAlg: AES128_CBC, cbcPadding: 'iso10126' },
    ],
    ['peer EncryptedKey referenced by RetrievalMethod', { keyPlacement: 'peer-retrieval' }],
  ] as const)('accepts an IdP-style %s', async (_label, options) => {
    const xml = await encryptedSignedResponse(options)

    const result = await verifySamlResponse(xml, assertionOnly({ spDecryptKey: material.provider }))

    expect(result.ok).toBe(true)
  })

  it('decryption_failed when encrypted Assertion has no SP decrypt key', async () => {
    const xml = await encryptedSignedResponse()

    const result = await verifySamlResponse(xml, assertionOnly())

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('decryption_failed')
  })

  it('decryption_failed when encrypted Assertion uses a disallowed data algorithm', async () => {
    const xml = (await encryptedSignedResponse()).replace(
      AES256_GCM,
      'http://www.w3.org/2001/04/xmlenc#tripledes-cbc',
    )

    const result = await verifySamlResponse(xml, assertionOnly({ spDecryptKey: material.provider }))

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('decryption_failed')
  })

  it('signature_required when decrypted Assertion is unsigned', async () => {
    const unsignedAssertion = standaloneAssertion(extractSignedAssertion(buildResponseXml()))
    const xml = await encryptedResponseXml(unsignedAssertion, material)

    const result = await verifySamlResponse(xml, assertionOnly({ spDecryptKey: material.provider }))

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('signature_required')
  })

  it.each([
    [
      'an unknown EncryptedData extension',
      '</xenc:EncryptedData>',
      '<evil:Injected xmlns:evil="urn:evil"/></xenc:EncryptedData>',
    ],
    [
      'an unknown EncryptionMethod parameter',
      '<ds:DigestMethod',
      '<evil:Injected xmlns:evil="urn:evil"/><ds:DigestMethod',
    ],
  ])('schema_invalid when the response carries %s', async (_label, search, replacement) => {
    const xml = (await encryptedSignedResponse({ digestMethod: DIGEST_SHA1 })).replace(
      search,
      replacement,
    )

    const result = await verifySamlResponse(xml, assertionOnly({ spDecryptKey: material.provider }))

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('schema_invalid')
  })
})
