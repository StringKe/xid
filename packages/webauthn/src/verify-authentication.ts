// 认证验证(W3C WebAuthn L3 §7.2,见 docs/design/01-authentication.md 认证验证步骤)。
// 四验证无跳过路径:challenge(constant-time)/ origin / rpIdHash / signature。缺一不可,禁条件分支跳过。
// UV required 强制;sign_count 克隆检测(两 0 接受 / 新<=旧非零标记异常 / BE=1 同步 passkey 不单独门控)。
// 可信值(expectedChallenge/expectedRpId/expectedOrigins/storedCredential)由调用方从 DO + TenantContext 注入。

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

// 平台同步 passkey 常见全 0 aaguid;固定为 0 的平台 passkey 跳过 sign_count 比较(见 01 章设计决策)。
function isPlatformZeroAaguid(aaguid: Uint8Array): boolean {
  return aaguid.every((b) => b === 0)
}

// sign_count 克隆检测(见 01 章 step 7):两值均 0 接受;新值 > 旧值正常;新值 <= 旧非零值标记异常(非拒绝)。
// newCount===0 && storedCount!==0 已被 storedCount!==0 && newCount<=storedCount 覆盖,无需单独分支。
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

// 本包输入契约:WebAuthn ES256 assertion 签名始终为 DER 编码 ECDSA-Sig-Value(SEQUENCE{r,s}),
// Web Crypto 需 P1363(r||s 各 32 字节),故 ES256 始终走 derToP1363。RS256 签名原始字节直接传入。
// 不用长度启发式:P-256 DER 可能恰好 64 字节,长度判定会把 DER 当 P1363 导致合法登录偶发失败。
// 防御重复转换按 DER 结构判定(首字节 0x30 且可解析为 SEQUENCE)而非长度。
function normalizeSignature(alg: CoseAlg, signature: Uint8Array): Uint8Array {
  if (alg === EDDSA) return signature
  if (alg !== ES256) return signature
  return derToP1363(signature)
}

// 构造签名输入:authenticatorData || SHA-256(clientDataJSON)(见 01 章 step 5)。
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

// 认证四验证编排。返回 Result;四验证任一失败返回模糊错误,sign_count 异常不拒绝只置 signCountAnomaly。
export async function verifyAuthentication(
  input: WebAuthnVerificationInput,
): Promise<Result<VerifiedPasskey, XidError>> {
  const stored = input.storedCredential
  if (!stored || !input.signature) {
    return fail(webauthnError('invalid_credentials', 'missing stored credential or signature'))
  }

  // verification 1 + 2:clientDataJSON 的 challenge(constant-time)与 origin。
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

  // verification 3:rpIdHash == SHA-256(expectedRpId)。
  const expectedRpIdHash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input.expectedRpId)),
  )
  if (!constantTimeEqual(parsed.rpIdHash, expectedRpIdHash)) {
    return fail(webauthnError('rpid_mismatch'))
  }

  // UP 必须;UV required 强制(userVerification:required,缺失拒绝)。
  if (!parsed.flags.userPresent) return fail(webauthnError('invalid_credentials', 'UP not set'))
  if (!parsed.flags.userVerified) return fail(webauthnError('user_verification_required'))

  // verification 4:signature。注册公钥(COSE 字节)importKey 复用,ES256 DER->P1363。
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

  // sign_count 克隆检测:BE=1 同步 passkey 与平台全 0 aaguid 不单独门控,不参与异常判定。
  const syncPasskey = parsed.flags.backupEligible || isPlatformZeroAaguid(stored.aaguid)
  const signCountAnomaly = syncPasskey
    ? false
    : detectSignCountAnomaly(parsed.signCount, stored.signCount)

  return { ok: true, value: buildResult(stored, parsed, signCountAnomaly) }
}
