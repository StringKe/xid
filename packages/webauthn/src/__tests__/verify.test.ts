// 四验证编排与负路径；sign_count 异常标记；注册提取 VerifiedPasskey。

import { derToP1363, p1363ToDer } from '@xid-kit/crypto'
import type { StoredCredential, WebAuthnVerificationInput } from '@xid-kit/types'
import { describe, expect, it } from 'vitest'

import { detectSignCountAnomaly, verifyAuthentication } from '../verify-authentication'
import { verifyRegistration } from '../verify-registration'
import {
  buildOriginTamperedVector,
  buildRpIdHashTamperedVector,
  generateAssertionKeyPair,
} from './fixtures/assertion-vectors'

const RP_ID = 'test.xid.dev'
const ORIGIN = 'https://test.xid.dev'

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

// raw P-256 (0x04||x||y) 手写为 COSE_Key CBOR map，避免测试依赖完整编解码。
function coseEncodeEs256(rawPublicKey: Uint8Array): Uint8Array {
  const x = rawPublicKey.subarray(1, 33)
  const y = rawPublicKey.subarray(33, 65)
  const out: number[] = []
  out.push(0xa5)
  out.push(0x01, 0x02)
  out.push(0x03, 0x26)
  out.push(0x20, 0x01)
  out.push(0x21, 0x58, 0x20, ...x)
  out.push(0x22, 0x58, 0x20, ...y)
  return new Uint8Array(out)
}

function buildClientDataJson(
  type: 'webauthn.create' | 'webauthn.get',
  challenge: Uint8Array,
  origin: string,
): Uint8Array {
  const obj = { type, challenge: base64UrlEncode(challenge), origin, crossOrigin: false }
  return new TextEncoder().encode(JSON.stringify(obj))
}

async function buildAuthData(
  rpId: string,
  opts: { uv: boolean; up?: boolean; signCount: number },
): Promise<Uint8Array> {
  const rpIdHash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rpId)),
  )
  let flags = 0
  if (opts.up !== false) flags |= 0x01
  if (opts.uv) flags |= 0x04
  const authData = new Uint8Array(37)
  authData.set(rpIdHash, 0)
  authData[32] = flags
  new DataView(authData.buffer).setUint32(33, opts.signCount, false)
  return authData
}

// 合法输入使用 DER 签名，覆盖生产路径的 derToP1363。
async function buildValidAuth(opts: {
  rpId?: string
  origin?: string
  uv?: boolean
  newSignCount?: number
  storedSignCount?: number
  aaguid?: Uint8Array
}): Promise<{ input: WebAuthnVerificationInput; keyPair: CryptoKeyPair }> {
  const rpId = opts.rpId ?? RP_ID
  const origin = opts.origin ?? ORIGIN
  const keyPair = await generateAssertionKeyPair()
  const challenge = crypto.getRandomValues(new Uint8Array(32))
  const clientDataJson = buildClientDataJson('webauthn.get', challenge, origin)
  const authData = await buildAuthData(rpId, {
    uv: opts.uv ?? true,
    signCount: opts.newSignCount ?? 5,
  })
  const clientDataHash = new Uint8Array(await crypto.subtle.digest('SHA-256', clientDataJson))
  const toSign = new Uint8Array(authData.length + clientDataHash.length)
  toSign.set(authData, 0)
  toSign.set(clientDataHash, authData.length)
  const rawSig = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keyPair.privateKey, toSign),
  )
  const derSig = p1363ToDer(rawSig)
  const rawPub = new Uint8Array(
    (await crypto.subtle.exportKey('raw', keyPair.publicKey)) as ArrayBuffer,
  )

  const storedCredential: StoredCredential = {
    credentialId: crypto.getRandomValues(new Uint8Array(16)),
    publicKey: coseEncodeEs256(rawPub),
    coseAlg: -7,
    signCount: opts.storedSignCount ?? 0,
    aaguid: opts.aaguid ?? crypto.getRandomValues(new Uint8Array(16)),
  }

  return {
    keyPair,
    input: {
      ceremony: 'authentication',
      expectedChallenge: challenge,
      expectedRpId: rpId,
      expectedOrigins: [origin],
      clientDataJson,
      authenticatorData: authData,
      signature: derSig,
      storedCredential,
    },
  }
}

