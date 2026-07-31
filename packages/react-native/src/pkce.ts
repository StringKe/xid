// PKCE S256 工具:委托 @xid-kit/protocol 的 generateCodeVerifier / computeS256Challenge,
// 不在 SDK 层重复实现(utils-abstraction 三次法则)。

import { computeS256Challenge, generateCodeVerifier } from '@xid-kit/protocol'
import { randomString } from '@xid-kit/crypto'

export { base64UrlEncode } from '@xid-kit/crypto'

// createRandomString:生成 base64url 字符集的随机字符串,用于 OAuth state / nonce。
// 不使用 "~",因为 state 同时进入 Expo SecureStore key,其 key 字符集只允许 [A-Za-z0-9._-]。
// verifier 固定 64 字符时调用方直接用 createPkceVerifier。
export function createRandomString(length: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  return randomString(length, chars)
}

// createPkceVerifier:生成符合 RFC 7636 的 code_verifier(43-128 字符,委托 @xid-kit/protocol)。
export function createPkceVerifier(length: number = 64): string {
  return generateCodeVerifier(length)
}

export async function createPkceChallenge(verifier: string): Promise<string> {
  return computeS256Challenge(verifier)
}
