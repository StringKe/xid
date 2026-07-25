import { randomString } from '@xid-kit/crypto'

// PKCE 测试向量(见 oidc-oauth rule、RFC7636)。
// 合法 S256 对用 Web Crypto 真算;plain challenge 拒绝向量为预定义常量。
// 向量本身由 pkce.test.ts 的自检套件覆盖。

// base64url 无填充编码(RFC4648 Section 5)。
function base64UrlEncode(bytes: Uint8Array): string {
  const base64 = btoa(String.fromCharCode(...bytes))
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

// base64url 解码为 Uint8Array。
function base64UrlDecode(s: string): Uint8Array {
  const padded = s
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(s.length + ((4 - (s.length % 4)) % 4), '=')
  const bstr = atob(padded)
  const bytes = new Uint8Array(bstr.length)
  for (let i = 0; i < bstr.length; i++) {
    bytes[i] = bstr.charCodeAt(i)
  }
  return bytes
}

// S256 code_challenge = BASE64URL(SHA-256(ASCII(code_verifier)))(RFC7636 S4.2)。
async function computeS256Challenge(verifier: string): Promise<string> {
  const encoded = new TextEncoder().encode(verifier)
  const digest = await crypto.subtle.digest('SHA-256', encoded)
  return base64UrlEncode(new Uint8Array(digest))
}

// 生成加密安全 verifier(43-128 字符,unreserved chars)。
function generateVerifier(length: number = 64): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'
  return randomString(length, chars)
}

// 合法 S256 向量:verifier + 对应 challenge。
export type ValidPkceVector = {
  description: string
  verifier: string
  challenge: string
  method: 'S256'
}

// 构建合法向量(异步,需要 Web Crypto)。
export async function buildValidS256Vectors(): Promise<ValidPkceVector[]> {
  const vectors: ValidPkceVector[] = []

  // 向量 1:最小长度 43 字符 verifier(RFC7636 S4.1 min=43)。
  const v1 = generateVerifier(43)
  vectors.push({
    description: 'minimum length verifier (43 chars)',
    verifier: v1,
    challenge: await computeS256Challenge(v1),
    method: 'S256',
  })

  // 向量 2:推荐长度 64 字符 verifier。
  const v2 = generateVerifier(64)
  vectors.push({
    description: 'recommended length verifier (64 chars)',
    verifier: v2,
    challenge: await computeS256Challenge(v2),
    method: 'S256',
  })

  // 向量 3:最大长度 128 字符 verifier(RFC7636 S4.1 max=128)。
  const v3 = generateVerifier(128)
  vectors.push({
    description: 'maximum length verifier (128 chars)',
    verifier: v3,
    challenge: await computeS256Challenge(v3),
    method: 'S256',
  })

  return vectors
}

// plain challenge 拒绝向量(oidc-oauth rule:强制 S256,拒 plain)。
export type PlainChallengeRejectVector = {
  description: string
  verifier: string
  // plain challenge = verifier 本身
  challenge: string
  method: 'plain'
  expectedErrorCode: 'invalid_request'
}

export const PLAIN_CHALLENGE_REJECT_VECTORS: readonly PlainChallengeRejectVector[] = [
  {
    description: 'plain method must be rejected (downgrade attack)',
    verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    challenge: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    method: 'plain',
    expectedErrorCode: 'invalid_request',
  },
  {
    description: 'plain method with short verifier must be rejected',
    verifier: 'short-verifier',
    challenge: 'short-verifier',
    method: 'plain',
    expectedErrorCode: 'invalid_request',
  },
]

// helper:验证 S256 挑战与 verifier 是否匹配。
export async function verifyS256Challenge(verifier: string, challenge: string): Promise<boolean> {
  const expected = await computeS256Challenge(verifier)
  return expected === challenge
}

export { base64UrlEncode, base64UrlDecode, computeS256Challenge }
