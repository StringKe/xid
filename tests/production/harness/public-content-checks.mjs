import { PUBLIC_DOC_SLUGS } from '../../../packages/types/src/public-docs.ts'

export const PUBLIC_DOC_SECTIONS = [
  { section: 'en', locale: 'en', routeSegment: '' },
  { section: 'zh-hans', locale: 'zh-Hans', routeSegment: 'zh-hans' },
  { section: 'ja', locale: 'ja', routeSegment: 'ja' },
  { section: 'ko', locale: 'ko', routeSegment: 'ko' },
  { section: 'fr', locale: 'fr', routeSegment: 'fr' },
  { section: 'de', locale: 'de', routeSegment: 'de' },
  { section: 'es', locale: 'es', routeSegment: 'es' },
  { section: 'pt-br', locale: 'pt-BR', routeSegment: 'pt-br' },
]

export const PUBLIC_DOCS_PER_SECTION = 41
export const PUBLIC_DOCS_TOTAL = 328

function registrySizeOk() {
  return (
    PUBLIC_DOC_SLUGS.length + 1 === PUBLIC_DOCS_PER_SECTION &&
    PUBLIC_DOC_SECTIONS.length * PUBLIC_DOCS_PER_SECTION === PUBLIC_DOCS_TOTAL
  )
}

function normalizedContentLines(body) {
  return body
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
}

function markdownLinkTargets(lines) {
  const targets = new Set()
  for (const line of lines) {
    const targetStart = line.indexOf('](')
    if (targetStart === -1) continue
    const targetEnd = line.indexOf(')', targetStart + 2)
    if (targetEnd === -1) continue
    targets.add(line.slice(targetStart + 2, targetEnd))
  }
  return targets
}

function hasOriginPath(targets, pathname) {
  for (const target of targets) {
    let url
    try {
      url = new URL(target)
    } catch {
      continue
    }
    if (url.origin !== 'https://xid.dev') continue
    if (url.pathname === pathname || url.pathname.startsWith(`${pathname}/`)) return true
  }
  return false
}

function sectionDescriptor(section) {
  const descriptor = PUBLIC_DOC_SECTIONS.find((candidate) => candidate.section === section)
  if (!descriptor) throw new TypeError(`unknown public documentation section ${section}`)
  return descriptor
}

function publicDocPath(routeSegment, slug = null) {
  const prefix = routeSegment === '' ? '' : `/${routeSegment}`
  if (slug === null) return prefix === '' ? '/' : prefix
  return `${prefix}/${slug}`
}

function publicDocMarkdownUrl(routeSegment, slug = null) {
  const pathname = publicDocPath(routeSegment, slug)
  return new URL(
    pathname === '/' ? '/index.md' : `${pathname.replace(/\/$/u, '')}/index.md`,
    'https://xid.dev',
  ).href
}

function publicDocIndexedPath(routeSegment, slug = null) {
  return publicDocPath(routeSegment, slug)
}

function expectedSectionPaths(routeSegment) {
  return new Set([
    publicDocIndexedPath(routeSegment),
    ...PUBLIC_DOC_SLUGS.map((slug) => publicDocIndexedPath(routeSegment, slug)),
  ])
}

function expectedSectionMarkdownUrls(routeSegment) {
  return new Set([
    publicDocMarkdownUrl(routeSegment),
    ...PUBLIC_DOC_SLUGS.map((slug) => publicDocMarkdownUrl(routeSegment, slug)),
  ])
}

function expectedGlobalPaths() {
  return new Set(
    PUBLIC_DOC_SECTIONS.flatMap(({ routeSegment }) => [...expectedSectionPaths(routeSegment)]),
  )
}

function expectedGlobalMarkdownUrls() {
  return new Set(
    PUBLIC_DOC_SECTIONS.flatMap(({ routeSegment }) => [
      ...expectedSectionMarkdownUrls(routeSegment),
    ]),
  )
}

function setEquals(actual, expected) {
  if (actual.size !== expected.size) return false
  return [...expected].every((value) => actual.has(value))
}

function publishedMarkdownTargets(targets) {
  const published = new Set()
  for (const target of targets) {
    let url
    try {
      url = new URL(target)
    } catch {
      continue
    }
    if (url.origin === 'https://xid.dev' && url.pathname.endsWith('/index.md')) {
      published.add(url.href)
    }
  }
  return published
}

