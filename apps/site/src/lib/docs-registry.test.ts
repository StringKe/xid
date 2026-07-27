import { PUBLIC_DOC_SLUGS } from '@xid-kit/types'
import type { IndexedEntry } from '@cloudflare/nimbus-docs'
import { describe, expect, it } from 'vitest'
import {
  DOCUMENT_LOCALES,
  DOCUMENT_LOCALE_ROUTE_SEGMENTS,
  type DocumentLocale,
} from '../content-source/docs/types'
import {
  PUBLIC_DOCS_INDEXED_TOTAL,
  PUBLIC_DOCS_LOCALES,
  flattenPublicDocsIndex,
  getPublicDocPath,
  isPublicDocsAgentIndexable,
  parsePublicDocsRoute,
  resolvePublicDocsAliasPath,
  validatePublicDocsIndex,
} from './docs-registry'

function indexedFixture(locale: DocumentLocale, slug: string | null): IndexedEntry {
  const segment = DOCUMENT_LOCALE_ROUTE_SEGMENTS[locale]
  const prefix = segment === '' ? '' : `/${segment}`
  const pathname = slug === null ? prefix || '/' : `${prefix}/${slug}`
  const browserUrl = pathname === '/' ? '/' : `${pathname}/`
  const twinRoot = pathname === '/' ? '' : pathname
  return {
    collection: 'docs',
    title: slug ?? 'Developer docs',
    description: `Description for ${slug ?? 'hub'}`,
    url: browserUrl,
    markdownUrl: `${twinRoot}/index.md`,
    sourceUrl: `${twinRoot}/index.mdx`,
    version: undefined,
    entry: {
      id:
        slug === null
          ? segment === ''
            ? 'index'
            : `${segment}/index`
          : `${segment === '' ? '' : `${segment}/`}${slug}`,
      collection: 'docs',
      data: { locale },
      body: `## ${slug ?? 'Developer docs'}`,
    },
  } as unknown as IndexedEntry
}

function completeIndex(): IndexedEntry[] {
  return DOCUMENT_LOCALES.flatMap((locale) => [
    indexedFixture(locale, null),
    ...PUBLIC_DOC_SLUGS.map((slug) => indexedFixture(locale, slug)),
  ])
}

describe('public docs route registry', () => {
  it('uses BCP locale IDs with lowercase URL segments', () => {
    expect(PUBLIC_DOCS_LOCALES.map((entry) => entry.locale)).toEqual(DOCUMENT_LOCALES)
    expect(PUBLIC_DOCS_LOCALES.map((entry) => entry.routeSegment)).toEqual([
      '',
      'zh-hans',
      'ja',
      'ko',
      'fr',
      'de',
      'es',
      'pt-br',
    ])
    expect(getPublicDocPath('zh-Hans', 'oidc-oauth')).toBe('/zh-hans/oidc-oauth')
    expect(getPublicDocPath('pt-BR', 'sdks/react')).toBe('/pt-br/sdks/react')
  })

  it('parses only the hub and 40 public detail routes', () => {
    expect(parsePublicDocsRoute('/')).toMatchObject({
      kind: 'hub',
      locale: 'en',
    })
    expect(parsePublicDocsRoute('/zh-hans/')).toMatchObject({
      kind: 'hub',
      locale: 'zh-Hans',
    })
    expect(parsePublicDocsRoute('/zh-hans/sdks/react/')).toMatchObject({
      kind: 'document',
      locale: 'zh-Hans',
      slug: 'sdks/react',
    })
    expect(parsePublicDocsRoute('/design')).toBeNull()
    expect(parsePublicDocsRoute('/pt-BR/oidc-oauth')).toBeNull()
    expect(parsePublicDocsRoute('/console')).toBeNull()
  })

  it.each([
    ['/docs', '/'],
    ['/ja/docs', '/ja'],
    ['/docs/getting-started', '/getting-started'],
    ['/docs/oidc', '/oidc-oauth'],
    ['/docs/oauth/', '/oidc-oauth'],
    ['/ja/docs/sso', '/ja/enterprise-sso'],
    ['/zh-hans/docs/social', '/zh-hans/social-login'],
    ['/pt-br/docs/sdks/web', '/pt-br/sdks/core'],
    ['/docs/index.md', '/index.md'],
    ['/docs/getting-started/index.mdx', '/getting-started/index.mdx'],
    ['/fr/docs/index.mdx', '/fr/index.mdx'],
  ])('resolves alias %s to %s', (source, target) => {
    expect(resolvePublicDocsAliasPath(source)).toBe(target)
  })

  it.each(['/', '/sdks/core', '/fr/getting-started', '/docs/design', '/docs/design/index.md'])(
    'does not redirect canonical or unknown path %s',
    (source) => {
      expect(resolvePublicDocsAliasPath(source)).toBeNull()
    },
  )

  it('validates one hub plus the same 40 detail docs for every locale', () => {
    const groups = validatePublicDocsIndex(completeIndex())
    expect(groups).toHaveLength(8)
    expect(flattenPublicDocsIndex(groups)).toHaveLength(PUBLIC_DOCS_INDEXED_TOTAL)
    for (const group of groups) {
      expect(group.documents.map((entry) => entry.slug)).toEqual(PUBLIC_DOC_SLUGS)
      expect(group.documents).toHaveLength(40)
    }
  })

  it('fails closed on unknown or locale-mismatched index entries', () => {
    const unknown = completeIndex()
    unknown[1] = indexedFixture('en', 'design')
    expect(() => validatePublicDocsIndex(unknown)).toThrow('unknown documentation URL')

    const wrongLocale = completeIndex()
    wrongLocale[0] = {
      ...wrongLocale[0],
      entry: {
        ...wrongLocale[0].entry,
        data: { locale: 'fr' },
      },
    } as IndexedEntry
    expect(() => validatePublicDocsIndex(wrongLocale)).toThrow('documentation locale mismatch')
  })

  it.each(['draft', 'noindex'] as const)('excludes %s entries from agent indexes', (field) => {
    const hidden = indexedFixture('en', 'getting-started')
    hidden.entry.data = { ...hidden.entry.data, [field]: true }
    expect(isPublicDocsAgentIndexable(hidden)).toBe(false)
    expect(() => validatePublicDocsIndex([hidden])).toThrow('public docs index must contain')
  })
})
