import { PUBLIC_DOC_ALIASES, PUBLIC_DOC_SLUGS, type PublicDocSlug } from '@xid-kit/types'
import type { IndexedEntry } from '@cloudflare/nimbus-docs'
import {
  DOCUMENT_LOCALES,
  DOCUMENT_LOCALE_ROUTE_SEGMENTS,
  type DocumentLocale,
} from '../content-source/docs/types'

export const PUBLIC_DOCS_SITE_ORIGIN = 'https://xid.dev'
export const PUBLIC_DOCS_PER_LOCALE = PUBLIC_DOC_SLUGS.length
export const PUBLIC_DOCS_TOTAL = DOCUMENT_LOCALES.length * PUBLIC_DOCS_PER_LOCALE
export const PUBLIC_DOCS_HUBS_TOTAL = DOCUMENT_LOCALES.length
export const PUBLIC_DOCS_INDEXED_TOTAL = PUBLIC_DOCS_TOTAL + PUBLIC_DOCS_HUBS_TOTAL

const PUBLIC_DOC_SLUG_SET = new Set<string>(PUBLIC_DOC_SLUGS)
const ROUTE_SEGMENT_TO_LOCALE = new Map<string, DocumentLocale>(
  DOCUMENT_LOCALES.filter((locale) => locale !== 'en').map((locale) => [
    DOCUMENT_LOCALE_ROUTE_SEGMENTS[locale],
    locale,
  ]),
)

export type PublicDocsLocaleDescriptor = {
  locale: DocumentLocale
  routeSegment: string
  siteRoot: string
  docsRoot: string
  documentRoot: string
  llmsIndexPath: string
  llmsFullPath: string
}

export const PUBLIC_DOCS_LOCALES = DOCUMENT_LOCALES.map((locale) => {
  const routeSegment = DOCUMENT_LOCALE_ROUTE_SEGMENTS[locale]
  const prefix = routeSegment === '' ? '' : `/${routeSegment}`
  return {
    locale,
    routeSegment,
    siteRoot: prefix === '' ? '/' : prefix,
    docsRoot: `${prefix}/docs`,
    documentRoot: prefix === '' ? '/' : prefix,
    llmsIndexPath: `${prefix}/llms.txt`,
    llmsFullPath: `${prefix}/llms-full.txt`,
  }
}) satisfies readonly PublicDocsLocaleDescriptor[]

const LOCALE_DESCRIPTOR_BY_LOCALE = new Map(
  PUBLIC_DOCS_LOCALES.map((descriptor) => [descriptor.locale, descriptor]),
)

export type PublicDocsRoute =
  | {
      kind: 'hub'
      locale: DocumentLocale
      routeSegment: string
      pathname: string
      slug: null
    }
  | {
      kind: 'document'
      locale: DocumentLocale
      routeSegment: string
      pathname: string
      slug: PublicDocSlug
    }

export type PublicDocsIndexedDocument = {
  slug: PublicDocSlug
  item: IndexedEntry
}

export type PublicDocsIndexedLocale = PublicDocsLocaleDescriptor & {
  hub: IndexedEntry
  documents: readonly PublicDocsIndexedDocument[]
}

export type PublicDocsIndexedSection = {
  locale: DocumentLocale
  routeSegment: string
  slug: string
  docsRoot: string
  llmsIndexPath: string
  llmsFullPath: string
  documents: readonly PublicDocsIndexedDocument[]
}

export function isPublicDocsAgentIndexable(item: IndexedEntry): boolean {
  const data = (item.entry.data ?? {}) as Record<string, unknown>
  return data.draft !== true && data.noindex !== true
}

function trimTrailingSlashes(pathname: string): string {
  let end = pathname.length
  while (end > 1 && pathname.charCodeAt(end - 1) === 47) end -= 1
  return pathname.slice(0, end)
}

export function getPublicDocsLocaleDescriptor(locale: DocumentLocale): PublicDocsLocaleDescriptor {
  const descriptor = LOCALE_DESCRIPTOR_BY_LOCALE.get(locale)
  if (!descriptor) throw new TypeError(`unsupported documentation locale ${locale}`)
  return descriptor
}

export function getPublicDocPath(locale: DocumentLocale, slug: PublicDocSlug): string {
  const { documentRoot } = getPublicDocsLocaleDescriptor(locale)
  return documentRoot === '/' ? `/${slug}` : `${documentRoot}/${slug}`
}

function publicDocTopLevelSlug(slug: PublicDocSlug): string {
  return slug.split('/')[0] ?? slug
}

