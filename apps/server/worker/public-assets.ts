import type { Context, Hono } from 'hono'
import { buildPublicDocCatalog, type PublicDocCatalogEntry } from '../src/lib/public-docs-catalog'
import {
  getPublicDocsRouteDecision,
  isDocsPath,
  isPublicDocsPath,
  resolvePublicDocSlug,
} from '../public-docs'
import type { XidHonoEnv } from './lib/types'
import { applySpaSecurityHeaders } from './security-headers'

const PUBLIC_DOC_CATALOG = buildPublicDocCatalog()

const DOCS_EXTRA_SEO_FALLBACK_SECTIONS: Record<string, readonly string[]> = {
  'enterprise-sso': [
    'Upstream enterprise IdP status',
    'Downstream SaaS SSO status',
    'Legacy protocol boundaries',
    'Microsoft Entra ID',
    'Okta',
    'Google Workspace',
    'SAML Single Logout is not supported.',
    'Provider-ready rows require real external L4 evidence before public support claims.',
    'Linked sign-on, native IWA, and Kerberos termination are not supported.',
  ],
}

function publicDocsNotFound(pathname: string): Response {
  return new Response('This path is not part of the published XID developer docs.', {
    status: 404,
    headers: {
      'content-type': 'text/plain;charset=UTF-8',
      'x-xid-docs-route-status': getPublicDocsRouteDecision(pathname).status,
    },
  })
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function findPublicDocCatalogEntry(slug: string): PublicDocCatalogEntry | null {
  return PUBLIC_DOC_CATALOG.find((entry) => entry.slug === slug) ?? null
}

function fallbackSectionsForDoc(entry: PublicDocCatalogEntry): readonly string[] {
  return [
    'XID public technical documentation',
    entry.category,
    entry.url,
    ...(entry.description ? [entry.description] : []),
    ...(DOCS_EXTRA_SEO_FALLBACK_SECTIONS[entry.slug] ?? []),
  ]
}

export function renderDocsSeoFallback(pathname: string): string | null {
  const slug = resolvePublicDocSlug(pathname)
  if (!slug) return null
  const entry = findPublicDocCatalogEntry(slug)
  if (!entry) return null
  const sections = fallbackSectionsForDoc(entry)
  return [
    '<main data-seo-fallback>',
    `<h1>${escapeHtml(entry.title.replace(/\s+\|\s+XID Docs$/u, ''))}</h1>`,
    entry.description ? `<p>${escapeHtml(entry.description)}</p>` : '',
    '<ul>',
    ...sections.map((section) => `<li>${escapeHtml(section)}</li>`),
    '</ul>',
    '</main>',
  ].join('')
}

async function injectDocsSeoFallback(response: Response, pathname: string): Promise<Response> {
  const fallback = renderDocsSeoFallback(pathname)
  const contentType = response.headers.get('content-type') ?? ''
  if (!fallback || !contentType.includes('text/html')) return response

  // ASSETS returns the finite SPA HTML shell here; other asset types stay streamed.
  const html = await response.text()
  const body = html.replace(/<main data-seo-fallback>[\s\S]*?<\/main>/u, fallback)
  const headers = new Headers(response.headers)
  headers.delete('content-encoding')
  headers.delete('content-length')
  headers.delete('etag')
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

async function serveSpaAsset(c: Context<XidHonoEnv>): Promise<Response> {
  const response = await c.env.ASSETS.fetch(c.req.raw)
  return applySpaSecurityHeaders(response)
}

async function serveDocsAsset(c: Context<XidHonoEnv>): Promise<Response> {
  const pathname = new URL(c.req.url).pathname
  if (isDocsPath(pathname) && !isPublicDocsPath(pathname)) return publicDocsNotFound(pathname)
  const response = await serveSpaAsset(c)
  return injectDocsSeoFallback(response, pathname)
}

export function registerPublicAssetRoutes(app: Hono<XidHonoEnv>): void {
  app.all('/docs', serveDocsAsset)
  app.all('/docs/*', serveDocsAsset)
  app.all('*', serveSpaAsset)
}