function corpusPaths(body) {
  return new Set([...body.matchAll(/<!-- xid-doc-path: ([^ ]+) -->/gu)].map((match) => match[1]))
}

function sitemapLocations(body) {
  return [...body.matchAll(/<loc>([^<]+)<\/loc>/gu)].map((match) => match[1])
}

export function llmsOk(body) {
  const lines = normalizedContentLines(body)
  const lineSet = new Set(lines)
  const targets = markdownLinkTargets(lines)
  const publishedTargets = publishedMarkdownTargets(targets)
  return (
    registrySizeOk() &&
    lineSet.has('# XID') &&
    targets.has('https://xid.dev/llms-full.txt') &&
    targets.has('https://xid.dev/sitemap.xml') &&
    targets.has('https://xid.dev/robots.txt') &&
    PUBLIC_DOC_SECTIONS.every(({ section }) =>
      targets.has(`https://xid.dev/${section}/llms.txt`),
    ) &&
    setEquals(publishedTargets, expectedGlobalMarkdownUrls()) &&
    !hasOriginPath(targets, '/docs') &&
    !hasOriginPath(targets, '/console')
  )
}

export function llmsFullOk(body) {
  const lines = normalizedContentLines(body)
  const lineSet = new Set(lines)
  const paths = corpusPaths(body)
  return (
    registrySizeOk() &&
    lineSet.has('# XID: full public documentation corpus') &&
    lineSet.has('Index: https://xid.dev/llms.txt') &&
    lineSet.has(`Published pages: ${PUBLIC_DOCS_TOTAL}`) &&
    setEquals(paths, expectedGlobalPaths()) &&
    body.includes('Canonical: https://xid.dev/scim') &&
    body.includes('Markdown: https://xid.dev/scim/index.md') &&
    [...paths].every((pathname) => pathname !== '/docs' && !pathname.startsWith('/docs/'))
  )
}

export function llmsSectionOk(body, section) {
  const descriptor = sectionDescriptor(section)
  const lines = normalizedContentLines(body)
  const lineSet = new Set(lines)
  const targets = markdownLinkTargets(lines)
  const publishedTargets = publishedMarkdownTargets(targets)
  const expectedHeading =
    descriptor.locale === 'en' ? '# XID' : `# XID documentation (${descriptor.locale})`
  return (
    registrySizeOk() &&
    lineSet.has(expectedHeading) &&
    targets.has(`https://xid.dev/${section}/llms-full.txt`) &&
    targets.has('https://xid.dev/sitemap.xml') &&
    targets.has('https://xid.dev/robots.txt') &&
    setEquals(publishedTargets, expectedSectionMarkdownUrls(descriptor.routeSegment)) &&
    !hasOriginPath(targets, '/docs')
  )
}

export function llmsSectionFullOk(body, section) {
  const descriptor = sectionDescriptor(section)
  const lines = normalizedContentLines(body)
  const lineSet = new Set(lines)
  const paths = corpusPaths(body)
  return (
    registrySizeOk() &&
    lineSet.has(`# XID: full public documentation corpus (${descriptor.locale})`) &&
    lineSet.has(`- Concise index: https://xid.dev/${section}/llms.txt`) &&
    lineSet.has(`- Published pages: ${PUBLIC_DOCS_PER_SECTION}`) &&
    setEquals(paths, expectedSectionPaths(descriptor.routeSegment)) &&
    [...paths].every((pathname) => pathname !== '/docs' && !pathname.startsWith('/docs/'))
  )
}

export function sitemapOk(body) {
  const locations = sitemapLocations(body)
  const expected = new Set(
    [...expectedGlobalPaths()].map((pathname) => new URL(pathname, 'https://xid.dev').href),
  )
  return (
    registrySizeOk() &&
    body.includes('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">') &&
    locations.length === PUBLIC_DOCS_TOTAL &&
    setEquals(new Set(locations), expected) &&
    locations.every((location) => {
      const pathname = new URL(location).pathname
      return pathname !== '/docs' && !pathname.startsWith('/docs/')
    })
  )
}
