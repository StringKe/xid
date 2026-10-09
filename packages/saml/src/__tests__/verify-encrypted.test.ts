// verifySamlResponse EncryptedAssertion:decrypt-then-verify 端到端。

import { beforeAll, describe, expect, it } from 'vitest'
import { toBufferSource } from '@xid-kit/crypto'
import { setSamlEngine } from '../engine'
import { verifySamlResponse } from '../verify'
import { ACS_URL, IDP_ENTITY_ID, buildResponseXml } from './fixtures'
import {
  ASSERT_NS,
  DS_NS,
  SAMLP_NS,
  XENC_NS,
  b64,
  concatBytes,
  extractSignedAssertion,
  opts,
  signStandaloneAssertion,
  standaloneAssertion,
} from './verify-helpers'

const RSA_OAEP = 'http://www.w3.org/2001/04/xmlenc#rsa-oaep-mgf1p'
const AES256_GCM = 'http://www.w3.org/2009/xmlenc11#aes256-gcm'

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

async function encryptedAssertionResponse(
  assertionXml: string,
  spPublicKey: CryptoKey,
): Promise<string> {
  const sessionKeyRaw = crypto.getRandomValues(new Uint8Array(32))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const aesKey = await crypto.subtle.importKey(
    'raw',
    toBufferSource(sessionKeyRaw),
    { name: 'AES-GCM' },
    false,
    ['encrypt'],
  )
  const encryptedAssertion = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: toBufferSource(iv) },
      aesKey,
      new TextEncoder().encode(assertionXml),
    ),
  )
  const wrappedKey = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, spPublicKey, toBufferSource(sessionKeyRaw)),
  )
  const cipherValue = b64(concatBytes(iv, encryptedAssertion))
  const keyCipherValue = b64(wrappedKey)
  return [
    `<samlp:Response xmlns:samlp="${SAMLP_NS}" xmlns:saml="${ASSERT_NS}" xmlns:xenc="${XENC_NS}" xmlns:ds="${DS_NS}"`,
    ` ID="_resp_encrypted" Version="2.0" IssueInstant="2026-06-01T08:00:00Z" Destination="${ACS_URL}">`,
    `<saml:Issuer>${IDP_ENTITY_ID}</saml:Issuer>`,
    `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>`,
    `<saml:EncryptedAssertion><xenc:EncryptedData Type="http://www.w3.org/2001/04/xmlenc#Element">`,
    `<xenc:EncryptionMethod Algorithm="${AES256_GCM}"/>`,
    `<ds:KeyInfo><xenc:EncryptedKey><xenc:EncryptionMethod Algorithm="${RSA_OAEP}"/>`,
    `<xenc:CipherData><xenc:CipherValue>${keyCipherValue}</xenc:CipherValue></xenc:CipherData>`,
    `</xenc:EncryptedKey></ds:KeyInfo>`,
    `<xenc:CipherData><xenc:CipherValue>${cipherValue}</xenc:CipherValue></xenc:CipherData>`,
    `</xenc:EncryptedData></saml:EncryptedAssertion></samlp:Response>`,
  ].join('')
}

function assertionOnly(over: Record<string, unknown> = {}) {
  return opts({ wantAuthnResponseSigned: false, wantAssertionsSigned: true, ...over })
}

describe('verifySamlResponse EncryptedAssertion', () => {
  beforeAll(() => {
    setSamlEngine(crypto)
  })

  async function encryptedSignedResponse() {
    const spKeyPair = await generateSpDecryptKeyPair()
    const unsigned = standaloneAssertion(extractSignedAssertion(buildResponseXml()))
    const assertion = await signStandaloneAssertion(unsigned)
    const xml = await encryptedAssertionResponse(assertion, spKeyPair.publicKey)
    return { xml, privateKey: spKeyPair.privateKey }
  }

  it('accepts a signed encrypted Assertion after decrypt-then-verify', async () => {
    const { xml, privateKey } = await encryptedSignedResponse()
    const result = await verifySamlResponse(xml, assertionOnly({ spDecryptKey: privateKey }))

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.subject.nameId).toBe('user@example.com')
      expect(result.value.attributes.groups).toEqual(['eng', 'admin'])
      expect(result.value.signingCertFingerprint.length).toBeGreaterThan(0)
    }
  })

  it('decryption_failed when encrypted Assertion has no SP decrypt key', async () => {
    const { xml } = await encryptedSignedResponse()
    const result = await verifySamlResponse(xml, assertionOnly())

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('decryption_failed')
  })

  it('decryption_failed when encrypted Assertion uses a disallowed data algorithm', async () => {
    const { xml, privateKey } = await encryptedSignedResponse()
    const tampered = xml.replace(AES256_GCM, 'http://www.w3.org/2001/04/xmlenc#tripledes-cbc')
    const result = await verifySamlResponse(tampered, assertionOnly({ spDecryptKey: privateKey }))

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('decryption_failed')
  })

  it('signature_required when decrypted Assertion is unsigned', async () => {
    const spKeyPair = await generateSpDecryptKeyPair()
    const unsignedAssertion = standaloneAssertion(extractSignedAssertion(buildResponseXml()))
    const xml = await encryptedAssertionResponse(unsignedAssertion, spKeyPair.publicKey)
    const result = await verifySamlResponse(
      xml,
      assertionOnly({ spDecryptKey: spKeyPair.privateKey }),
    )

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('signature_required')
  })

  it('schema_invalid when EncryptedData contains an unknown extension', async () => {
    const { xml, privateKey } = await encryptedSignedResponse()
    const tampered = xml.replace(
      '</xenc:EncryptedData>',
      '<evil:Injected xmlns:evil="urn:evil"/></xenc:EncryptedData>',
    )
    const result = await verifySamlResponse(tampered, assertionOnly({ spDecryptKey: privateKey }))

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('schema_invalid')
  })
})
