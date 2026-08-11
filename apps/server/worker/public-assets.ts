import type { Context, Hono } from 'hono'
import { isCoreSpaRoute, resolveWebRouteOwnership } from '@xid-kit/types'
import type { XidHonoEnv } from './lib/types'
import { applySpaSecurityHeaders } from './security-headers'

async function serveSpaAsset(c: Context<XidHonoEnv>, request = c.req.raw): Promise<Response> {
  const response = await c.env.ASSETS.fetch(request)
  return applySpaSecurityHeaders(response)
}

function delegateFrontendRequest(
  c: Context<XidHonoEnv>,
  owner: 'site' | 'console',
): Promise<Response> {
  // CF Route 含完整 URL(含 query),精确前端路由带 query 会落到 Core;单向 Service Binding 不回环。
  return owner === 'site'
    ? c.env.SITE_WORKER.fetch(c.req.raw)
    : c.env.CONSOLE_WORKER.fetch(c.req.raw)
}

export function registerFrontendRouteDelegation(app: Hono<XidHonoEnv>): void {
  // 须先于 tenant/协议中间件:`/scim` 是 Site 文档,`/scim/*` 是 Core 协议,契约先区分。
  app.use('*', async (c, next) => {
    const decision = resolveWebRouteOwnership(c.req.url)
    if (decision.owner === 'site' || decision.owner === 'console') {
      return delegateFrontendRequest(c, decision.owner)
    }
    await next()
  })
}

function spaEntryRequest(request: Request): Request {
  const url = new URL(request.url)
  // Assets 会把 /index.html 规范成 /;直接 fetch `/` 以保留客户端路由与 query。
  url.pathname = '/'
  url.search = ''
  return new Request(url, request)
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
  if (isCoreSpaRoute(url.pathname)) {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      return new Response(null, { status: 404 })
    }
    return serveSpaAsset(c, spaEntryRequest(c.req.raw))
  }
  return serveSpaAsset(c)
}

export function registerPublicAssetRoutes(app: Hono<XidHonoEnv>): void {
  // Site 和 Console 的具体 Worker Routes 正常情况下先于 Core 命中。
  // 此处仍 fail closed，避免 route 迁移或回滚窗口把已隔离的页面送回旧 SPA。
  app.all('/', serveCoreSpaAsset)
  app.all('*', serveCoreSpaAsset)
}