function coseEncodeEd25519Public(rawPublicKey: Uint8Array): Uint8Array {
  const out: number[] = []
  out.push(0xa4, 0x01, 0x01, 0x03, 0x27, 0x20, 0x06)
  out.push(0x21, 0x58, 0x20, ...rawPublicKey)
  return new Uint8Array(out)
}

async function buildValidEdDSAAuth(opts: {
  rpId?: string
  origin?: string
  uv?: boolean
  newSignCount?: number
  storedSignCount?: number
}): Promise<{ input: WebAuthnVerificationInput }> {
  const rpId = opts.rpId ?? RP_ID
  const origin = opts.origin ?? ORIGIN
  const keyPair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
  const challenge = crypto.getRandomValues(new Uint8Array(32))
  const clientDataJson = buildClientDataJson('webauthn.get', challenge, origin)
  const authData = await buildAuthData(rpId, {
    uv: opts.uv ?? true,
    signCount: opts.newSignCount ?? 5,
  })
  const clientDataHash = new Uint8Array(await crypto.subtle.digest('SHA-256', clientDataJson))
  const toSign = new Uint8Array(authData.length + clientDataHash.length)
  toSign.set(authData, 0)
  toSign.set(clientDataHash, authData.length)
  const signature = new Uint8Array(await crypto.subtle.sign('Ed25519', keyPair.privateKey, toSign))
  const rawPub = new Uint8Array(
    (await crypto.subtle.exportKey('raw', keyPair.publicKey)) as ArrayBuffer,
  )

  return {
    input: {
      ceremony: 'authentication',
      expectedChallenge: challenge,
      expectedRpId: rpId,
      expectedOrigins: [origin],
      clientDataJson,
      authenticatorData: authData,
      signature,
      storedCredential: {
        credentialId: crypto.getRandomValues(new Uint8Array(16)),
        publicKey: coseEncodeEd25519Public(rawPub),
        coseAlg: -8,
        signCount: opts.storedSignCount ?? 0,
        aaguid: crypto.getRandomValues(new Uint8Array(16)),
      },
    },
  }
}

describe('verifyAuthentication: valid path', () => {
  it('accepts a valid EdDSA assertion (COSE alg -8)', async () => {
    const { input } = await buildValidEdDSAAuth({ newSignCount: 5, storedSignCount: 0 })
    const result = await verifyAuthentication(input)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.userVerified).toBe(true)
      expect(result.value.signCount).toBe(5)
    }
  })

  it('accepts a valid assertion (DER signature, COSE key)', async () => {
    const { input } = await buildValidAuth({ newSignCount: 5, storedSignCount: 0 })
    const result = await verifyAuthentication(input)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.userVerified).toBe(true)
      expect(result.value.signCount).toBe(5)
      expect(result.value.signCountAnomaly).toBe(false)
    }
  })

  // ES256 只接受 DER：raw P1363 必须拒绝，禁止按长度分流误放行。
  it('verifies the DER form but rejects the raw P1363 form of the same signature', async () => {
    const { input } = await buildValidAuth({ newSignCount: 5, storedSignCount: 0 })
    const derSig = input.signature!
    expect(derSig[0]).toBe(0x30)

    const derResult = await verifyAuthentication(input)
    expect(derResult.ok).toBe(true)

    const rawP1363 = derToP1363(derSig)
    expect(rawP1363.length).toBe(64)
    const rawResult = await verifyAuthentication({ ...input, signature: rawP1363 })
    expect(rawResult.ok).toBe(false)
  })
})

