// PKCE 校验(RFC7636 + oidc-oauth rule:S256 强制,拒 plain;downgrade 防护)。
// 原语只用 Web Crypto(crypto.subtle.digest),格式编解码复用 @xid-kit/crypto base64url。
// 可预期失败返回 Result<true, XidError>,不抛。

import type { XidError, Result } from '@xid-kit/types'
import { base64UrlEncode, randomString } from '@xid-kit/crypto'

const encoder = new TextEncoder()

// RFC7636 4.1:code_verifier 字符集 [A-Za-z0-9._~-],长度 43-128。
const VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/

export type PkceMethod = 'S256' | 'plain'

function invalidRequest(message: string): Result<true, XidError> {
  return { ok: false, error: { code: 'invalid_request', message, httpStatus: 400 } }
}

function invalidGrant(message: string): Result<true, XidError> {
  return { ok: false, error: { code: 'invalid_grant', message, httpStatus: 400 } }
}

// constant-time 字符串比较,避免泄露 challenge 前缀匹配长度(RFC7636 4.6 隐含)。
function constantTimeEqual(a: string, b: string): boolean {
  const ba = encoder.encode(a)
  const bb = encoder.encode(b)
  let diff = ba.length ^ bb.length
  const len = Math.max(ba.length, bb.length)
  for (let i = 0; i < len; i++) {
    diff |= (ba[i] ?? 0) ^ (bb[i] ?? 0)
  }
  return diff === 0
}

// S256 code_challenge = BASE64URL(SHA-256(ASCII(code_verifier)))(RFC7636 4.2)。
export async function computeS256Challenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(verifier))
  return base64UrlEncode(new Uint8Array(digest))
}

// 生成加密安全 verifier(unreserved 字符,默认 64,范围 43-128)。
export function generateCodeVerifier(length: number = 64): string {
  const bounded = Math.min(128, Math.max(43, length))
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'
  return randomString(bounded, chars)
}

// 校验 PKCE(9.1 第 6 步)。method=plain 一律拒绝 invalid_request;S256 走 constant-time 比较。
export async function verifyPkce(
  verifier: string,
  challenge: string,
  method: PkceMethod,
): Promise<Result<true, XidError>> {
  // 拒 plain(downgrade 攻击防护,oidc-oauth rule)。
  if (method !== 'S256') {
    return invalidRequest('PKCE method must be S256; plain is rejected')
  }
  if (!VERIFIER_PATTERN.test(verifier)) {
    return invalidRequest('code_verifier must be 43-128 chars from [A-Za-z0-9._~-]')
  }
  const expected = await computeS256Challenge(verifier)
  if (!constantTimeEqual(expected, challenge)) {
    return invalidGrant('PKCE code_verifier does not match code_challenge')
  }
  return { ok: true, value: true }
}

// downgrade 防护(9.1 第 6 步末、第 2 节):client 注册过 challenge(require_pkce)后,
// 本次 authorization_code 兑换缺失 challenge 即拒。registeredChallenge 取自授权时存的 code 记录。
export function enforcePkceBinding(input: {
  requirePkce: boolean
  registeredChallenge: string | null
  presentedVerifier: string | null
}): Result<true, XidError> {
  const hasChallenge = input.registeredChallenge !== null
  if ((input.requirePkce || hasChallenge) && input.presentedVerifier === null) {
    return invalidGrant('code_verifier required: PKCE was registered for this client')
  }
  if (input.requirePkce && !hasChallenge) {
    return invalidGrant('PKCE downgrade rejected: client requires code_challenge')
  }
  return { ok: true, value: true }
}
