// 从 public-docs 注册表生成 sitemap.xml,避免与 robots/llms 漂移。

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

function readPublicDocSlugs() {
  const source = readFileSync(join(ROOT, 'public-docs.ts'), 'utf8')
  const match = source.match(/export const PUBLIC_DOC_SLUGS = \[([\s\S]*?)\] as const/u)
  if (!match) throw new Error('PUBLIC_DOC_SLUGS not found in public-docs.ts')
  return [...match[1].matchAll(/'([^']+)'/gu)].map((entry) => entry[1])
}

const PUBLIC_DOC_SLUGS = readPublicDocSlugs()
const OUTPUT = join(ROOT, 'public/sitemap.xml')
const ORIGIN = 'https://xid.dev'

// 公开别名(与 sitemap 历史一致;canonical 仍由页面 SEO 层决定)。
const SITEMAP_ALIASES = [
  '/docs/oidc',
  '/docs/oauth',
  '/docs/sso',
  '/docs/enterprise',
  '/docs/social',
  '/docs/sdks/web',
]

function priorityForPath(path) {
  if (path === '/') return '1.0'
  if (path === '/docs') return '0.9'
  if (path === '/docs/sdks') return '0.8'
  if (path.startsWith('/docs/sdks/')) return '0.7'
  return '0.8'
}

function urlEntry(path) {
  const loc = `${ORIGIN}${path}`
  return `  <url>
    <loc>${loc}</loc>
    <changefreq>weekly</changefreq>
    <priority>${priorityForPath(path)}</priority>
  </url>`
}

const paths = new Set(['/', '/docs'])
for (const slug of PUBLIC_DOC_SLUGS) paths.add(`/docs/${slug}`)
for (const alias of SITEMAP_ALIASES) paths.add(alias)

const sorted = [...paths].sort((a, b) => a.localeCompare(b))
const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sorted.map(urlEntry).join('\n')}
</urlset>
`

writeFileSync(OUTPUT, xml)
process.stdout.write(`wrote ${OUTPUT} (${sorted.length} urls)\n`)
