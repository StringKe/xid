import { beforeAll, describe, it, expect } from 'vitest'
import { fromBER } from 'asn1js'
import { Certificate } from 'pkijs'
import { toBufferSource } from '@xid-kit/crypto'

import { setSamlEngine } from '../engine'
import {
  DEFAULT_SAML_CLOCK_SKEW_MS,
  generateSelfSignedSamlCertificate,
  loadIdpVerifyKey,
  loadIdpVerifyKeys,
} from '../cert'
import { certificateWithValidity, IDP_CERT_B64, IDP_CERT_VALID_NOW } from './fixtures'

describe('loadIdpVerifyKey', () => {
  beforeAll(() => setSamlEngine(crypto))

  it('loads RSA verify key and SHA-256 fingerprint from DER cert', async () => {
    const result = await loadIdpVerifyKey(IDP_CERT_B64)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.publicKey.type).toBe('public')
      expect(result.value.fingerprint).toMatch(/^[0-9A-F]{2}(:[0-9A-F]{2})+$/)
      expect(result.value.notBefore).toBeLessThanOrEqual(IDP_CERT_VALID_NOW)
      expect(result.value.notAfter).toBeGreaterThan(IDP_CERT_VALID_NOW)
    }
  })

  it('rejects malformed certificate input', async () => {
    const result = await loadIdpVerifyKey('not-a-cert')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('signature_invalid')
  })
})

describe('generateSelfSignedSamlCertificate', () => {
  beforeAll(() => setSamlEngine(crypto))

  it('generates a one-year RSA 2048 self-signed certificate and PKCS#8 key', async () => {
    const now = Date.parse('2026-06-01T08:00:00Z')
    const generated = await generateSelfSignedSamlCertificate('saml.example.com', now)
    if (!generated.ok) throw new Error(generated.error.reason)

    expect(generated.value.notBefore).toBe(now)
    expect(generated.value.notAfter - generated.value.notBefore).toBe(365 * 24 * 60 * 60 * 1000)
    expect(generated.value.fingerprint).toMatch(/^[0-9A-F]{2}(:[0-9A-F]{2})+$/)

    const certificateDer = Uint8Array.from(atob(generated.value.certificateB64), (character) =>
      character.charCodeAt(0),
    )
    const asn1 = fromBER(toBufferSource(certificateDer))
    if (asn1.offset === -1) throw new Error('generated certificate is not valid DER')
    const certificate = new Certificate({ schema: asn1.result })
    await expect(certificate.verify(certificate)).resolves.toBe(true)
    expect(certificate.subject.typesAndValues[0]?.value.valueBlock.value).toBe('saml.example.com')

    const loaded = await loadIdpVerifyKey(generated.value.certificateB64)
    if (!loaded.ok) throw new Error(loaded.error.reason)
    expect(loaded.value.fingerprint).toBe(generated.value.fingerprint)
    expect((loaded.value.publicKey.algorithm as RsaHashedKeyAlgorithm).modulusLength).toBe(2048)

    const privateKey = await crypto.subtle.importKey(
      'pkcs8',
      toBufferSource(generated.value.privateKeyPkcs8),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign'],
    )
    const payload = new TextEncoder().encode('saml-certificate-key-match')
    const signature = await crypto.subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, privateKey, payload)
    await expect(
      crypto.subtle.verify(
        { name: 'RSASSA-PKCS1-v1_5' },
        loaded.value.publicKey,
        signature,
        payload,
      ),
    ).resolves.toBe(true)
  })

  it('rejects an empty or overlong common name', async () => {
    await expect(generateSelfSignedSamlCertificate('   ')).resolves.toMatchObject({
      ok: false,
      error: { code: 'malformed_request' },
    })
    await expect(generateSelfSignedSamlCertificate('x'.repeat(65))).resolves.toMatchObject({
      ok: false,
      error: { code: 'malformed_request' },
    })
  })

  it('uses bounded verifier tolerance for an immediately active notBefore', async () => {
    const issuedAt = Date.parse('2026-06-01T08:00:00Z')
    const generated = await generateSelfSignedSamlCertificate('saml.example.com', issuedAt)
    if (!generated.ok) throw new Error(generated.error.reason)

    const withinTolerance = await loadIdpVerifyKeys([generated.value.certificateB64], {
      now: issuedAt - DEFAULT_SAML_CLOCK_SKEW_MS,
      toleranceMs: DEFAULT_SAML_CLOCK_SKEW_MS,
    })
    expect(withinTolerance.ok).toBe(true)

    const outsideTolerance = await loadIdpVerifyKeys([generated.value.certificateB64], {
      now: issuedAt - DEFAULT_SAML_CLOCK_SKEW_MS - 1,
      toleranceMs: DEFAULT_SAML_CLOCK_SKEW_MS,
    })
    expect(outsideTolerance.ok).toBe(false)
  })
})

describe('loadIdpVerifyKeys', () => {
  beforeAll(() => setSamlEngine(crypto))

  it('skips bad certs and keeps usable ones', async () => {
    const result = await loadIdpVerifyKeys(['bad-cert', IDP_CERT_B64])
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toHaveLength(1)
  })

  it('fails when no cert is usable', async () => {
    const result = await loadIdpVerifyKeys(['bad-cert'])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('signature_invalid')
  })

  it('rejects expired and not-yet-valid certificates outside tolerance', async () => {
    const now = IDP_CERT_VALID_NOW
    const expired = certificateWithValidity(
      IDP_CERT_B64,
      now - 2 * 60 * 60 * 1000,
      now - DEFAULT_SAML_CLOCK_SKEW_MS - 1,
    )
    const future = certificateWithValidity(
      IDP_CERT_B64,
      now + DEFAULT_SAML_CLOCK_SKEW_MS + 2_000,
      now + 2 * 60 * 60 * 1000,
    )

    const expiredResult = await loadIdpVerifyKeys([expired], { now })
    const futureResult = await loadIdpVerifyKeys([future], { now })

    expect(expiredResult.ok).toBe(false)
    expect(futureResult.ok).toBe(false)
  })

  it('keeps all currently valid certificates during a rotation overlap', async () => {
    const now = IDP_CERT_VALID_NOW
    const oldCertificate = certificateWithValidity(
      IDP_CERT_B64,
      now - 24 * 60 * 60 * 1000,
      now + 60 * 60 * 1000,
    )
    const newCertificate = certificateWithValidity(
      IDP_CERT_B64,
      now - 60 * 60 * 1000,
      now + 24 * 60 * 60 * 1000,
    )

    const result = await loadIdpVerifyKeys([oldCertificate, newCertificate], {
      now,
      toleranceMs: 0,
    })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toHaveLength(2)
  })

  it('accepts a certificate inside the configured tolerance boundary', async () => {
    const now = IDP_CERT_VALID_NOW
    const future = certificateWithValidity(
      IDP_CERT_B64,
      now + DEFAULT_SAML_CLOCK_SKEW_MS,
      now + 2 * 60 * 60 * 1000,
    )
    const result = await loadIdpVerifyKeys([future], { now })
    expect(result.ok).toBe(true)
  })
})
