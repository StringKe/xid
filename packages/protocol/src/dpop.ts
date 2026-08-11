// DPoP proof 自洽校验(RFC9449):产出 jkt/htu;jti 防重放缓存由 endpoint 层注入。

import type { XidError, Result, SigningAlg } from '@xid-kit/types'
import {
  base64UrlDecode,
  base64UrlDecodeToString,
  base64UrlEncode,
  importJwkForVerify,
  toBufferSource,
} from '@xid-kit/crypto'

const encoder = new TextEncoder()
const DEFAULT_IAT_WINDOW_SEC = 60

// 非对称签名白名单:禁 none / 对称 MAC;discovery 同源引用防漂移。
export const ALLOWED_DPOP_ALGS: readonly SigningAlg[] = ['ES256', 'RS256', 'PS256']

export type DpopJoseHeader = {
  typ?: string
  alg?: string
  jwk?: JsonWebKey
}

export type DpopPayload = {
  jti?: string
  htm?: string
  htu?: string
  iat?: number
  nonce?: string
  ath?: string
}

export type DpopVerified = {
  jkt: string
  jti: string
  htu: string
  iat: number
  nonce?: string
}

function invalidDpop(message: string): Result<never, XidError> {
  return { ok: false, error: { code: 'invalid_dpop_proof', message, httpStatus: 400 } }
}

// endpoint 映射为 use_dpop_nonce + DPoP-Nonce 头。
function useDpopNonce(message: string): Result<never, XidError> {
  return { ok: false, error: { code: 'use_dpop_nonce', message, httpStatus: 400 } }
}

function decodeSegment<T>(segment: string): T {
  return JSON.parse(base64UrlDecodeToString(segment)) as T
}

// RFC7638:EC 用 {crv,kty,x,y},RSA 用 {e,kty,n},lexical 排序且无空格。
function canonicalThumbprintInput(jwk: JsonWebKey): string | null {
  if (jwk.kty === 'EC' && jwk.crv && jwk.x && jwk.y) {
    return `{"crv":"${jwk.crv}","kty":"EC","x":"${jwk.x}","y":"${jwk.y}"}`
  }
  if (jwk.kty === 'RSA' && jwk.e && jwk.n) {
    return `{"e":"${jwk.e}","kty":"RSA","n":"${jwk.n}"}`
  }
  return null
}

export async function computeJkt(jwk: JsonWebKey): Promise<string | null> {
  const canonical = canonicalThumbprintInput(jwk)
  if (canonical === null) return null
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(canonical)))
  return base64UrlEncode(digest)
}

// 去 query/fragment,scheme/host 小写。
export function normalizeHtu(url: string): string {
  try {
    const u = new URL(url)
    u.search = ''
    u.hash = ''
    return u.toString()
  } catch {
    return url
  }
}

function jwkHasPrivateParams(jwk: JsonWebKey): boolean {
  // jwk 不得含私钥参数(d / RSA CRT)。
  return Boolean(jwk.d || jwk.p || jwk.q || jwk.dp || jwk.dq || jwk.qi)
}

type ParsedProof = {
  header: DpopJoseHeader
  payload: DpopPayload
  jwk: JsonWebKey
  alg: SigningAlg
  parts: [string, string, string]
}

function validateProofHeader(header: DpopJoseHeader): string | null {
  if (header.typ !== 'dpop+jwt') return 'DPoP typ must be dpop+jwt'
  if (!header.alg || !ALLOWED_DPOP_ALGS.includes(header.alg as SigningAlg)) {
    return 'DPoP alg must be an asymmetric signature algorithm'
  }
  if (!header.jwk || jwkHasPrivateParams(header.jwk)) {
    return 'DPoP jwk missing or contains private key parameters'
  }
  return null
}

function parseProof(proof: string): { error: string } | ParsedProof {
  const parts = proof.split('.')
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    return { error: 'DPoP proof must be a compact JWS' }
  }
  let header: DpopJoseHeader
  let payload: DpopPayload
  try {
    header = decodeSegment<DpopJoseHeader>(parts[0])
    payload = decodeSegment<DpopPayload>(parts[1])
  } catch {
    return { error: 'DPoP proof header/payload not valid base64url JSON' }
  }
  const headerErr = validateProofHeader(header)
  if (headerErr) return { error: headerErr }
  return {
    header,
    payload,
    jwk: header.jwk as JsonWebKey,
    alg: header.alg as SigningAlg,
    parts: [parts[0], parts[1], parts[2]],
  }
}

