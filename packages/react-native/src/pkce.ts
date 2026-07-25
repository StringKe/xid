// PKCE S256 工具:委托 @xid-kit/protocol 的 generateCodeVerifier / computeS256Challenge,
// 不在 SDK 层重复实现(utils-abstraction 三次法则)。

import { computeS256Challenge, generateCodeVerifier } from '@xid-kit/protocol'

export { base64UrlEncode } from '@xid-kit/crypto'

// createRandomString:生成任意长度 URL-safe 随机字符串,用于 OAuth state(非 verifier)。
// verifier 固定 64 字符时调用方直接用 createPkceVerifier。
export function createRandomString(length: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  let out = ''
  for (const b of bytes) {
    out += chars[b % chars.length]
  }
  return out
}

// createPkceVerifier:生成符合 RFC 7636 的 code_verifier(43-128 字符,委托 @xid-kit/protocol)。
export function createPkceVerifier(length: number = 64): string {
  return generateCodeVerifier(length)
}

export async function createPkceChallenge(verifier: string): Promise<string> {
  return computeS256Challenge(verifier)
}
