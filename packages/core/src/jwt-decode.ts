// 只解码 payload 读 exp 做刷新调度,不验签:token 来自同域 worker,验签属 backend/RS;篡改最多打乱刷新时机。

import { base64UrlDecodeToString } from '@xid-kit/crypto'

export type DecodedTokenClaims = {
  exp?: number
  iat?: number
  sub?: string
  sid?: string
  // guest session 会注入 'guest',供转正判定。
  amr?: string[]
}

// 解码失败返回 null,调用方按无 exp 立即刷新。
export function decodeTokenClaims(token: string): DecodedTokenClaims | null {
  const parts = token.split('.')
  if (parts.length !== 3 || !parts[1]) return null
  try {
    const json = base64UrlDecodeToString(parts[1])
    const parsed: unknown = JSON.parse(json)
    if (typeof parsed !== 'object' || parsed === null) return null
    return parsed as DecodedTokenClaims
  } catch {
    return null
  }
}

export function isTokenExpiring(token: string, nowSeconds: number, leewaySeconds: number): boolean {
  const claims = decodeTokenClaims(token)
  if (!claims || typeof claims.exp !== 'number') return true
  return nowSeconds + leewaySeconds >= claims.exp
}
