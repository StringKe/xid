// attestation 各格式共用:CBOR 取值、COSE alg 到 Web Crypto 参数的映射、凭证公钥与证书公钥比对。

import { base64UrlDecode, base64UrlEncode, toBufferSource } from '@xid-kit/crypto'

import type { AttestedCredentialData, ParsedAuthData } from './authdata'
import type { CborMap, CborValue } from './cbor'
import { cborDecode } from './cbor'
import { parseCertificate, type CertificateKey, type ParsedCertificate } from './x509'

export type StatementVerification =
  | { ok: true; certificates: readonly ParsedCertificate[] | null }
  | { ok: false; reason: string }

export type StatementInput = {
  attStmt: CborMap
  authData: Uint8Array
  parsed: ParsedAuthData & { attestedCredentialData: AttestedCredentialData }
  clientDataHash: Uint8Array
}

export type SignatureAlgorithm = { kind: CertificateKey['kind']; hash: string; curve?: string }

// attStmt.alg 可取的 COSE 签名算法;-65535 是 TPM 上常见的 RSASSA-PKCS1-v1_5 + SHA-1。
export const STATEMENT_ALGS: Readonly<Record<number, SignatureAlgorithm>> = {
  [-7]: { kind: 'ec', hash: 'SHA-256', curve: 'P-256' },
  [-35]: { kind: 'ec', hash: 'SHA-384', curve: 'P-384' },
  [-36]: { kind: 'ec', hash: 'SHA-512', curve: 'P-521' },
  [-257]: { kind: 'rsa', hash: 'SHA-256' },
  [-258]: { kind: 'rsa', hash: 'SHA-384' },
  [-259]: { kind: 'rsa', hash: 'SHA-512' },
  [-65535]: { kind: 'rsa', hash: 'SHA-1' },
}

const COSE_KTY = 1
const COSE_KTY_EC2 = 2
const COSE_KTY_RSA = 3
const COSE_EC2_X = -2
const COSE_EC2_Y = -3
const COSE_RSA_N = -1
const COSE_RSA_E = -2

export function asBytes(value: CborValue | undefined): Uint8Array {
  if (value instanceof Uint8Array) return value
  throw new Error('attestation: expected byte string')
}

export function asInt(value: CborValue | undefined): number {
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  throw new Error('attestation: expected integer')
}

export function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index])
}

export function parseX5c(attStmt: CborMap): ParsedCertificate[] | null {
  const x5c = attStmt.get('x5c')
  if (x5c === undefined) return null
  if (!Array.isArray(x5c) || x5c.length === 0) throw new Error('attestation: malformed x5c')
  return x5c.map((entry: CborValue) => parseCertificate(asBytes(entry)))
}

export function statementAlgorithmFor(alg: number, key: CertificateKey): SignatureAlgorithm | null {
  const algorithm = STATEMENT_ALGS[alg]
  if (!algorithm || algorithm.kind !== key.kind) return null
  if (key.kind === 'ec' && key.curve !== algorithm.curve) return null
  return algorithm
}

export async function sha(hash: string, data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest(hash, toBufferSource(data)))
}

// RSA 模数和指数按无符号大整数比较:去掉前导 0 字节后再编码。
function unsignedB64(bytes: Uint8Array): string {
  let start = 0
  while (start < bytes.length - 1 && bytes[start] === 0) start++
  return base64UrlEncode(bytes.subarray(start))
}

function stripLeadingZeros(value: string): string {
  return unsignedB64(base64UrlDecode(value))
}

// 凭证公钥(COSE)的规范化表示:EC 为 x/y,RSA 为 n/e,均为 base64url。
export type CredentialPublicKey =
  | { kty: 'EC'; x: string; y: string }
  | { kty: 'RSA'; n: string; e: string }

export function credentialPublicKey(attested: AttestedCredentialData): CredentialPublicKey | null {
  const map = cborDecode(attested.coseKeyBytes)
  if (!(map instanceof Map)) return null
  const kty = asInt(map.get(COSE_KTY))
  if (kty === COSE_KTY_EC2) {
    return {
      kty: 'EC',
      x: base64UrlEncode(asBytes(map.get(COSE_EC2_X))),
      y: base64UrlEncode(asBytes(map.get(COSE_EC2_Y))),
    }
  }
  if (kty === COSE_KTY_RSA) {
    return {
      kty: 'RSA',
      n: unsignedB64(asBytes(map.get(COSE_RSA_N))),
      e: unsignedB64(asBytes(map.get(COSE_RSA_E))),
    }
  }
  return null
}

export function publicKeysEqual(a: CredentialPublicKey, b: CredentialPublicKey): boolean {
  if (a.kty === 'EC' && b.kty === 'EC') return a.x === b.x && a.y === b.y
  if (a.kty === 'RSA' && b.kty === 'RSA') return a.n === b.n && a.e === b.e
  return false
}

// 证书公钥按 Web Crypto 导出成 JWK 再取出与 COSE 对应的分量。
export async function certificatePublicKey(key: CertificateKey): Promise<CredentialPublicKey> {
  const algorithm =
    key.kind === 'ec'
      ? { name: 'ECDSA', namedCurve: key.curve }
      : { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }
  const imported = await crypto.subtle.importKey(
    'spki',
    toBufferSource(key.spki),
    algorithm,
    true,
    ['verify'],
  )
  const jwk = (await crypto.subtle.exportKey('jwk', imported)) as JsonWebKey
  if (key.kind === 'ec') return { kty: 'EC', x: jwk.x ?? '', y: jwk.y ?? '' }
  return { kty: 'RSA', n: stripLeadingZeros(jwk.n ?? ''), e: stripLeadingZeros(jwk.e ?? '') }
}

export async function certificateMatchesCredential(
  cert: ParsedCertificate,
  attested: AttestedCredentialData,
): Promise<boolean> {
  const credential = credentialPublicKey(attested)
  if (!credential) return false
  return publicKeysEqual(await certificatePublicKey(cert.key), credential)
}