describe('verifyAuthentication: four-verification negative paths', () => {
  it('rejects on challenge mismatch (verification 1)', async () => {
    const { input } = await buildValidAuth({})
    const tampered: WebAuthnVerificationInput = {
      ...input,
      expectedChallenge: crypto.getRandomValues(new Uint8Array(32)),
    }
    const result = await verifyAuthentication(tampered)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('challenge_invalid')
  })

  it('rejects on origin mismatch (verification 2)', async () => {
    const vector = await buildOriginTamperedVector(RP_ID, ORIGIN, 'https://evil.attacker.com')
    const result = await verifyAuthentication(vector.input)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('origin_mismatch')
  })

  it('rejects on rpIdHash mismatch (verification 3)', async () => {
    const vector = await buildRpIdHashTamperedVector(RP_ID, 'evil.attacker.com', ORIGIN)
    const result = await verifyAuthentication(vector.input)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('rpid_mismatch')
  })

  it('rejects on invalid signature (verification 4)', async () => {
    const { input } = await buildValidAuth({})
    const badSig = new Uint8Array(input.signature!)
    badSig[badSig.length - 1] = badSig[badSig.length - 1]! ^ 0xff
    const result = await verifyAuthentication({ ...input, signature: badSig })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('signature_invalid')
  })

  it('rejects when UV flag missing (userVerification required)', async () => {
    const { input } = await buildValidAuth({ uv: false })
    const result = await verifyAuthentication(input)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('user_verification_required')
  })

  it('returns invalid_credentials for malformed authenticatorData', async () => {
    const { input } = await buildValidAuth({})
    const result = await verifyAuthentication({
      ...input,
      authenticatorData: new Uint8Array([0x01, 0x02]),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('invalid_credentials')
  })

  it('returns invalid_credentials for malformed stored public key', async () => {
    const { input } = await buildValidAuth({})
    const storedCredential = { ...input.storedCredential!, publicKey: new Uint8Array([0xa1]) }
    const result = await verifyAuthentication({ ...input, storedCredential })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('invalid_credentials')
  })
})

describe('verifyAuthentication: sign_count clone detection', () => {
  it('flags anomaly when new <= stored non-zero (non-sync passkey)', async () => {
    const { input } = await buildValidAuth({
      newSignCount: 3,
      storedSignCount: 5,
      aaguid: crypto.getRandomValues(new Uint8Array(16)),
    })
    const result = await verifyAuthentication(input)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.signCountAnomaly).toBe(true)
  })

  it('does not flag normal progression', async () => {
    const { input } = await buildValidAuth({
      newSignCount: 6,
      storedSignCount: 5,
      aaguid: crypto.getRandomValues(new Uint8Array(16)),
    })
    const result = await verifyAuthentication(input)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.signCountAnomaly).toBe(false)
  })

  it('does not flag sync passkey (all-zero aaguid) even when count regresses', async () => {
    const { input } = await buildValidAuth({
      newSignCount: 0,
      storedSignCount: 5,
      aaguid: new Uint8Array(16),
    })
    const result = await verifyAuthentication(input)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.signCountAnomaly).toBe(false)
  })

  it('detectSignCountAnomaly pure-function cases', () => {
    expect(detectSignCountAnomaly(0, 0)).toBe(false)
    expect(detectSignCountAnomaly(6, 5)).toBe(false)
    expect(detectSignCountAnomaly(3, 5)).toBe(true)
    expect(detectSignCountAnomaly(5, 5)).toBe(true)
    expect(detectSignCountAnomaly(0, 2)).toBe(true)
  })
})

