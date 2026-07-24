// POST /auth/sign-out:登出当前 session(前端 auth-context signOut)。
// readSession 取当前 session -> revokeSession(SessionDO revoke + D1 status=revoked + 清 cookie)。
// 幂等:无 session 也返回 2xx(前端只 setQueryData(me,null),不读 body)。body 可忽略(测试曾带 {reason})。

import type { Context } from 'hono'
import type { XidHonoEnv } from '../lib/types'
import { readSession, revokeSession } from '../lib/session'
import { initiateOutboundSamlLogout } from '../sso/outbound-saml'

export async function handleSignOut(c: Context<XidHonoEnv>): Promise<Response> {
  const session = c.get('session') ?? (await readSession(c))
  if (session) {
    await initiateOutboundSamlLogout(c, session)
    await revokeSession(c, session)
  }
  return c.json({ ok: true })
}
