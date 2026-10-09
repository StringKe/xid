// EncryptedAssertion 解密:OAEP 摘要组合、AES-GCM/CBC(含 ISO 10126 随机填充)、EncryptedKey 放置方式。

import { beforeAll, describe, it, expect } from 'vitest'
import { Parse } from 'xmldsigjs'

import { setSamlEngine } from '../engine'
import { decryptEncryptedAssertion, hasEncryptedAssertion, plaintextAssertion } from '../decrypt'
import { ACS_URL, IDP_ENTITY_ID, SP_ENTITY_ID } from './fixtures'
import {
  AES128_CBC,
  AES128_GCM,
  AES256_CBC,
  AES256_GCM,
  DIGEST_SHA1,
  DIGEST_SHA256,
  MGF1_SHA1,
  MGF1_SHA256,
  RSA_OAEP_11,
  encryptedResponseXml,
  generateSpKeyMaterial,
} from './encryption-fixtures'
import type { EncryptOptions, SpKeyMaterial } from './encryption-fixtures'

const SAMLP_NS = 'urn:oasis:names:tc:SAML:2.0:protocol'
const ASSERT_NS = 'urn:oasis:names:tc:SAML:2.0:assertion'

function minimalAssertionXml(): string {
  return [
    `<saml:Assertion xmlns:saml="${ASSERT_NS}" ID="_assert_1" Version="2.0" IssueInstant="2026-06-01T08:00:00Z">`,
    `<saml:Issuer>${IDP_ENTITY_ID}</saml:Issuer>`,
    `<saml:Subject><saml:NameID>user@example.com</saml:NameID></saml:Subject>`,
    `<saml:Conditions NotBefore="2026-06-01T00:00:00Z" NotOnOrAfter="2030-06-01T00:00:00Z">`,
    `<saml:AudienceRestriction><saml:Audience>${SP_ENTITY_ID}</saml:Audience></saml:AudienceRestriction>`,
    `</saml:Conditions></saml:Assertion>`,
  ].join('')
}

function plaintextResponse(assertionXml: string): Element {
  const xml = [
    `<samlp:Response xmlns:samlp="${SAMLP_NS}" xmlns:saml="${ASSERT_NS}"`,
    ` ID="_resp_plain" Version="2.0" IssueInstant="2026-06-01T08:00:00Z" Destination="${ACS_URL}">`,
    `<saml:Issuer>${IDP_ENTITY_ID}</saml:Issuer>`,
    `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>`,
    assertionXml,
    `</samlp:Response>`,
  ].join('')
  return Parse(xml).documentElement
}

let material: SpKeyMaterial

async function decrypt(options: EncryptOptions, keys: SpKeyMaterial = material) {
  const xml = await encryptedResponseXml(minimalAssertionXml(), material, options)
  return decryptEncryptedAssertion(Parse(xml).documentElement, keys.provider)
}

describe('hasEncryptedAssertion / plaintextAssertion', () => {
  beforeAll(() => {
    setSamlEngine(crypto)
  })

  it('detects encrypted vs plaintext assertion roots', () => {
    const plain = plaintextResponse(minimalAssertionXml())

    expect(hasEncryptedAssertion(plain)).toBe(false)
    expect(plaintextAssertion(plain)?.localName).toBe('Assertion')
  })
})

