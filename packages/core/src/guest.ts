// guest 模式判定与 sub 对比工具。
// 判定口径与 Hosted UI isGuestUser(apps/server/src/lib/auth-context.tsx)一致:
// 仅认 provisioned_by === 'anonymous';token 场景另认 amr 含 'guest'。

import type { DecodedTokenClaims } from './jwt-decode'
import type { XidUser } from './types'

// guest 用户判定:仅认 provisionedBy === 'anonymous'(/v1/me 契约字段)。
export function isGuestUser(user: XidUser | null | undefined): boolean {
  return user?.provisionedBy === 'anonymous'
}

// token 视角的 guest 判定:getToken 解码后 amr 含 'guest'(worker 颁发时注入)。
export function isGuestToken(claims: DecodedTokenClaims | null | undefined): boolean {
  return claims?.amr?.includes('guest') ?? false
}

// sub 对比:guest 原地转正 sub 不变,转而登入既有账号 sub 会变。
// RP 在 session 切换前后各取一次 user.id,用此判定是否触发数据合并;任一为空视为不可比。
export function isSameUser(
  prevUserId: string | null | undefined,
  nextUserId: string | null | undefined,
): boolean {
  if (!prevUserId || !nextUserId) return false
  return prevUserId === nextUserId
}
