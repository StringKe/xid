// JWT 签验自研;ES256 使用 Web Crypto 原生 JOSE P1363 签名,无需 DER。可预期失败返回 Result,格式损坏才 throw。

import type { Result, SigningAlg } from '@xid-kit/types'

import { toBufferSource } from './buffer-source'
import {
  base64UrlDecode,
  base64UrlDecodeToString,
  base64UrlEncode,
  base64UrlEncodeString,
} from './base64url'

const encoder = new TextEncoder()
const P256_COORD_BYTES = 32

export type JwtHeader = {
  alg: SigningAlg
  typ?: string
  kid: string
}

export type JwtClaims = {
  iss?: string
  sub?: string
  aud?: string | readonly string[]
  exp?: number
  iat?: number
  nbf?: number
  jti?: string
  [claim: string]: unknown
}

function signAlgParams(alg: SigningAlg): SubtleCryptoSignAlgorithm {
  if (alg === 'ES256') return { name: 'ECDSA', hash: 'SHA-256' }
  if (alg === 'PS256') return { name: 'RSA-PSS', saltLength: P256_COORD_BYTES }
  return { name: 'RSASSA-PKCS1-v1_5' }
}

export async function signJwt(
  input: { header: Omit<JwtHeader, 'typ'> & { typ?: string }; payload: JwtClaims },
  signingKey: CryptoKey,
): Promise<string> {
  const header: JwtHeader = { typ: 'JWT', ...input.header }
  const signingInput = `${base64UrlEncodeString(JSON.stringify(header))}.${base64UrlEncodeString(
    JSON.stringify(input.payload),
  )}`
  const rawSig = new Uint8Array(
    await crypto.subtle.sign(signAlgParams(header.alg), signingKey, encoder.encode(signingInput)),
  )
  return `${signingInput}.${base64UrlEncode(rawSig)}`
}

export type VerifyKey = { alg: SigningAlg; publicKey: CryptoKey }
export type VerifyKeySet = {
  keys: readonly { kid: string; alg: SigningAlg; publicKey: CryptoKey }[]
}

export type VerifyOptions = {
  now?: number
  clockToleranceSec?: number
  // RP-Initiated Logout 的 id_token_hint 可已过期;跳过 exp 时 nbf/iat 仍按 clockToleranceSec 校验,避免未来签发的 token 被放行。
  allowExpired?: boolean
  expectedIssuer?: string
  expectedAudience?: string
}

export type VerifiedJwt = {
  header: JwtHeader
  payload: JwtClaims
}

export type JwtVerifyError = {
  reason:
    | 'malformed'
    | 'unknown_kid'
    | 'unsupported_alg'
    | 'bad_signature'
    | 'expired'
    | 'not_yet_valid'
    | 'issued_in_future'
    | 'issuer_mismatch'
    | 'audience_mismatch'
}

function err<T>(reason: JwtVerifyError['reason']): Result<T, JwtVerifyError> {
  return { ok: false, error: { reason } }
}

function parseSegment<T>(segment: string): T {
  return JSON.parse(base64UrlDecodeToString(segment)) as T
}

function resolveKey(header: JwtHeader, key: VerifyKey | VerifyKeySet): VerifyKey | undefined {
  if ('publicKey' in key) return key
  const match = key.keys.find((k) => k.kid === header.kid)
  if (match) return { alg: match.alg, publicKey: match.publicKey }
  // CryptoKey 无 kid 时 toVerifyKeySet 用空串占位;仅唯一 key 且 kid 为空才放宽匹配,避免多 kid 轮换误用错误公钥。
  const only = key.keys.length === 1 ? key.keys[0] : undefined
  return only && only.kid === '' ? { alg: only.alg, publicKey: only.publicKey } : undefined
}

function checkTime(
  payload: JwtClaims,
  now: number,
  tolerance: number,
  allowExpired: boolean,
): JwtVerifyError['reason'] | undefined {
  if (!allowExpired && typeof payload.exp === 'number' && now > payload.exp + tolerance) {
    return 'expired'
  }
  if (typeof payload.nbf === 'number' && now + tolerance < payload.nbf) return 'not_yet_valid'
  if (typeof payload.iat === 'number' && now + tolerance < payload.iat) return 'issued_in_future'
  return undefined
}

function checkClaims(
  payload: JwtClaims,
  opts: VerifyOptions,
): JwtVerifyError['reason'] | undefined {
  if (opts.expectedIssuer && payload.iss !== opts.expectedIssuer) return 'issuer_mismatch'
  if (opts.expectedAudience) {
    const aud = payload.aud
    const ok = Array.isArray(aud)
      ? aud.includes(opts.expectedAudience)
      : aud === opts.expectedAudience
    if (!ok) return 'audience_mismatch'
  }
  return undefined
}

type ParsedJwt = {
  header: JwtHeader
  payload: JwtClaims
  signingInput: string
  signature: Uint8Array
}

function parseJwt(token: string): Result<ParsedJwt, JwtVerifyError> {
  const parts = token.split('.')
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return err('malformed')
  try {
    const header = parseSegment<JwtHeader>(parts[0])
    const payload = parseSegment<JwtClaims>(parts[1])
    if (!header.kid || !header.alg) return err('malformed')
    return {
      ok: true,
      value: {
        header,
        payload,
        signingInput: `${parts[0]}.${parts[1]}`,
        signature: base64UrlDecode(parts[2]),
      },
    }
  } catch {
    return err('malformed')
  }
}

async function verifySignature(
  parsed: ParsedJwt,
  key: VerifyKey | VerifyKeySet,
): Promise<JwtVerifyError['reason'] | undefined> {
  const resolved = resolveKey(parsed.header, key)
  if (!resolved) return 'unknown_kid'
  if (resolved.alg !== parsed.header.alg) return 'unsupported_alg'
  const valid = await crypto.subtle.verify(
    signAlgParams(parsed.header.alg),
    resolved.publicKey,
    toBufferSource(parsed.signature),
    encoder.encode(parsed.signingInput),
  )
  return valid ? undefined : 'bad_signature'
}

export async function verifyJwt(
  token: string,
  key: VerifyKey | VerifyKeySet,
  options: VerifyOptions = {},
): Promise<Result<VerifiedJwt, JwtVerifyError>> {
  const parsed = parseJwt(token)
  if (!parsed.ok) return parsed

  const sigReason = await verifySignature(parsed.value, key)
  if (sigReason) return err(sigReason)

  const { header, payload } = parsed.value
  const now = options.now ?? Math.floor(Date.now() / 1000)
  const tolerance = options.clockToleranceSec ?? 60
  const reason =
    checkTime(payload, now, tolerance, options.allowExpired ?? false) ??
    checkClaims(payload, options)
  if (reason) return err(reason)

  return { ok: true, value: { header, payload } }
}
