import type { Context, Hono } from 'hono'
import { resolveTenantContext } from '@xid-kit/db'
import {
  ACCOUNT_EXACT_PATH,
  defaultLandingPathFor,
  isConsoleRoute,
  isCoreSpaRoute,
  resolveWebRouteOwnership,
} from '@xid-kit/types'
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

// 归属规则按 Host 判定;本地与 Service Binding 场景下请求 URL 可能是回环地址,Host 才是真实主机。
function isRuleOwnedConsoleHost(c: Context<XidHonoEnv>): boolean {
  const url = new URL(c.req.url)
  const host = c.req.header('host')
  if (host) url.host = host
  return resolveWebRouteOwnership(url).owner === 'console'
}

// 归属规则已把 /console 划给 Console Worker 的主机(xid.dev 及其租户子域)落到 Core 说明 route 缺失或
// 回滚,fail closed 返回 404。其余主机:自定义域名只承载 Hosted Auth 与账户门户,改落 /account;
// 实例主域名不是 xid.dev 的自托管部署(及其租户子域)交给 Console Worker;无法解析的主机仍 404。
async function serveUnroutedConsole(c: Context<XidHonoEnv>): Promise<Response> {
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return movedSurfaceNotFound('console')
  if (isRuleOwnedConsoleHost(c)) return movedSurfaceNotFound('console')
  const tenant = await resolveTenantContext(c.req.raw, c.env)
  if (!tenant.ok) return movedSurfaceNotFound('console')
  if (defaultLandingPathFor(tenant.value) === ACCOUNT_EXACT_PATH) {
    return c.redirect(ACCOUNT_EXACT_PATH, 302)
  }
  return delegateFrontendRequest(c, 'console')
}

async function serveCoreSpaAsset(c: Context<XidHonoEnv>): Promise<Response> {
  const url = new URL(c.req.url)
  if (url.pathname === '/docs' || url.pathname.startsWith('/docs/')) {
    return movedSurfaceNotFound('site')
  }
  if (isConsoleRoute(url.pathname)) return serveUnroutedConsole(c)

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
