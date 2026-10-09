// packed 与 fido-u2f attestation 语句的签名校验(WebAuthn L3 §8.2 / §8.6)。只判断语句本身是否成立,
// 证书链是否抵达可信根由 attestation.ts 按租户策略判定。

import { base64UrlDecode, derToP1363, toBufferSource } from '@xid-kit/crypto'

import {
  asBytes,
  asInt,
  bytesEqual,
  concat,
  credentialPublicKey,
  parseX5c,
  statementAlgorithmFor,
  type StatementInput,
  type StatementVerification,
} from './attestation-shared'
import { certificateAaguid, verifyWithCertificateKey, type ParsedCertificate } from './x509'

// §8.2.1:version 3、非 CA、AAGUID 扩展存在时必须与 authData 一致。
function packedLeafProblem(leaf: ParsedCertificate, aaguid: Uint8Array): string | null {
  if (leaf.version !== 3) return 'attestation certificate must be X.509 v3'
  if (leaf.basicConstraints?.isCa) return 'attestation certificate must not be a CA'
  const certAaguid = certificateAaguid(leaf)
  if (certAaguid && !bytesEqual(certAaguid, aaguid)) return 'attestation aaguid mismatch'
  return null
}

async function verifySelfSignature(input: StatementInput, alg: number, sig: Uint8Array) {
  const coseKey = input.parsed.attestedCredentialData.coseKey
  if (alg !== coseKey.alg) return false
  const data = concat(input.authData, input.clientDataHash)
  if (alg === -7) {
    return crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      coseKey.key,
      toBufferSource(derToP1363(sig)),
      toBufferSource(data),
    )
  }
  const params = alg === -8 ? { name: 'Ed25519' } : { name: 'RSASSA-PKCS1-v1_5' }
  return crypto.subtle.verify(params, coseKey.key, toBufferSource(sig), toBufferSource(data))
}

export async function verifyPackedStatement(input: StatementInput): Promise<StatementVerification> {
  const alg = asInt(input.attStmt.get('alg'))
  const sig = asBytes(input.attStmt.get('sig'))
  if (input.attStmt.has('ecdaaKeyId')) return { ok: false, reason: 'ECDAA is not supported' }
  const certificates = parseX5c(input.attStmt)
  if (!certificates) {
    const valid = await verifySelfSignature(input, alg, sig).catch(() => false)
    return valid
      ? { ok: true, certificates: null }
      : { ok: false, reason: 'self signature invalid' }
  }
  const leaf = certificates[0]!
  const algorithm = statementAlgorithmFor(alg, leaf.key)
  if (!algorithm) return { ok: false, reason: 'attestation alg does not match certificate key' }
  const problem = packedLeafProblem(leaf, input.parsed.attestedCredentialData.aaguid)
  if (problem) return { ok: false, reason: problem }
  const valid = await verifyWithCertificateKey({
    key: leaf.key,
    hash: algorithm.hash,
    signature: sig,
    data: concat(input.authData, input.clientDataHash),
  })
  return valid ? { ok: true, certificates } : { ok: false, reason: 'attestation signature invalid' }
}

// §8.6:x5c 只有一张 P-256 证书;凭证公钥必须是 EC2 P-256,按 U2F 原始格式 0x04||x||y 参与签名。
export async function verifyFidoU2fStatement(
  input: StatementInput,
): Promise<StatementVerification> {
  const sig = asBytes(input.attStmt.get('sig'))
  const certificates = parseX5c(input.attStmt)
  if (!certificates || certificates.length !== 1) {
    return { ok: false, reason: 'fido-u2f requires exactly one certificate' }
  }
  const leaf = certificates[0]!
  if (leaf.key.kind !== 'ec' || leaf.key.curve !== 'P-256') {
    return { ok: false, reason: 'fido-u2f certificate must hold a P-256 key' }
  }
  const attested = input.parsed.attestedCredentialData
  const credential = credentialPublicKey(attested)
  if (attested.coseKey.alg !== -7 || credential?.kty !== 'EC') {
    return { ok: false, reason: 'fido-u2f requires an ES256 key' }
  }
  const publicKeyU2f = concat(
    new Uint8Array([0x04]),
    base64UrlDecode(credential.x),
    base64UrlDecode(credential.y),
  )
  const data = concat(
    new Uint8Array([0x00]),
    input.parsed.rpIdHash,
    input.clientDataHash,
    attested.credentialId,
    publicKeyU2f,
  )
  const valid = await verifyWithCertificateKey({
    key: leaf.key,
    hash: 'SHA-256',
    signature: sig,
    data,
  })
  return valid ? { ok: true, certificates } : { ok: false, reason: 'attestation signature invalid' }
}