describe('decryptEncryptedAssertion key transport', () => {
  beforeAll(async () => {
    setSamlEngine(crypto)
    material = await generateSpKeyMaterial()
  })

  it('decrypts rsa-oaep-mgf1p with the default SHA-1 digest (Okta and ADFS defaults)', async () => {
    const result = await decrypt({})

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toContain('user@example.com')
  })

  it('decrypts rsa-oaep-mgf1p with an explicit SHA-1 DigestMethod (Shibboleth default)', async () => {
    const result = await decrypt({ digestMethod: DIGEST_SHA1, dataAlg: AES128_GCM })

    expect(result.ok).toBe(true)
  })

  it('decrypts xmlenc11 rsa-oaep with SHA-256 digest and MGF1-SHA-256', async () => {
    const result = await decrypt({
      keyWrapAlg: RSA_OAEP_11,
      wrapHash: 'SHA-256',
      digestMethod: DIGEST_SHA256,
      mgf: MGF1_SHA256,
    })

    expect(result.ok).toBe(true)
  })

  it('decrypts xmlenc11 rsa-oaep with defaults (SHA-1 digest and MGF1-SHA-1)', async () => {
    const result = await decrypt({ keyWrapAlg: RSA_OAEP_11, mgf: MGF1_SHA1 })

    expect(result.ok).toBe(true)
  })

  it('decrypts with an OAEPparams label', async () => {
    const result = await decrypt({ oaepLabel: new TextEncoder().encode('xid-label') })

    expect(result.ok).toBe(true)
  })

  it.each([
    [
      'rsa-oaep-mgf1p with a SHA-256 DigestMethod',
      { wrapHash: 'SHA-256', digestMethod: DIGEST_SHA256 },
    ],
    [
      'xmlenc11 rsa-oaep with SHA-256 digest and default MGF1-SHA-1',
      { keyWrapAlg: RSA_OAEP_11, wrapHash: 'SHA-256', digestMethod: DIGEST_SHA256 },
    ],
  ] as const)('rejects %s that Web Crypto cannot express', async (_label, options) => {
    const result = await decrypt(options)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.reason).toContain('not supported by Web Crypto')
  })

  it('fails when the IdP wrapped with SHA-256 but labelled the key as rsa-oaep-mgf1p', async () => {
    const result = await decrypt({ wrapHash: 'SHA-256' })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('decryption_failed')
  })

  it('fails when the key-wrap algorithm is not allowed', async () => {
    const result = await decrypt({ keyWrapAlg: 'http://www.w3.org/2001/04/xmlenc#rsa-1_5' })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.reason).toContain('key-wrap alg not allowed')
  })

  it('fails when the SP private key does not match the wrapped session key', async () => {
    const other = await generateSpKeyMaterial()

    const result = await decrypt({}, other)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('decryption_failed')
  })
})

describe('decryptEncryptedAssertion data encryption', () => {
  beforeAll(async () => {
    setSamlEngine(crypto)
    material ??= await generateSpKeyMaterial()
  })

  it.each([
    ['AES-128-CBC with PKCS#7 padding', { dataAlg: AES128_CBC, cbcPadding: 'pkcs7' }],
    ['AES-128-CBC with ISO 10126 random padding', { dataAlg: AES128_CBC, cbcPadding: 'iso10126' }],
    ['AES-256-CBC with ISO 10126 random padding', { dataAlg: AES256_CBC, cbcPadding: 'iso10126' }],
    ['AES-128-GCM', { dataAlg: AES128_GCM }],
    ['AES-256-GCM', { dataAlg: AES256_GCM }],
  ] as const)('decrypts %s', async (_label, options) => {
    const result = await decrypt(options)

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toBe(minimalAssertionXml())
  })

  it.each([
    ['zero', 0],
    ['larger than a block', 17],
  ])('fails when the CBC padding length byte is %s', async (_label, lastByte) => {
    const result = await decrypt({ dataAlg: AES128_CBC, cbcPadding: { lastByte } })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('decryption_failed')
  })

  it('fails when the session key length does not match the data algorithm', async () => {
    const result = await decrypt({ dataAlg: AES128_GCM, sessionKeyBytes: 32 })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.reason).toContain('session key length')
  })

  it('fails when the data encryption algorithm is not allowed', async () => {
    const result = await decrypt({ dataAlg: 'http://www.w3.org/2001/04/xmlenc#tripledes-cbc' })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.reason).toContain('data alg not allowed')
  })

  it('fails when EncryptedAssertion is missing', async () => {
    const result = await decryptEncryptedAssertion(
      plaintextResponse(minimalAssertionXml()),
      material.provider,
    )

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('decryption_failed')
  })
})

describe('decryptEncryptedAssertion EncryptedKey placement', () => {
  beforeAll(async () => {
    setSamlEngine(crypto)
    material ??= await generateSpKeyMaterial()
  })

  it.each([
    ['a peer EncryptedKey referenced by RetrievalMethod', 'peer-retrieval'],
    ['a single peer EncryptedKey without KeyInfo', 'peer'],
  ] as const)('decrypts %s', async (_label, keyPlacement) => {
    const result = await decrypt({ keyPlacement })

    expect(result.ok).toBe(true)
  })

  it('fails when RetrievalMethod points at an unknown EncryptedKey id', async () => {
    const xml = (
      await encryptedResponseXml(minimalAssertionXml(), material, {
        keyPlacement: 'peer-retrieval',
      })
    ).replace('URI="#_ek_1"', 'URI="#_ek_missing"')

    const result = await decryptEncryptedAssertion(Parse(xml).documentElement, material.provider)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('decryption_failed')
  })
})
