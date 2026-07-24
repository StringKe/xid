import { beforeAll, describe, it, expect } from 'vitest'
import { toBufferSource } from '@xid-kit/crypto'
import { Parse } from 'xmldsigjs'

import { setSamlEngine } from '../engine'
import { decryptEncryptedAssertion, hasEncryptedAssertion, plaintextAssertion } from '../decrypt'
import { ACS_URL, IDP_ENTITY_ID, SP_ENTITY_ID } from './fixtures'

const SAMLP_NS = 'urn:oasis:names:tc:SAML:2.0:protocol'
const ASSERT_NS = 'urn:oasis:names:tc:SAML:2.0:assertion'
const DS_NS = 'http://www.w3.org/2000/09/xmldsig#'
const XENC_NS = 'http://www.w3.org/2001/04/xmlenc#'
const RSA_OAEP = 'http://www.w3.org/2001/04/xmlenc#rsa-oaep-mgf1p'
const AES256_GCM = 'http://www.w3.org/2009/xmlenc11#aes256-gcm'
const AES128_CBC = 'http://www.w3.org/2001/04/xmlenc#aes128-cbc'

function b64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}

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

async function generateSpDecryptKeyPair(): Promise<CryptoKeyPair> {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: 'RSA-OAEP',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['encrypt', 'decrypt'],
  )
  if ('publicKey' in keyPair) return keyPair
  throw new Error('expected RSA-OAEP key pair')
}

async function encryptedResponseXml(input: {
  assertionXml: string
  spPublicKey: CryptoKey
  dataAlg?: string
  keyWrapAlg?: string
}): Promise<string> {
  const sessionKeyRaw =
    input.dataAlg === AES128_CBC
      ? crypto.getRandomValues(new Uint8Array(16))
      : crypto.getRandomValues(new Uint8Array(32))
  const iv =
    input.dataAlg === AES128_CBC
      ? crypto.getRandomValues(new Uint8Array(16))
      : crypto.getRandomValues(new Uint8Array(12))
  const aesName = input.dataAlg === AES128_CBC ? 'AES-CBC' : 'AES-GCM'
  const aesKey = await crypto.subtle.importKey(
    'raw',
    toBufferSource(sessionKeyRaw),
    { name: aesName },
    false,
    ['encrypt'],
  )
  const encryptedAssertion = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: aesName, iv: toBufferSource(iv) },
      aesKey,
      new TextEncoder().encode(input.assertionXml),
    ),
  )
  const wrappedKey = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'RSA-OAEP' },
      input.spPublicKey,
      toBufferSource(sessionKeyRaw),
    ),
  )
  const dataAlg = input.dataAlg ?? AES256_GCM
  const keyWrapAlg = input.keyWrapAlg ?? RSA_OAEP
  return [
    `<samlp:Response xmlns:samlp="${SAMLP_NS}" xmlns:saml="${ASSERT_NS}" xmlns:xenc="${XENC_NS}" xmlns:ds="${DS_NS}"`,
    ` ID="_resp_encrypted" Version="2.0" IssueInstant="2026-06-01T08:00:00Z" Destination="${ACS_URL}">`,
    `<saml:Issuer>${IDP_ENTITY_ID}</saml:Issuer>`,
    `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>`,
    `<saml:EncryptedAssertion><xenc:EncryptedData Type="http://www.w3.org/2001/04/xmlenc#Element">`,
    `<xenc:EncryptionMethod Algorithm="${dataAlg}"/>`,
    `<ds:KeyInfo><xenc:EncryptedKey><xenc:EncryptionMethod Algorithm="${keyWrapAlg}"/>`,
    `<xenc:CipherData><xenc:CipherValue>${b64(wrappedKey)}</xenc:CipherValue></xenc:CipherData>`,
    `</xenc:EncryptedKey></ds:KeyInfo>`,
    `<xenc:CipherData><xenc:CipherValue>${b64(concatBytes(iv, encryptedAssertion))}</xenc:CipherValue></xenc:CipherData>`,
    `</xenc:EncryptedData></saml:EncryptedAssertion></samlp:Response>`,
  ].join('')
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

describe('decryptEncryptedAssertion', () => {
  beforeAll(() => {
    setSamlEngine(crypto)
  })

  it('decrypts AES-256-GCM encrypted assertion XML', async () => {
    const keyPair = await generateSpDecryptKeyPair()
    const assertionXml = minimalAssertionXml()
    const xml = await encryptedResponseXml({
      assertionXml,
      spPublicKey: keyPair.publicKey,
    })
    const root = Parse(xml).documentElement
    const result = await decryptEncryptedAssertion(root, keyPair.privateKey)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toContain('user@example.com')
  })

  it('decrypts AES-128-CBC encrypted assertion XML', async () => {
    const keyPair = await generateSpDecryptKeyPair()
    const assertionXml = minimalAssertionXml()
    const xml = await encryptedResponseXml({
      assertionXml,
      spPublicKey: keyPair.publicKey,
      dataAlg: AES128_CBC,
    })
    const root = Parse(xml).documentElement
    const result = await decryptEncryptedAssertion(root, keyPair.privateKey)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toContain('<saml:Assertion')
  })

  it('fails when EncryptedAssertion is missing', async () => {
    const keyPair = await generateSpDecryptKeyPair()
    const root = plaintextResponse(minimalAssertionXml())
    const result = await decryptEncryptedAssertion(root, keyPair.privateKey)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('decryption_failed')
  })

  it('fails when key-wrap algorithm is not allowed', async () => {
    const keyPair = await generateSpDecryptKeyPair()
    const xml = await encryptedResponseXml({
      assertionXml: minimalAssertionXml(),
      spPublicKey: keyPair.publicKey,
      keyWrapAlg: 'http://www.w3.org/2001/04/xmlenc#rsa-1_5',
    })
    const root = Parse(xml).documentElement
    const result = await decryptEncryptedAssertion(root, keyPair.privateKey)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.reason).toContain('key-wrap alg not allowed')
  })

  it('fails when data encryption algorithm is not allowed', async () => {
    const keyPair = await generateSpDecryptKeyPair()
    const xml = await encryptedResponseXml({
      assertionXml: minimalAssertionXml(),
      spPublicKey: keyPair.publicKey,
      dataAlg: 'http://www.w3.org/2001/04/xmlenc#tripledes-cbc',
    })
    const root = Parse(xml).documentElement
    const result = await decryptEncryptedAssertion(root, keyPair.privateKey)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.reason).toContain('data alg not allowed')
  })

  it('fails when SP private key does not match wrapped session key', async () => {
    const encryptPair = await generateSpDecryptKeyPair()
    const wrongPair = await generateSpDecryptKeyPair()
    const xml = await encryptedResponseXml({
      assertionXml: minimalAssertionXml(),
      spPublicKey: encryptPair.publicKey,
    })
    const root = Parse(xml).documentElement
    const result = await decryptEncryptedAssertion(root, wrongPair.privateKey)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('decryption_failed')
  })
})
