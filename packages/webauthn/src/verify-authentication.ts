// 认证四验证无跳过；UV required；sign_count 异常只标记不拒绝；可信值由调用方注入。

import { derToP1363, toBufferSource } from '@xid-kit/crypto'
import type {
  CoseAlg,
  XidError,
  Result,
  StoredCredential,
  VerifiedPasskey,
  WebAuthnVerificationInput,
} from '@xid-kit/types'

import { deriveDeviceType, parseAuthData } from './authdata'
import { parseCoseKey } from './cose'
import { webauthnError } from './errors'
import { checkClientData, constantTimeEqual } from './parse'

const ES256: CoseAlg = -7
const EDDSA: CoseAlg = -8

// 平台同步 passkey 常见全 0 aaguid，跳过 sign_count 比较以免误报克隆。
function isPlatformZeroAaguid(aaguid: Uint8Array): boolean {
  return aaguid.every((b) => b === 0)
}

// 两值均 0 接受；新值 <= 旧非零值标异常（不拒绝，交上层风险审查）。
export function detectSignCountAnomaly(newCount: number, storedCount: number): boolean {
  if (newCount === 0 && storedCount === 0) return false
  if (storedCount !== 0 && newCount <= storedCount) return true
  return false
}

function verifyAlgParams(alg: CoseAlg): SubtleCryptoSignAlgorithm {
  if (alg === ES256) return { name: 'ECDSA', hash: 'SHA-256' }
  if (alg === EDDSA) return { name: 'Ed25519' }
  return { name: 'RSASSA-PKCS1-v1_5' }
}

// WebAuthn ES256 签名为 DER，Web Crypto 要 P1363；始终 derToP1363，禁止按长度分流
//（P-256 DER 可能恰好 64 字节，误当 P1363 会导致合法登录偶发失败）。
function normalizeSignature(alg: CoseAlg, signature: Uint8Array): Uint8Array {
  if (alg === EDDSA) return signature
  if (alg !== ES256) return signature
  return derToP1363(signature)
}

async function buildSignatureBase(
  authenticatorData: Uint8Array,
  clientDataJson: Uint8Array,
): Promise<Uint8Array> {
  const clientDataHash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', toBufferSource(clientDataJson)),
  )
  const out = new Uint8Array(authenticatorData.length + clientDataHash.length)
  out.set(authenticatorData, 0)
  out.set(clientDataHash, authenticatorData.length)
  return out
}

function fail(error: XidError): Result<VerifiedPasskey, XidError> {
  return { ok: false, error }
}

function invalidCredentials(message: string): Result<VerifiedPasskey, XidError> {
  return fail(webauthnError('invalid_credentials', message))
}

function buildResult(
  stored: StoredCredential,
  parsed: Awaited<ReturnType<typeof parseAuthData>>,
  signCountAnomaly: boolean,
): VerifiedPasskey {
  return {
    credentialId: stored.credentialId,
    publicKey: stored.publicKey,
    coseAlg: stored.coseAlg,
    aaguid: stored.aaguid,
    signCount: parsed.signCount,
    userVerified: parsed.flags.userVerified,
    transports: [],
    credentialDeviceType: deriveDeviceType(parsed.flags),
    credentialBackedUp: parsed.flags.backupState,
    signCountAnomaly,
  }
}

export async function verifyAuthentication(
  input: WebAuthnVerificationInput,
): Promise<Result<VerifiedPasskey, XidError>> {
  const stored = input.storedCredential
  if (!stored || !input.signature) {
    return fail(webauthnError('invalid_credentials', 'missing stored credential or signature'))
  }

  const clientCheck = checkClientData({
    clientDataJson: input.clientDataJson,
    ceremony: 'authentication',
    expectedChallenge: input.expectedChallenge,
    expectedOrigins: input.expectedOrigins,
  })
  if (!clientCheck.ok) {
    if (clientCheck.reason === 'origin_mismatch') return fail(webauthnError('origin_mismatch'))
    if (clientCheck.reason === 'type_mismatch') return fail(webauthnError('invalid_credentials'))
    return fail(webauthnError('challenge_invalid'))
  }

  let parsed: Awaited<ReturnType<typeof parseAuthData>>
  try {
    parsed = await parseAuthData(input.authenticatorData)
  } catch {
    return invalidCredentials('malformed authenticatorData')
  }

  const expectedRpIdHash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input.expectedRpId)),
  )
  if (!constantTimeEqual(parsed.rpIdHash, expectedRpIdHash)) {
    return fail(webauthnError('rpid_mismatch'))
  }

  // UP 必须；UV 缺失直接拒绝，不降级为可选。
  if (!parsed.flags.userPresent) return fail(webauthnError('invalid_credentials', 'UP not set'))
  if (!parsed.flags.userVerified) return fail(webauthnError('user_verification_required'))

  let key: CryptoKey
  try {
    key = (await parseCoseKey(stored.publicKey)).key
  } catch {
    return invalidCredentials('malformed credential public key')
  }
  const signatureBase = await buildSignatureBase(input.authenticatorData, input.clientDataJson)
  let normalizedSig: Uint8Array
  try {
    normalizedSig = normalizeSignature(stored.coseAlg, input.signature)
  } catch {
    return fail(webauthnError('signature_invalid'))
  }
  const valid = await crypto.subtle.verify(
    verifyAlgParams(stored.coseAlg),
    key,
    toBufferSource(normalizedSig),
    toBufferSource(signatureBase),
  )
  if (!valid) return fail(webauthnError('signature_invalid'))

  // BE=1 同步 passkey 与全 0 aaguid 平台密钥不参与 sign_count 异常判定。
  const syncPasskey = parsed.flags.backupEligible || isPlatformZeroAaguid(stored.aaguid)
  const signCountAnomaly = syncPasskey
    ? false
    : detectSignCountAnomaly(parsed.signCount, stored.signCount)

  return { ok: true, value: buildResult(stored, parsed, signCountAnomaly) }
}
