// PKCE 委托 @xid-kit/protocol，SDK 层不重复实现。

import { computeS256Challenge, generateCodeVerifier } from '@xid-kit/protocol'
import { randomString } from '@xid-kit/crypto'

export { base64UrlEncode } from '@xid-kit/crypto'

// 不含 "~"：state 会作为 Expo SecureStore key，仅允许 [A-Za-z0-9._-]。
export function createRandomString(length: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  return randomString(length, chars)
}

export function createPkceVerifier(length: number = 64): string {
  return generateCodeVerifier(length)
}

export async function createPkceChallenge(verifier: string): Promise<string> {
  return computeS256Challenge(verifier)
}
