// JWT 签发/校验(自研协议逻辑,见 crypto-boundary rule:JWT 签发校验全自研;原语用 Web Crypto)。
// 支持 ES256(默认)/RS256/PS256。ES256 走 JOSE P1363(r||s)定长签名,Web Crypto ECDSA 原生即 P1363,无需 DER 转换。
// verify 校验 exp/iat 与签名,可预期失败返回 Result(见错误处理铁律);格式损坏 throw。

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

// alg -> Web Crypto sign/verify 算法参数(workers-types SubtleCryptoSignAlgorithm)。
function signAlgParams(alg: SigningAlg): SubtleCryptoSignAlgorithm {
  if (alg === 'ES256') return { name: 'ECDSA', hash: 'SHA-256' }
  if (alg === 'PS256') return { name: 'RSA-PSS', saltLength: P256_COORD_BYTES }
  return { name: 'RSASSA-PKCS1-v1_5' }
}

// 签发 JWT。header 强制带 kid(见 signing-keys rule 多 kid)。signingKey 为不可导出私钥句柄。
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

// 校验输入:单个公钥(带 alg)或 JWKS(按 kid 选公钥)。
export type VerifyKey = { alg: SigningAlg; publicKey: CryptoKey }
export type VerifyKeySet = {
  keys: readonly { kid: string; alg: SigningAlg; publicKey: CryptoKey }[]
}

export type VerifyOptions = {
  // 当前时间(秒);默认 now。用于 exp/nbf/iat 判定。
  now?: number
  // exp/nbf 容忍偏差(秒),默认 60。
  clockToleranceSec?: number
  // 跳过 exp 判定(RP-Initiated Logout 的 id_token_hint 允许已过期);nbf/iat 仍按
  // clockToleranceSec 校验,不放宽成无限容差,否则未来签发的 token 会一并被放行。
  allowExpired?: boolean
  // 期望 iss / aud,提供则校验。
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
  // 单钥占位:已导入的 CryptoKey 无 kid(toVerifyKeySet 填占位 ''),token 带真实 kid 时仍用该唯一 key 验签。
  // 仅当唯一 key 的 kid 为空才放宽;有真实 kid 的多/单钥集一律要求精确匹配,保持轮换隔离与 unknown_kid 语义。
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

// 解析三段:拆 header/payload,校验格式与必备字段。
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

// 选公钥 + alg 匹配 + 验签。
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

// 校验 JWT:kid 选公钥 -> alg 匹配 -> 验签 -> exp/nbf/iat -> iss/aud。任一失败返回 Result error,不抛。
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
