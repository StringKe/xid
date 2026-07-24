// session 中间件(可选):从 cookie 解析当前 session 注入 c.set('session')。
// 未登录/无效 cookie 时注入 null,不短路(可选认证;强制认证由路由各自校验)。
// 依赖 tenant 中间件已注入 c.get('tenant')(D1 查询走租户隔离层,见 tenant-isolation rule)。

import type { MiddlewareHandler } from 'hono'
import { AUTHENTICATED_SESSION_STATUSES, readSession } from '../lib/session'
import type { XidHonoEnv } from '../lib/types'

// 解析 cookie -> readSession(SessionDO is-active + D1 status/过期校验)-> c.set('session')。
export const sessionMiddleware: MiddlewareHandler<XidHonoEnv> = async (c, next) => {
  const session = await readSession(c, AUTHENTICATED_SESSION_STATUSES)
  c.set('session', session)
  await next()
}
