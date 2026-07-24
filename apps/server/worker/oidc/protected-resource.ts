// RFC9728 protected resource metadata for XID-hosted OAuth resource endpoints.
// Metadata is derived from TenantContext and cached per issuer.

import { buildProtectedResourceMetadata } from '@xid-kit/protocol'
import type { ProtectedResourceMetadata } from '@xid-kit/protocol'
import type { Context, Hono } from 'hono'
import type { XidHonoEnv } from '../lib/types'
import { DISCOVERY_CACHE_TTL_SEC } from '../lib/ttl'

function cacheKey(tenantId: string, issuer: string): string {
  return `protected-resource:${tenantId}:${issuer}`
}

async function getMetadata(c: {
  env: Env
  tenantId: string
  issuer: string
  build: () => ProtectedResourceMetadata
}): Promise<ProtectedResourceMetadata> {
  const key = cacheKey(c.tenantId, c.issuer)
  const cached = await c.env.CACHE.get(key, 'json')
  if (cached) return cached as ProtectedResourceMetadata
  const meta = c.build()
  await c.env.CACHE.put(key, JSON.stringify(meta), {
    expirationTtl: DISCOVERY_CACHE_TTL_SEC,
  })
  return meta
}

export function registerProtectedResourceRoutes(app: Hono<XidHonoEnv>): void {
  app.get('/.well-known/oauth-protected-resource', async (c: Context<XidHonoEnv>) => {
    const ctx = c.get('tenant')
    const meta = await getMetadata({
      env: c.env,
      tenantId: ctx.tenantId,
      issuer: ctx.issuer,
      build: () => buildProtectedResourceMetadata({ ctx }),
    })
    return c.json(meta, 200, {
      'cache-control': `public, max-age=${DISCOVERY_CACHE_TTL_SEC}`,
    })
  })
}
