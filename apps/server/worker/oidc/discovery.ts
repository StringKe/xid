// Discovery 端点(03 章 1、9):/.well-known/openid-configuration 与
// /.well-known/oauth-authorization-server 合并输出同一份元数据(避免两份不一致)。
// 调 @xid-kit/protocol buildDiscoveryMetadata 从 TenantContext 派生;经 KV 缓存(P50<2ms)。

import { buildDiscoveryMetadata } from '@xid-kit/protocol'
import type { DiscoveryMetadata } from '@xid-kit/protocol'
import type { Context, Hono } from 'hono'
import type { XidHonoEnv } from '../lib/types'
import { DISCOVERY_CACHE_TTL_SEC } from '../lib/ttl'

function cacheKey(tenantId: string, issuer: string): string {
  return `discovery:${tenantId}:${issuer}`
}

// 取缓存或计算(KV miss 时 buildDiscoveryMetadata 并回填)。
async function getMetadata(c: {
  env: Env
  tenantId: string
  issuer: string
  build: () => DiscoveryMetadata
}): Promise<DiscoveryMetadata> {
  const key = cacheKey(c.tenantId, c.issuer)
  const cached = await c.env.CACHE.get(key, 'json')
  if (cached) return cached as DiscoveryMetadata
  const meta = c.build()
  await c.env.CACHE.put(key, JSON.stringify(meta), { expirationTtl: DISCOVERY_CACHE_TTL_SEC })
  return meta
}

// 注册 discovery 路由(wire 阶段统一挂载到 worker app)。
export function registerDiscoveryRoutes(app: Hono<XidHonoEnv>): void {
  const handler = async (c: Context<XidHonoEnv>): Promise<Response> => {
    const ctx = c.get('tenant')
    // require_par 是 FAPI 2.0 租户策略(03 章 10.3);TenantPolicy 未含该字段时默认 false。
    const meta = await getMetadata({
      env: c.env,
      tenantId: ctx.tenantId,
      issuer: ctx.issuer,
      build: () =>
        buildDiscoveryMetadata({
          ctx,
          requirePar: false,
          mtlsSupported: true,
          fapiProfileSupported: ctx.policy.oidcProfiles?.fapiProfileSupported === true,
          browserBasedAppsProfileSupported:
            ctx.policy.oidcProfiles?.browserBasedAppsProfileSupported === true,
        }),
    })
    return c.json(meta, 200, {
      'cache-control': `public, max-age=${DISCOVERY_CACHE_TTL_SEC}`,
      'access-control-allow-origin': '*',
    })
  }

  app.get('/.well-known/openid-configuration', handler)
  app.get('/.well-known/oauth-authorization-server', handler)
}
