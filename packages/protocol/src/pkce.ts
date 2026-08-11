// PKCE:仅 S256,拒 plain,含 downgrade 防护(RFC7636 / oidc-oauth rule)。

import type { XidError, Result } from '@xid-kit/types'
import { base64UrlEncode, randomString } from '@xid-kit/crypto'

const encoder = new TextEncoder()

// RFC7636:verifier 为 unreserved 字符,长度 43-128。
const VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/

export type PkceMethod = 'S256' | 'plain'

function invalidRequest(message: string): Result<true, XidError> {
  return { ok: false, error: { code: 'invalid_request', message, httpStatus: 400 } }
}

function invalidGrant(message: string): Result<true, XidError> {
  return { ok: false, error: { code: 'invalid_grant', message, httpStatus: 400 } }
}

// constant-time 比较,避免 challenge 前缀匹配长度侧信道。
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

export async function computeS256Challenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(verifier))
  return base64UrlEncode(new Uint8Array(digest))
}

export function generateCodeVerifier(length: number = 64): string {
  const bounded = Math.min(128, Math.max(43, length))
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'
  return randomString(bounded, chars)
}

export async function verifyPkce(
  verifier: string,
  challenge: string,
  method: PkceMethod,
): Promise<Result<true, XidError>> {
  // 拒 plain:downgrade 攻击防护。
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

// require_pkce 或授权时已存 challenge 时,兑换必须带 verifier,防止降级。
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
