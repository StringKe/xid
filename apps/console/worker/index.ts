export type ConsoleEnv = {
  ASSETS: {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>
  }
}

const CANONICAL_HOST = 'xid.dev'
const LOCAL_DEV_HOSTS = new Set(['127.0.0.1', 'localhost'])
const CONSOLE_ROOT = '/console'
const CONSOLE_SHELL = '/console/'

const CONSOLE_SECURITY_HEADERS = {
  'Content-Security-Policy': "frame-ancestors 'self'",
  'Permissions-Policy': 'tools=(self)',
  'Origin-Agent-Cluster': '?1',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
} as const
const ROUTE_OWNER_HEADER = 'X-XID-Route-Owner'

function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers)
  for (const [name, value] of Object.entries(CONSOLE_SECURITY_HEADERS)) {
    if (!headers.has(name)) headers.set(name, value)
  }
  headers.set(ROUTE_OWNER_HEADER, 'console')
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function redirect(url: URL, status: 302 | 308): Response {
  return withSecurityHeaders(Response.redirect(url.toString(), status))
}

function redirectToCanonicalHost(url: URL): Response {
  url.protocol = 'https:'
  url.hostname = CANONICAL_HOST
  url.port = ''
  return redirect(url, 308)
}

function resolveRequestHostname(request: Request, url: URL): string {
  if (!LOCAL_DEV_HOSTS.has(url.hostname)) return url.hostname
  const forwardedHost = request.headers
    .get('X-Forwarded-Host')
    ?.split(',', 1)[0]
    ?.trim()
    .toLowerCase()
    .replace(/:\d+$/u, '')
  if (
    forwardedHost === CANONICAL_HOST ||
    forwardedHost === `www.${CANONICAL_HOST}` ||
    forwardedHost?.endsWith(`.${CANONICAL_HOST}`)
  ) {
    return forwardedHost
  }
  return url.hostname
}

function redirectAccountAlias(url: URL): Response | null {
  const pathname = url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname
  if (pathname === '/console/sessions') {
    url.pathname = '/account/sessions'
    return redirect(url, 302)
  }
  if (pathname === '/console/security') {
    url.pathname = '/account/security'
    return redirect(url, 302)
  }
  return null
}

function isConsolePath(pathname: string): boolean {
  return pathname === CONSOLE_ROOT || pathname.startsWith(`${CONSOLE_ROOT}/`)
}

function isStaticAssetPath(pathname: string): boolean {
  if (pathname.startsWith('/console/assets/')) return true
  const filename = pathname.slice(pathname.lastIndexOf('/') + 1)
  return filename.includes('.')
}

function isDocumentNavigation(request: Request): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false
  const destination = request.headers.get('Sec-Fetch-Dest')
  if (destination !== null) return destination === 'document'
  const mode = request.headers.get('Sec-Fetch-Mode')
  if (mode !== null) return mode === 'navigate'
  return request.headers.get('Accept')?.includes('text/html') ?? false
}

function indexRequest(request: Request): Request {
  const url = new URL(request.url)
  url.pathname = CONSOLE_SHELL
  url.search = ''
  return new Request(url, request)
}

export default {
  async fetch(request: Request, env: ConsoleEnv): Promise<Response> {
    const url = new URL(request.url)

    if (resolveRequestHostname(request, url) === `www.${CANONICAL_HOST}`) {
      return redirectToCanonicalHost(url)
    }

    const accountRedirect = redirectAccountAlias(url)
    if (accountRedirect) return accountRedirect

    if (!isConsolePath(url.pathname)) {
      return withSecurityHeaders(new Response(null, { status: 404 }))
    }

    const assetResponse = await env.ASSETS.fetch(request)
    if (
      assetResponse.status !== 404 ||
      isStaticAssetPath(url.pathname) ||
      !isDocumentNavigation(request)
    ) {
      return withSecurityHeaders(assetResponse)
    }

    return withSecurityHeaders(await env.ASSETS.fetch(indexRequest(request)))
  },
} satisfies ExportedHandler<ConsoleEnv>
