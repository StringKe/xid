// guest 口径与 Hosted UI 一致:仅 provisionedBy==='anonymous';token 侧另认 amr 含 'guest'。

import type { DecodedTokenClaims } from './jwt-decode'
import type { XidUser } from './types'

export function isGuestUser(user: XidUser | null | undefined): boolean {
  return user?.provisionedBy === 'anonymous'
}

export function isGuestToken(claims: DecodedTokenClaims | null | undefined): boolean {
  return claims?.amr?.includes('guest') ?? false
}

// 原地转正 sub 不变、登入既有账号会变;RP 用此决定是否合并数据,任一侧为空视为不可比。
export function isSameUser(
  prevUserId: string | null | undefined,
  nextUserId: string | null | undefined,
): boolean {
  if (!prevUserId || !nextUserId) return false
  return prevUserId === nextUserId
}
