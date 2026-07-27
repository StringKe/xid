import {
  SITE_LOCALE_ROUTE_SEGMENTS,
  isLocalizableSitePath,
  localizeSitePath,
  resolveSiteLocale,
  type SiteLocale,
} from '../src/lib/site-locale'
import { resolvePublicDocsAliasPath } from '../src/lib/docs-registry'

type SiteEnv = {
  ASSETS: Fetcher
}

const CANONICAL_HOST = 'xid.dev'
const LOCAL_DEV_HOSTS = new Set(['127.0.0.1', 'localhost'])
const LEGACY_AGENT_INDEX_PATTERN =
  /^\/(?:(zh-hans|ja|ko|fr|de|es|pt-br)\/)?docs\/(llms(?:-full)?\.txt)\/?$/u

const SITE_SECURITY_HEADERS = {
  'Content-Security-Policy': "frame-ancestors 'self'",
  'Permissions-Policy': 'tools=(self)',
  'Origin-Agent-Cluster': '?1',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'X-XID-Route-Owner': 'site',
} as const

function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers)
  for (const [name, value] of Object.entries(SITE_SECURITY_HEADERS)) {
    if (!headers.has(name)) headers.set(name, value)
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
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

function agentIndexRouteSegment(locale: SiteLocale): string {
  return locale === 'en' ? 'en' : SITE_LOCALE_ROUTE_SEGMENTS[locale]
}

function resolveLegacyAgentIndexPath(
  pathname: string,
  requestedLocale: SiteLocale | null,
): string | null {
  const match = LEGACY_AGENT_INDEX_PATTERN.exec(pathname)
  if (!match) return null

  const sourceLocale = resolveSiteLocale(match[1] ?? '') ?? 'en'
  const targetLocale = requestedLocale ?? sourceLocale
  return `/${agentIndexRouteSegment(targetLocale)}/${match[2]}`
}

function resolveCanonicalRedirect(request: Request, source: URL): URL | null {
  const target = new URL(source)
  let changed = false

  if (resolveRequestHostname(request, source) === `www.${CANONICAL_HOST}`) {
    target.protocol = 'https:'
    target.hostname = CANONICAL_HOST
    target.port = ''
    changed = true
  }

  const requestedLocale = resolveSiteLocale(target.searchParams.get('locale') ?? '')
  const agentIndexPath = resolveLegacyAgentIndexPath(target.pathname, requestedLocale)
  if (agentIndexPath) {
    target.pathname = agentIndexPath
    if (requestedLocale) target.searchParams.delete('locale')
    return target
  }

  const docsTarget = resolvePublicDocsAliasPath(target.pathname)
  if (docsTarget) {
    target.pathname = docsTarget
    changed = true
  }

  if (requestedLocale && (docsTarget !== null || isLocalizableSitePath(target.pathname))) {
    const localizedPath = localizeSitePath(target.pathname, requestedLocale)
    if (target.pathname !== localizedPath) target.pathname = localizedPath
    target.searchParams.delete('locale')
    changed = true
  }

  if (
    target.pathname.length > 1 &&
    target.pathname.endsWith('/') &&
    isLocalizableSitePath(target.pathname)
  ) {
    target.pathname = target.pathname.replace(/\/+$/u, '')
    changed = true
  }

  return changed ? target : null
}

export default {
  async fetch(request: Request, env: SiteEnv, _context: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    const redirect = resolveCanonicalRedirect(request, url)
    if (redirect) {
      return withSecurityHeaders(Response.redirect(redirect.toString(), 308))
    }
    return withSecurityHeaders(await env.ASSETS.fetch(request))
  },
} satisfies ExportedHandler<SiteEnv>
