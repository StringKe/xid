// guest 转正(Firebase 式"原地转正")统一钩子:guest session 有效时,首个凭证仪式把凭证
// 挂到当前 guest user 而不是新建 user(见 docs/design/01-authentication.md guest 模式)。
// 四个切入点(passwordless OTP / password / passkey register / social 分支 D)共用两件套:
//   loadGuestConversionContext:判定当前请求是否持 live guest session。跨租户隔离由租户查询层
//     保证 -- A 租户 guest 的 user/session 行在 B 租户 scoped db 下查不到,自然落回原有路径。
//   markGuestConverted:凭证挂上后调用 -- provisionedBy 改写 + 吊销旧 guest session(防 session
//     fixation 变体)+ guest.converted 审计(waitUntil 不阻塞)+ GuestStore 解绑(防向已转正
//     账号续签 guest)。
// 新 session 不在此统一签发:各仪式 authContext / MFA gate / rememberMe 不同,由调用方按既有
// 流程调 resolvePostAuthMfaGate + issueSession 完成轮换(guest 建号绕过 MFA gate,转正必须
// 恢复正常评估)。

import { createTenantDb, schema } from '@xid-kit/db'
import { eq } from 'drizzle-orm'
import type { Context } from 'hono'
import type { SessionData, TenantVar, XidHonoEnv } from '../lib/types'
import { ACTIVE_SESSION_STATUS, readSession, revokeSession } from '../lib/session'
import { readAnonKey } from '../auth/passkey-helpers'
import { loadLiveGuestUser, unbindGuestAnonKey } from './guest'

export type GuestConversionContext = {
  session: SessionData
  userId: string
}

// 当前请求是否持 live guest session:session active 且 user 仍是 anonymous 在租账号。
// 无 session / 非 guest / 已转正 / 跨租户不可见都返回 null(调用方走原有路径)。
export async function loadGuestConversionContext(
  c: Context<XidHonoEnv>,
  db: ReturnType<typeof createTenantDb>,
): Promise<GuestConversionContext | null> {
  const session = c.get('session') ?? (await readSession(c, [ACTIVE_SESSION_STATUS]))
  if (!session || session.status !== ACTIVE_SESSION_STATUS) return null
  const guest = await loadLiveGuestUser(db, session.userId)
  if (!guest) return null
  return { session, userId: guest.id }
}

// 审计不阻塞登录链路(cloudflare-bindings rule):入队挂 waitUntil,失败只进日志。
function emitGuestConvertedAudit(c: Context<XidHonoEnv>, tenantId: string, userId: string): void {
  const task = c.env.AUDIT_QUEUE.send({
    tenantId,
    action: 'guest.converted',
    actorId: userId,
    ts: Date.now(),
    payload: { targetType: 'user', targetId: userId },
  })
  try {
    c.executionCtx.waitUntil(task)
  } catch {
    void task.catch((error: unknown) => console.error('[guest] audit queue send failed', error))
  }
}

// 转正主钩子。provisionedBy 取各仪式建号时的既有取值(social 建号不写 provisionedBy,故传 null)。
export async function markGuestConverted(opts: {
  c: Context<XidHonoEnv>
  tenant: TenantVar
  db: ReturnType<typeof createTenantDb>
  guest: GuestConversionContext
  provisionedBy: string | null
}): Promise<void> {
  const { c, tenant, db, guest, provisionedBy } = opts
  await db.users.update({ provisionedBy }, eq(schema.users.id, guest.userId))
  await revokeSession(c, guest.session)
  emitGuestConvertedAudit(c, tenant.tenantId, guest.userId)
  const anonKey = readAnonKey(c)
  if (anonKey) await unbindGuestAnonKey(c.env, tenant.tenantId, anonKey)
}
