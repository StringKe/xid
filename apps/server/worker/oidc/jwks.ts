// /jwks 端点(03 章 1、signing-keys rule):多 kid 并行输出所有未过期公钥,轮换不中断验证。
// 公钥集来自 TenantContext active 密钥材料,经 @xid-kit/crypto buildJwks 组装;KV 缓存 TTL 1h。

import { buildJwks } from '@xid-kit/crypto'
import type { Jwks } from '@xid-kit/crypto'
import type { Context, Hono } from 'hono'
import type { XidHonoEnv } from '../lib/types'
import { JWKS_CACHE_TTL_SEC } from '../lib/ttl'

function cacheKey(issuer: string, activeKid: string): string {
  // 含 activeKid:轮换 publish_next 改变密钥集时 key 变化,旧缓存自然失效。
  return `jwks:${issuer}:${activeKid}`
}

async function getJwks(c: Context<XidHonoEnv>): Promise<Jwks> {
  const ctx = c.get('tenant')
  const key = cacheKey(ctx.issuer, ctx.signingKeys.activeKid)
  const cached = await c.env.CACHE.get(key, 'json')
  if (cached) return cached as Jwks
  const jwks = buildJwks(ctx.signingKeys.keys)
  await c.env.CACHE.put(key, JSON.stringify(jwks), { expirationTtl: JWKS_CACHE_TTL_SEC })
  return jwks
}

// 注册 /jwks 路由(wire 阶段统一挂载)。
export function registerJwksRoutes(app: Hono<XidHonoEnv>): void {
  app.get('/jwks', async (c) => {
    const jwks = await getJwks(c)
    return c.json(jwks, 200, {
      'content-type': 'application/jwk-set+json',
      'cache-control': `public, max-age=${JWKS_CACHE_TTL_SEC}`,
    })
  })
}
