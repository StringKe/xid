// 四验证编排测试(见 webauthn rule 四验证无跳过 + testing rule)。
// 各负路径独立断言:challenge 不符 / origin 篡改 / rpIdHash 篡改 / 签名无效 / UV 缺失各拒绝;
// sign_count 克隆标记;注册提取 VerifiedPasskey。复用 assertion-vectors 负路径向量。

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

// 把 P-256 public key(raw 0x04||x||y,65 字节)编码为 COSE_Key CBOR map 字节。
// map(5){ 1:2(EC2), 3:-7(ES256), -1:1(P-256), -2:x(32), -3:y(32) }。
function coseEncodeEs256(rawPublicKey: Uint8Array): Uint8Array {
  const x = rawPublicKey.subarray(1, 33)
  const y = rawPublicKey.subarray(33, 65)
  const out: number[] = []
  out.push(0xa5) // map of 5 pairs
  out.push(0x01, 0x02) // 1: 2
  out.push(0x03, 0x26) // 3: -7  (nint 6 -> 0x20|6)
  out.push(0x20, 0x01) // -1: 1  (nint 0 -> 0x20, value 1)
  out.push(0x21, 0x58, 0x20, ...x) // -2: bytes(32)
  out.push(0x22, 0x58, 0x20, ...y) // -3: bytes(32)
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

// 构建合法认证输入:COSE 公钥 + DER 签名(verifyAuthentication 内部 DER->P1363)。
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
  const derSig = p1363ToDer(rawSig) // 真 WebAuthn 是 DER,转换后验证 DER->P1363 路径
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

  // 本包契约:ES256 签名只接受 DER,始终走 derToP1363。
  // DER 签名验签通过;同一签名的 raw P1363(64 字节)形式被 derToP1363 判为畸形 DER 拒绝。
  // 不按长度分流,否则恰好 64 字节的真实 DER 会被误当 P1363,导致合法登录偶发失败。
  it('verifies the DER form but rejects the raw P1363 form of the same signature', async () => {
    const { input } = await buildValidAuth({ newSignCount: 5, storedSignCount: 0 })
    const derSig = input.signature!
    expect(derSig[0]).toBe(0x30) // buildValidAuth 产出 DER

    const derResult = await verifyAuthentication(input)
    expect(derResult.ok).toBe(true)

    // 把 DER 转回 raw P1363(64 字节),冒充已转换输入,必须不被放行。
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
    // 篡改签名第一字节,保持 DER 结构可解析但验签失败
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
  // 构建注册 attestationObject:CBOR map{ fmt, attStmt, authData(含 attestedCredentialData) }。
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

    // attestationObject = a3 (map3) { "fmt":fmt, "attStmt":attStmt, "authData": authData }
    const out: number[] = []
    out.push(0xa3)
    out.push(0x63, 0x66, 0x6d, 0x74) // "fmt"
    out.push(0x60 + fmt.length, ...new TextEncoder().encode(fmt))
    out.push(0x67, 0x61, 0x74, 0x74, 0x53, 0x74, 0x6d, 0x74) // "attStmt"
    out.push(...attStmt)
    out.push(0x68, 0x61, 0x75, 0x74, 0x68, 0x44, 0x61, 0x74, 0x61) // "authData"
    // bytes(authData.length) header
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
