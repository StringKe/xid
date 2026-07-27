// 仅解码 JWT payload 读 exp,不验签。
// 安全前提:core 拿到的 token 来自同域 worker(HttpOnly cookie + /sessions/token),
// 验签是 backend(networkless)与 resource server 的职责,core 不持公钥也不在前端验签(见 crypto-boundary rule)。
// 这里只为"到期前刷新"读 exp/iat,被篡改的 token 也只导致提前/延后刷新,不构成信任决策。

import { base64UrlDecodeToString } from '@xid-kit/crypto'

// 解码出的最小 claims 视图(仅刷新调度需要)。
export type DecodedTokenClaims = {
  exp?: number
  iat?: number
  sub?: string
  sid?: string
  // authentication methods reference;guest session 的 token 含 'guest'(转正判定来源之一)。
  amr?: string[]
}

// 解码失败返回 null(交由调用方按"无 exp"处理,即立即刷新),不抛。
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

// token 是否已过期或在 leeway 窗口内(nowSeconds 为当前秒)。无 exp 视为需刷新。
export function isTokenExpiring(token: string, nowSeconds: number, leewaySeconds: number): boolean {
  const claims = decodeTokenClaims(token)
  if (!claims || typeof claims.exp !== 'number') return true
  return nowSeconds + leewaySeconds >= claims.exp
}
