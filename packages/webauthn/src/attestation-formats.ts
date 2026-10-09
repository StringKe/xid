// packed 与 fido-u2f attestation 语句的签名校验(WebAuthn L3 §8.2 / §8.6)。只判断语句本身是否成立,
// 证书链是否抵达可信根由 attestation.ts 按租户策略判定。

import { derToP1363, toBufferSource } from '@xid-kit/crypto'

import type { AttestedCredentialData, ParsedAuthData } from './authdata'
import type { CborMap, CborValue } from './cbor'
import { cborDecode } from './cbor'
import {
  certificateAaguid,
  parseCertificate,
  verifyWithCertificateKey,
  type ParsedCertificate,
} from './x509'

export type StatementVerification =
  | { ok: true; certificates: readonly ParsedCertificate[] | null }
  | { ok: false; reason: string }

type StatementInput = {
  attStmt: CborMap
  authData: Uint8Array
  parsed: ParsedAuthData & { attestedCredentialData: AttestedCredentialData }
  clientDataHash: Uint8Array
}

const X5C_ALGS: Readonly<Record<number, { kind: 'ec' | 'rsa'; hash: string; curve?: string }>> = {
  [-7]: { kind: 'ec', hash: 'SHA-256', curve: 'P-256' },
  [-35]: { kind: 'ec', hash: 'SHA-384', curve: 'P-384' },
  [-36]: { kind: 'ec', hash: 'SHA-512', curve: 'P-521' },
  [-257]: { kind: 'rsa', hash: 'SHA-256' },
  [-258]: { kind: 'rsa', hash: 'SHA-384' },
  [-259]: { kind: 'rsa', hash: 'SHA-512' },
}

const LABEL_EC2_X = -2
const LABEL_EC2_Y = -3

function asBytes(value: CborValue | undefined): Uint8Array {
  if (value instanceof Uint8Array) return value
  throw new Error('attestation: expected byte string')
}

function asInt(value: CborValue | undefined): number {
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  throw new Error('attestation: expected integer')
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function parseX5c(attStmt: CborMap): ParsedCertificate[] | null {
  const x5c = attStmt.get('x5c')
  if (x5c === undefined) return null
  if (!Array.isArray(x5c) || x5c.length === 0) throw new Error('attestation: malformed x5c')
  return x5c.map((entry: CborValue) => parseCertificate(asBytes(entry)))
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index])
}

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
  const algorithm = X5C_ALGS[alg]
  if (!algorithm || algorithm.kind !== leaf.key.kind) {
    return { ok: false, reason: 'attestation alg does not match certificate key' }
  }
  if (leaf.key.kind === 'ec' && leaf.key.curve !== algorithm.curve) {
    return { ok: false, reason: 'attestation alg does not match certificate curve' }
  }
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
  if (attested.coseKey.alg !== -7) return { ok: false, reason: 'fido-u2f requires an ES256 key' }
  const coseKey = cborDecode(attested.coseKeyBytes)
  if (!(coseKey instanceof Map)) return { ok: false, reason: 'malformed credential public key' }
  const publicKeyU2f = concat(
    new Uint8Array([0x04]),
    asBytes(coseKey.get(LABEL_EC2_X)),
    asBytes(coseKey.get(LABEL_EC2_Y)),
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