export function getPublicDocsAgentIndexPath(
  locale: DocumentLocale,
  slug: PublicDocSlug | null = null,
): string {
  const descriptor = getPublicDocsLocaleDescriptor(locale)
  if (slug !== null) {
    const topLevelSlug = publicDocTopLevelSlug(slug)
    const memberCount = PUBLIC_DOC_SLUGS.filter(
      (candidate) => publicDocTopLevelSlug(candidate) === topLevelSlug,
    ).length
    if (memberCount > 1) {
      const prefix = descriptor.routeSegment === '' ? '' : `/${descriptor.routeSegment}`
      return `${prefix}/${topLevelSlug}/llms.txt`
    }
  }
  return locale === 'en' ? '/en/llms.txt' : descriptor.llmsIndexPath
}

export function getPublicDocsIndexedSections(
  group: PublicDocsIndexedLocale,
): readonly PublicDocsIndexedSection[] {
  const buckets = new Map<string, PublicDocsIndexedDocument[]>()
  for (const document of group.documents) {
    const topLevelSlug = publicDocTopLevelSlug(document.slug)
    const bucket = buckets.get(topLevelSlug)
    if (bucket) bucket.push(document)
    else buckets.set(topLevelSlug, [document])
  }

  const prefix = group.routeSegment === '' ? '' : `/${group.routeSegment}`
  return [...buckets.entries()]
    .filter(([, documents]) => documents.length > 1)
    .map(([slug, documents]) => ({
      locale: group.locale,
      routeSegment: group.routeSegment,
      slug,
      docsRoot: `${prefix}/${slug}`,
      llmsIndexPath: `${prefix}/${slug}/llms.txt`,
      llmsFullPath: `${prefix}/${slug}/llms-full.txt`,
      documents,
    }))
    .sort((left, right) => left.slug.localeCompare(right.slug))
}

export function parsePublicDocsRoute(pathname: string): PublicDocsRoute | null {
  const normalized = trimTrailingSlashes(pathname)
  const parts = normalized.split('/').filter(Boolean)
  let locale: DocumentLocale = 'en'
  let routeSegment = ''
  let slugParts = parts

  if (parts.length > 0) {
    const resolvedLocale = ROUTE_SEGMENT_TO_LOCALE.get(parts[0] ?? '')
    if (resolvedLocale) {
      locale = resolvedLocale
      routeSegment = parts[0] ?? ''
      slugParts = parts.slice(1)
    }
  }

  const slug = slugParts.join('/')
  const descriptor = getPublicDocsLocaleDescriptor(locale)
  if (slug === 'docs') {
    return {
      kind: 'hub',
      locale,
      routeSegment,
      pathname: descriptor.docsRoot,
      slug: null,
    }
  }
  if (slug === '') return null
  if (!PUBLIC_DOC_SLUG_SET.has(slug)) return null
  return {
    kind: 'document',
    locale,
    routeSegment,
    pathname: getPublicDocPath(locale, slug as PublicDocSlug),
    slug: slug as PublicDocSlug,
  }
}

export function getPublicDocsCanonicalPath(pathname: string): string | null {
  return parsePublicDocsRoute(pathname)?.pathname ?? null
}

export function resolvePublicDocsAliasPath(pathname: string): string | null {
  const normalized = trimTrailingSlashes(pathname)
  const parts = normalized.split('/').filter(Boolean)
  let locale: DocumentLocale = 'en'
  let routeSegment = ''
  let unlocalizedPath = normalized

  if (parts[0] !== 'docs') {
    const resolvedLocale = ROUTE_SEGMENT_TO_LOCALE.get(parts[0] ?? '')
    if (!resolvedLocale || parts[1] !== 'docs') return null
    locale = resolvedLocale
    routeSegment = parts[0] ?? ''
    unlocalizedPath = `/${parts.slice(1).join('/')}`
  }

  const twinMatch = /\/index\.(md|mdx)$/u.exec(unlocalizedPath)
  const twinSuffix = twinMatch?.[0] ?? ''
  const htmlPath =
    twinSuffix === '' ? unlocalizedPath : unlocalizedPath.slice(0, -twinSuffix.length)
  let canonicalPath: string
  if (htmlPath === '/docs') {
    canonicalPath = getPublicDocsLocaleDescriptor(locale).docsRoot
  } else {
    const legacySlug = htmlPath.slice('/docs/'.length)
    const targetSlug = PUBLIC_DOC_SLUG_SET.has(legacySlug)
      ? (legacySlug as PublicDocSlug)
      : PUBLIC_DOC_ALIASES[htmlPath as keyof typeof PUBLIC_DOC_ALIASES]
    if (!targetSlug) return null
    canonicalPath = getPublicDocPath(locale, targetSlug)
  }
  if (twinSuffix !== '') {
    const twinRoot = canonicalPath.endsWith('/') ? canonicalPath.slice(0, -1) : canonicalPath
    canonicalPath = `${twinRoot}${twinSuffix}`
  }
  const localizedSource =
    routeSegment === '' ? unlocalizedPath : `/${routeSegment}${unlocalizedPath}`
  return canonicalPath === localizedSource ? null : canonicalPath
}

