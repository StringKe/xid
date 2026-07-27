import { PUBLIC_DOC_SLUGS } from '@xid-kit/types'
import type { IndexedEntry } from '@cloudflare/nimbus-docs'
import { describe, expect, it } from 'vitest'
import { DOCUMENT_LOCALE_ROUTE_SEGMENTS, type DocumentLocale } from '../content-source/docs/types'
import {
  PUBLIC_DOCS_INDEXED_TOTAL,
  PUBLIC_DOCS_LOCALES,
  type PublicDocsIndexedLocale,
} from './docs-registry'
import {
  renderPublicDocsGlobalLlmsFull,
  renderPublicDocsGlobalLlmsIndex,
  renderPublicDocsLlmsFull,
  renderPublicDocsLlmsIndex,
} from './docs-agent-content'

function indexedFixture(locale: DocumentLocale, slug: string | null): IndexedEntry {
  const segment = DOCUMENT_LOCALE_ROUTE_SEGMENTS[locale]
  const prefix = segment === '' ? '' : `/${segment}`
  const pathname = slug === null ? prefix || '/' : `${prefix}/${slug}`
  const label = slug ?? 'documentation hub'
  const browserUrl = pathname === '/' ? '/' : `${pathname}/`
  const twinRoot = pathname === '/' ? '' : pathname
  return {
    collection: 'docs',
    title: `${locale} ${label}`,
    description: `${locale} description for ${label}`,
    url: browserUrl,
    markdownUrl: `${twinRoot}/index.md`,
    sourceUrl: `${twinRoot}/index.mdx`,
    version: undefined,
    entry: {
      id: pathname === '/' ? 'index' : pathname.slice(1),
      collection: 'docs',
      data: { locale },
      body: `## ${locale} ${label}\n\nLocalized body for ${pathname}.`,
    },
  } as unknown as IndexedEntry
}

function completeGroups(): readonly PublicDocsIndexedLocale[] {
  return PUBLIC_DOCS_LOCALES.map((descriptor) => ({
    ...descriptor,
    hub: indexedFixture(descriptor.locale, null),
    documents: PUBLIC_DOC_SLUGS.map((slug) => ({
      slug,
      item: indexedFixture(descriptor.locale, slug),
    })),
  }))
}

function publishedItems(group: PublicDocsIndexedLocale): readonly IndexedEntry[] {
  return [group.hub, ...group.documents.map((document) => document.item)]
}

describe('public docs agent surfaces', () => {
  it('renders the root index with every published Markdown twin', () => {
    const groups = completeGroups()
    const index = renderPublicDocsGlobalLlmsIndex(groups)

    for (const group of groups) {
      for (const item of publishedItems(group)) {
        expect(index).toContain(`https://xid.dev${item.markdownUrl}`)
      }
    }
    expect(index.match(/\/index\.md\)/g)).toHaveLength(PUBLIC_DOCS_INDEXED_TOTAL)
    expect(index).toContain('https://xid.dev/en/llms.txt')
    expect(index).toContain('https://xid.dev/zh-hans/llms.txt')
    expect(index).not.toContain('https://xid.dev/docs/')
  })

  it('keeps top-level section indexes isolated by locale', () => {
    const groups = completeGroups()
    const english = groups[0]
    const chinese = groups[1]
    const englishIndex = renderPublicDocsLlmsIndex(english)
    const chineseIndex = renderPublicDocsLlmsIndex(chinese)

    expect(englishIndex.match(/\/index\.md\)/g)).toHaveLength(41)
    expect(chineseIndex.match(/\/index\.md\)/g)).toHaveLength(41)
    expect(englishIndex).not.toContain('https://xid.dev/zh-hans')
    expect(chineseIndex).not.toContain('https://xid.dev/getting-started')
    expect(englishIndex).toContain('https://xid.dev/en/llms-full.txt')
    expect(chineseIndex).toContain('https://xid.dev/zh-hans/llms-full.txt')
  })

  it('renders a deterministic timestamp-free 328-page root corpus', () => {
    const groups = completeGroups()
    const first = renderPublicDocsGlobalLlmsFull(groups)
    const second = renderPublicDocsGlobalLlmsFull([...groups].reverse())

    expect(second).toBe(first)
    expect(first.match(/<!-- xid-doc-path:/g)).toHaveLength(PUBLIC_DOCS_INDEXED_TOTAL)
    expect(first).not.toMatch(/^Generated(?: at| on):/im)
    expect(first).not.toMatch(/^Build timestamp:/im)
  })

  it('includes the locale hub and 40 details in a section corpus', () => {
    const [english] = completeGroups()
    const corpus = renderPublicDocsLlmsFull(english)

    expect(corpus.match(/<!-- xid-doc-path:/g)).toHaveLength(41)
    expect(corpus.match(/<!-- xid-doc-slug:/g)).toHaveLength(40)
    expect(corpus).not.toContain('https://xid.dev/zh-hans')
    expect(corpus).toContain('https://xid.dev/getting-started')
  })
})
