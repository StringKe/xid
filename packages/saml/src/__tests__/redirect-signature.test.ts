import { beforeAll, describe, expect, it } from 'vitest'
import { toBufferSource } from '@xid-kit/crypto'

import { loadIdpVerifyKey } from '../cert'
import { setSamlEngine } from '../engine'
import {
  buildRedirectBindingResponseSignatureString,
  buildRedirectBindingSignatureString,
  REDIRECT_BINDING_RSA_SHA256,
  signRedirectBindingRequest,
  signRedirectBindingResponse,
  verifyRedirectBindingSignature,
} from '../logout'
import { IDP_CERT_B64, importIdpSigningKey } from './fixtures'

const RSA_SHA1 = 'http://www.w3.org/2000/09/xmldsig#rsa-sha1'

function signatureInput(
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

function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
}

describe('SAML HTTP-Redirect signatures', () => {
  beforeAll(() => setSamlEngine(crypto))

  it('builds the OASIS request and response signature inputs with SigAlg last', () => {
    const encoded = 'base64+/='
    const relayState = ''
    expect(buildRedirectBindingSignatureString(encoded, relayState)).toBe(
      signatureInput('SAMLRequest', encoded, relayState, REDIRECT_BINDING_RSA_SHA256),
    )
    expect(buildRedirectBindingResponseSignatureString(encoded, relayState)).toBe(
      signatureInput('SAMLResponse', encoded, relayState, REDIRECT_BINDING_RSA_SHA256),
    )
  })

  it.each([
    ['request', 'SAMLRequest' as const, signRedirectBindingRequest],
    ['response', 'SAMLResponse' as const, signRedirectBindingResponse],
  ])('signs a Redirect binding %s using RSA-SHA256', async (_label, parameterName, sign) => {
    const encoded = 'encoded-message+/='
    const relayState = 'relay/state'
    const signed = await sign(encoded, relayState, await importIdpSigningKey())
    if (!signed.ok) throw new Error(signed.error.reason)

    const expectedInput = signatureInput(
      parameterName,
      encoded,
      relayState,
      REDIRECT_BINDING_RSA_SHA256,
    )
    expect(signed.value.sigAlg).toBe(REDIRECT_BINDING_RSA_SHA256)
    expect(signed.value.query).toBe(
      `${expectedInput}&Signature=${encodeURIComponent(signed.value.signature)}`,
    )

    const certificate = await loadIdpVerifyKey(IDP_CERT_B64)
    if (!certificate.ok) throw new Error(certificate.error.reason)
    await expect(
      crypto.subtle.verify(
        { name: 'RSASSA-PKCS1-v1_5' },
        certificate.value.publicKey,
        toBufferSource(decodeBase64(signed.value.signature)),
        new TextEncoder().encode(expectedInput),
      ),
    ).resolves.toBe(true)
  })

  it('rejects RSA-SHA1 even when a certificate is otherwise usable', async () => {
    const certificate = await loadIdpVerifyKey(IDP_CERT_B64)
    if (!certificate.ok) throw new Error(certificate.error.reason)
    const result = await verifyRedirectBindingSignature(
      signatureInput('SAMLRequest', 'encoded', undefined, RSA_SHA1),
      'AA==',
      RSA_SHA1,
      [certificate.value],
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('signature_invalid')
      expect(result.error.reason).toBe('unsupported SigAlg')
    }
  })
})