async function verifyProofSignature(parsed: ParsedProof): Promise<boolean> {
  const publicKey = await importJwkForVerify({
    ...parsed.jwk,
    kid: 'dpop',
    use: 'sig',
    alg: parsed.alg,
  })
  const signingInput = `${parsed.parts[0]}.${parsed.parts[1]}`
  return crypto.subtle.verify(
    signAlgParams(parsed.alg),
    publicKey,
    toBufferSource(base64UrlDecode(parsed.parts[2])),
    encoder.encode(signingInput),
  )
}

// requireNonce 为真时 nonce 缺失/不匹配返回 use_dpop_nonce。
export async function verifyDpopProof(input: {
  proof: string
  expectedHtm: string
  expectedHtu: string
  now: number
  iatWindowSec?: number
  requireNonce?: boolean
  validNonce?: string
}): Promise<Result<DpopVerified, XidError>> {
  const parsed = parseProof(input.proof)
  if ('error' in parsed) return invalidDpop(parsed.error)

  if (!(await verifyProofSignature(parsed))) {
    return invalidDpop('DPoP signature verification failed')
  }

  const claimErr = validateDpopClaims(parsed.payload, input)
  if (claimErr) return invalidDpop(claimErr)

  if (input.requireNonce && parsed.payload.nonce !== input.validNonce) {
    return useDpopNonce('DPoP proof missing or stale nonce')
  }

  const jkt = await computeJkt(parsed.jwk)
  if (jkt === null) return invalidDpop('cannot derive jkt from DPoP jwk')

  return {
    ok: true,
    value: {
      jkt,
      jti: parsed.payload.jti as string,
      htu: normalizeHtu(parsed.payload.htu as string),
      iat: parsed.payload.iat as number,
      nonce: parsed.payload.nonce,
    },
  }
}

async function computeAth(accessToken: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(accessToken)))
  return base64UrlEncode(digest)
}

// 资源端:额外校验 ath=SHA256(access_token) 且 jkt 与绑定一致。
export async function verifyDpopForResource(input: {
  proof: string
  expectedHtm: string
  expectedHtu: string
  now: number
  accessToken: string
  boundJkt: string
  iatWindowSec?: number
}): Promise<Result<DpopVerified, XidError>> {
  const base = await verifyDpopProof({
    proof: input.proof,
    expectedHtm: input.expectedHtm,
    expectedHtu: input.expectedHtu,
    now: input.now,
    iatWindowSec: input.iatWindowSec,
  })
  if (!base.ok) return base
  const parsed = parseProof(input.proof)
  if ('error' in parsed) return invalidDpop(parsed.error)
  const expectedAth = await computeAth(input.accessToken)
  if (parsed.payload.ath !== expectedAth) return invalidDpop('DPoP ath missing or mismatch')
  if (base.value.jkt !== input.boundJkt) return invalidDpop('DPoP jkt does not match bound token')
  return base
}

function validateDpopClaims(
  payload: DpopPayload,
  input: { expectedHtm: string; expectedHtu: string; now: number; iatWindowSec?: number },
): string | null {
  if (!payload.jti || !payload.htm || !payload.htu || typeof payload.iat !== 'number') {
    return 'DPoP payload missing jti/htm/htu/iat'
  }
  // htm 大小写敏感。
  if (payload.htm !== input.expectedHtm) return 'DPoP htm mismatch'
  if (normalizeHtu(payload.htu) !== normalizeHtu(input.expectedHtu)) return 'DPoP htu mismatch'
  const window = input.iatWindowSec ?? DEFAULT_IAT_WINDOW_SEC
  if (Math.abs(input.now - payload.iat) > window) return 'DPoP iat outside acceptable window'
  return null
}

function signAlgParams(alg: SigningAlg): SubtleCryptoSignAlgorithm {
  if (alg === 'ES256') return { name: 'ECDSA', hash: 'SHA-256' }
  if (alg === 'PS256') return { name: 'RSA-PSS', saltLength: 32 }
  return { name: 'RSASSA-PKCS1-v1_5' }
}

export { DEFAULT_IAT_WINDOW_SEC }
