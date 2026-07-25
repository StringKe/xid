// tenant 中间件:从 Host 头解析 TenantContext 注入 c.set('tenant')。
// 解析走 @xid-kit/db resolveTenantContext(单租户=配置单例,多租户=按 Host 查 D1,见 tenant-context rule)。
// 铁律:issuer/签名密钥/rpId/策略唯一来源是 TenantContext,后续路由一律 c.get('tenant')。
// 解析失败返回 404 模糊响应(枚举防护:不泄露租户是否存在,见 anti-abuse rule)。

import { sha256Hex } from '@xid-kit/crypto'
import { resolveTenantContext, resolveTenantContextBySessionHash } from '@xid-kit/db'
import type { MiddlewareHandler } from 'hono'
import { readAllRefreshTokenCookies } from '../lib/cookies'
import { sessionCandidateFromRow } from '../lib/session'
import type { XidHonoEnv } from '../lib/types'

// 模糊 404:不区分"主机无对应租户"/"租户被暂停",统一最小响应体。
function notFound(): Response {
  return new Response(JSON.stringify({ error: 'not_found' }), {
    status: 404,
    headers: { 'content-type': 'application/json' },
  })
}

// 解析 TenantContext 并注入。失败短路返回 404,不进入后续 handler。
export const tenantMiddleware: MiddlewareHandler<XidHonoEnv> = async (c, next) => {
  const tokens = Object.values(readAllRefreshTokenCookies(c))
  for (const token of tokens) {
    const refreshTokenHash = await sha256Hex(token)
    const sessionResult = await resolveTenantContextBySessionHash(
      c.req.raw,
      c.env,
      refreshTokenHash,
    )
    if (!sessionResult.ok) continue
    c.set('tenant', sessionResult.value.tenant)
    if (sessionResult.value.status === 'resolved' && sessionResult.value.session) {
      c.set(
        'sessionCandidate',
        sessionCandidateFromRow(refreshTokenHash, sessionResult.value.session),
      )
    }
    await next()
    return
  }
  const result = await resolveTenantContext(c.req.raw, c.env)
  if (!result.ok) return notFound()
  c.set('tenant', result.value)
  await next()
}