function assertIndexedRoute(item: IndexedEntry): PublicDocsRoute {
  if (item.collection !== 'docs') {
    throw new TypeError(`agent index exposed non-docs collection ${item.collection}`)
  }
  if (!isPublicDocsAgentIndexable(item)) {
    throw new TypeError(`agent index exposed draft or noindex page ${item.url}`)
  }
  const route = parsePublicDocsRoute(item.url)
  if (!route) {
    throw new TypeError(`agent index exposed unknown documentation URL ${item.url}`)
  }
  const browserRoot = route.pathname.endsWith('/') ? route.pathname.slice(0, -1) : route.pathname
  const expectedUrl = `${browserRoot}/`
  const expectedMarkdownUrl = `${browserRoot}/index.md`
  const expectedSourceUrl = `${browserRoot}/index.mdx`
  const data = (item.entry.data ?? {}) as Record<string, unknown>
  if (item.url !== expectedUrl) {
    throw new TypeError(`documentation URL is not canonical: ${item.url}`)
  }
  if (item.markdownUrl !== expectedMarkdownUrl) {
    throw new TypeError(`documentation Markdown twin is not canonical: ${item.markdownUrl}`)
  }
  if (item.sourceUrl !== expectedSourceUrl) {
    throw new TypeError(`documentation MDX twin is missing: ${item.url}`)
  }
  if (data.locale !== route.locale) {
    throw new TypeError(`documentation locale mismatch for ${item.url}: ${String(data.locale)}`)
  }
  return route
}

export function validatePublicDocsIndex(
  indexed: readonly IndexedEntry[],
  expectedDocumentSlugs: readonly PublicDocSlug[] = PUBLIC_DOC_SLUGS,
): readonly PublicDocsIndexedLocale[] {
  const expectedSlugSet = new Set<PublicDocSlug>(expectedDocumentSlugs)
  if (expectedSlugSet.size !== expectedDocumentSlugs.length) {
    throw new TypeError('public docs expected publication list contains duplicate slugs')
  }
  for (const slug of expectedDocumentSlugs) {
    if (!PUBLIC_DOC_SLUG_SET.has(slug)) {
      throw new TypeError(`public docs expected publication list contains unknown slug ${slug}`)
    }
  }
  const expectedIndexedTotal = DOCUMENT_LOCALES.length * (expectedSlugSet.size + 1)
  if (indexed.length !== expectedIndexedTotal) {
    throw new TypeError(
      `public docs index must contain ${expectedIndexedTotal} entries, received ${indexed.length}`,
    )
  }

  const groups = new Map<
    DocumentLocale,
    { hub: IndexedEntry | null; documents: Map<PublicDocSlug, IndexedEntry> }
  >(
    DOCUMENT_LOCALES.map((locale) => [
      locale,
      { hub: null, documents: new Map<PublicDocSlug, IndexedEntry>() },
    ]),
  )

  for (const item of indexed) {
    const route = assertIndexedRoute(item)
    const group = groups.get(route.locale)
    if (!group) throw new TypeError(`missing documentation group ${route.locale}`)
    if (route.kind === 'hub') {
      if (group.hub) throw new TypeError(`duplicate documentation hub ${route.locale}`)
      group.hub = item
      continue
    }
    if (!expectedSlugSet.has(route.slug)) {
      throw new TypeError(`agent index exposed unpublished documentation page ${item.url}`)
    }
    if (group.documents.has(route.slug)) {
      throw new TypeError(`duplicate documentation page ${route.locale}/${route.slug}`)
    }
    group.documents.set(route.slug, item)
  }

  return PUBLIC_DOCS_LOCALES.map((descriptor) => {
    const group = groups.get(descriptor.locale)
    if (!group?.hub) {
      throw new TypeError(`documentation locale ${descriptor.locale} has no hub`)
    }
    const documents = expectedDocumentSlugs.map((slug) => {
      const item = group.documents.get(slug)
      if (!item) {
        throw new TypeError(`documentation locale ${descriptor.locale} is missing ${slug}`)
      }
      return { slug, item }
    })
    if (group.documents.size !== expectedSlugSet.size) {
      throw new TypeError(
        `documentation locale ${descriptor.locale} must contain ${expectedSlugSet.size} pages`,
      )
    }
    return { ...descriptor, hub: group.hub, documents }
  })
}

export function flattenPublicDocsIndex(
  groups: readonly PublicDocsIndexedLocale[],
): readonly IndexedEntry[] {
  return groups.flatMap((group) => [group.hub, ...group.documents.map((document) => document.item)])
}