describe('verifyRegistration', () => {
  function coseEncodeEd25519(x: Uint8Array): Uint8Array {
    const out: number[] = []
    out.push(0xa4, 0x01, 0x01, 0x03, 0x27, 0x20, 0x06)
    out.push(0x21, 0x58, 0x20, ...x)
    return new Uint8Array(out)
  }

  async function buildRegistration(opts: {
    uv: boolean
    fmt?: 'none' | 'packed'
    attStmt?: Uint8Array
    alg?: 'es256' | 'eddsa'
  }): Promise<WebAuthnVerificationInput> {
    const coseKey =
      opts.alg === 'eddsa'
        ? coseEncodeEd25519(new Uint8Array(32).fill(9))
        : coseEncodeEs256(
            new Uint8Array(
              (await crypto.subtle.exportKey(
                'raw',
                (
                  await generateAssertionKeyPair()
                ).publicKey,
              )) as ArrayBuffer,
            ),
          )
    const credentialId = crypto.getRandomValues(new Uint8Array(16))
    const aaguid = new Uint8Array(16)

    const rpIdHash = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(RP_ID)),
    )
    let flags = 0x01 | 0x40 // UP | AT
    if (opts.uv) flags |= 0x04
    const acd = new Uint8Array(16 + 2 + credentialId.length + coseKey.length)
    acd.set(aaguid, 0)
    acd[16] = (credentialId.length >> 8) & 0xff
    acd[17] = credentialId.length & 0xff
    acd.set(credentialId, 18)
    acd.set(coseKey, 18 + credentialId.length)
    const authData = new Uint8Array(37 + acd.length)
    authData.set(rpIdHash, 0)
    authData[32] = flags
    new DataView(authData.buffer).setUint32(33, 0, false)
    authData.set(acd, 37)

    const fmt = opts.fmt ?? 'none'
    const attStmt = opts.attStmt ?? new Uint8Array([0xa0])

    const out: number[] = []
    out.push(0xa3)
    out.push(0x63, 0x66, 0x6d, 0x74)
    out.push(0x60 + fmt.length, ...new TextEncoder().encode(fmt))
    out.push(0x67, 0x61, 0x74, 0x74, 0x53, 0x74, 0x6d, 0x74)
    out.push(...attStmt)
    out.push(0x68, 0x61, 0x75, 0x74, 0x68, 0x44, 0x61, 0x74, 0x61)
    out.push(0x59, (authData.length >> 8) & 0xff, authData.length & 0xff)
    const attestationObject = new Uint8Array(out.length + authData.length)
    attestationObject.set(out, 0)
    attestationObject.set(authData, out.length)

    const challenge = crypto.getRandomValues(new Uint8Array(32))
    return {
      ceremony: 'registration',
      expectedChallenge: challenge,
      expectedRpId: RP_ID,
      expectedOrigins: [ORIGIN],
      clientDataJson: buildClientDataJson('webauthn.create', challenge, ORIGIN),
      authenticatorData: authData,
      attestationObject,
    }
  }

  it('extracts VerifiedPasskey from a valid none-attestation registration', async () => {
    const input = await buildRegistration({ uv: true })
    const result = await verifyRegistration(input)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.coseAlg).toBe(-7)
      expect(result.value.credentialId).toHaveLength(16)
      expect(result.value.userVerified).toBe(true)
      expect(result.value.publicKey.length).toBeGreaterThan(0)
    }
  })

  it('does not produce enterprise attestation trust from non-none attestationObject', async () => {
    const input = await buildRegistration({
      uv: true,
      fmt: 'packed',
      attStmt: new Uint8Array([0xa2, 0x63, 0x61, 0x6c, 0x67, 0x26, 0x63, 0x73, 0x69, 0x67, 0x40]),
    })
    const result = await verifyRegistration(input)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(Object.keys(result.value)).not.toContain('attestationTrustPath')
      expect(Object.keys(result.value)).not.toContain('enterpriseAttestation')
      expect(result.value.credentialId).toHaveLength(16)
    }
  })

  it('rejects registration when UV missing', async () => {
    const input = await buildRegistration({ uv: false })
    const result = await verifyRegistration(input)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('user_verification_required')
  })

  it('returns invalid_credentials for malformed attestationObject', async () => {
    const input = await buildRegistration({ uv: true })
    const result = await verifyRegistration({ ...input, attestationObject: new Uint8Array([0xa1]) })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('invalid_credentials')
  })

  it('accepts EdDSA COSE alg in registration attestationObject', async () => {
    const input = await buildRegistration({ uv: true, alg: 'eddsa' })
    const result = await verifyRegistration(input)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.coseAlg).toBe(-8)
  })

  it('rejects unsupported COSE alg labels', async () => {
    const input = await buildRegistration({ uv: true })
    const bytes = new Uint8Array(input.attestationObject!)
    const algLabel = bytes.findIndex((byte, index) => bytes[index - 1] === 0x03 && byte === 0x26)
    expect(algLabel).toBeGreaterThan(0)
    bytes[algLabel] = 0x28
    const result = await verifyRegistration({ ...input, attestationObject: bytes })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('invalid_credentials')
  })
})
