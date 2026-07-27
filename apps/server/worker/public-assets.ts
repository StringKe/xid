import type { Context, Hono } from 'hono'
import { resolveWebRouteOwnership } from '@xid-kit/types'
import type { XidHonoEnv } from './lib/types'
import { applySpaSecurityHeaders } from './security-headers'

async function serveSpaAsset(c: Context<XidHonoEnv>): Promise<Response> {
  const response = await c.env.ASSETS.fetch(c.req.raw)
  return applySpaSecurityHeaders(response)
}

function movedSurfaceNotFound(owner: 'site' | 'console'): Response {
  return new Response(null, {
    status: 404,
    headers: { 'x-xid-core-route-status': `owned-by-${owner}` },
  })
}

async function serveCoreSpaAsset(c: Context<XidHonoEnv>): Promise<Response> {
  const url = new URL(c.req.url)
  if (url.pathname === '/docs' || url.pathname.startsWith('/docs/')) {
    return movedSurfaceNotFound('site')
  }
  if (url.pathname === '/console' || url.pathname.startsWith('/console/')) {
    return movedSurfaceNotFound('console')
  }

  const decision = resolveWebRouteOwnership(url)
  if (decision.owner === 'site' || decision.owner === 'console') {
    return movedSurfaceNotFound(decision.owner)
  }
  return serveSpaAsset(c)
}

export function registerPublicAssetRoutes(app: Hono<XidHonoEnv>): void {
  // Site 和 Console 的具体 Worker Routes 正常情况下先于 Core 命中。
  // 此处仍 fail closed，避免 route 迁移或回滚窗口把已隔离的页面送回旧 SPA。
  app.all('/', serveCoreSpaAsset)
  app.all('*', serveCoreSpaAsset)
}
