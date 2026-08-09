import { loadPublicDocsIndex } from '../lib/docs-index-runtime'
import {
  PUBLIC_DOCS_SITE_ORIGIN,
  flattenPublicDocsIndex,
  getPublicDocsCanonicalPath,
} from '../lib/docs-registry'
import { SITE_LOCALES } from '../lib/site-locale'
import { getHomeSurface } from '../lib/home-surface'
import { getStatusSurface } from '../lib/status-surface'

export const prerender = true

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

export async function GET() {
  const groups = await loadPublicDocsIndex()
  const paths = flattenPublicDocsIndex(groups).map((item) => {
    const canonicalPath = getPublicDocsCanonicalPath(item.url)
    if (!canonicalPath) throw new TypeError(`unknown public documentation route ${item.url}`)
    return canonicalPath
  })
  paths.push(...SITE_LOCALES.map((locale) => getHomeSurface(locale).path))
  paths.push(...SITE_LOCALES.map((locale) => getStatusSurface(locale).path))
  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...paths.map(
      (pathname) =>
        `  <url><loc>${escapeXml(new URL(pathname, PUBLIC_DOCS_SITE_ORIGIN).href)}</loc></url>`,
    ),
    '</urlset>',
    '',
  ].join('\n')

  return new Response(body, {
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
  })
}
