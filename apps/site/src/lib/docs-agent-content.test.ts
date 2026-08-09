import { PUBLIC_DOC_SLUGS } from '@xid-kit/types'
import type { IndexedEntry } from '@cloudflare/nimbus-docs'
import { describe, expect, it, vi } from 'vitest'
import { DOCUMENT_LOCALE_ROUTE_SEGMENTS, type DocumentLocale } from '../content-source/docs/types'
import {
  PUBLIC_DOCS_INDEXED_TOTAL,
  PUBLIC_DOCS_LOCALES,
  getPublicDocsIndexedSections,
  type PublicDocsIndexedLocale,
} from './docs-registry'
import {
  renderPublicDocsGlobalLlmsFull,
  renderPublicDocsGlobalLlmsIndex,
  renderPublicDocsLlmsFull,
  renderPublicDocsLlmsIndex,
  renderPublicDocsSectionLlmsFull,
  renderPublicDocsSectionLlmsIndex,
} from './docs-agent-content'

vi.mock('@lingui/core/macro', () => ({
  msg: (strings: TemplateStringsArray) => ({ message: strings[0] }),
}))

function indexedFixture(locale: DocumentLocale, slug: string | null): IndexedEntry {
  const segment = DOCUMENT_LOCALE_ROUTE_SEGMENTS[locale]
  const prefix = segment === '' ? '' : `/${segment}`
  const pathname = slug === null ? `${prefix}/docs` : `${prefix}/${slug}`
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
    expect(index.match(/\/index\.md\)/g)).toHaveLength(PUBLIC_DOCS_INDEXED_TOTAL + 16)
    expect(index).toContain('https://xid.dev/status/index.md')
    expect(index).toContain('https://xid.dev/zh-hans/status/index.md')
    expect(index).toContain('https://xid.dev/en/llms.txt')
    expect(index).toContain('https://xid.dev/zh-hans/llms.txt')
    expect(index).toContain('https://xid.dev/sdks/llms.txt')
    expect(index).toContain('https://xid.dev/zh-hans/sdks/llms.txt')
    expect(index).toContain('https://xid.dev/docs/index.md')
    expect(index).not.toContain('https://xid.dev/docs/getting-started/index.md')
  })

  it('keeps top-level section indexes isolated by locale', () => {
    const groups = completeGroups()
    const english = groups[0]
    const chinese = groups[1]
    const englishIndex = renderPublicDocsLlmsIndex(english)
    const chineseIndex = renderPublicDocsLlmsIndex(chinese)

    expect(englishIndex.match(/\/index\.md\)/g)).toHaveLength(44)
    expect(chineseIndex.match(/\/index\.md\)/g)).toHaveLength(44)
    expect(englishIndex).toContain('https://xid.dev/status/index.md')
    expect(chineseIndex).toContain('https://xid.dev/zh-hans/status/index.md')
    expect(chineseIndex).not.toContain('https://xid.dev/status/index.md')
    expect(englishIndex).not.toContain('https://xid.dev/zh-hans')
    expect(chineseIndex).not.toContain('https://xid.dev/getting-started')
    expect(englishIndex).toContain('https://xid.dev/en/llms-full.txt')
    expect(chineseIndex).toContain('https://xid.dev/zh-hans/llms-full.txt')
    expect(englishIndex).toContain('https://xid.dev/sdks/llms.txt')
    expect(chineseIndex).toContain('https://xid.dev/zh-hans/sdks/llms.txt')
  })

  it('renders Nimbus-compatible content section indexes for every locale', () => {
    const groups = completeGroups()
    const [englishSection] = getPublicDocsIndexedSections(groups[0])
    const [chineseSection] = getPublicDocsIndexedSections(groups[1])
    if (!englishSection || !chineseSection) throw new TypeError('missing SDK section fixture')

    const englishIndex = renderPublicDocsSectionLlmsIndex(englishSection)
    const chineseFull = renderPublicDocsSectionLlmsFull(chineseSection)

    expect(englishIndex.match(/\/index\.md\)/g)).toHaveLength(29)
    expect(englishIndex).toContain('https://xid.dev/sdks/react/index.md')
    expect(englishIndex).not.toContain('https://xid.dev/zh-hans')
    expect(chineseFull.match(/<!-- xid-doc-path:/g)).toHaveLength(29)
    expect(chineseFull).toContain('<!-- xid-doc-path: /zh-hans/sdks/react -->')
    expect(chineseFull).not.toContain('<!-- xid-doc-path: /sdks/react -->')
  })

  it('renders a deterministic timestamp-free 352-page root corpus', () => {
    const groups = completeGroups()
    const first = renderPublicDocsGlobalLlmsFull(groups)
    const second = renderPublicDocsGlobalLlmsFull([...groups].reverse())

    expect(second).toBe(first)
    expect(first.match(/<!-- xid-doc-path:/g)).toHaveLength(PUBLIC_DOCS_INDEXED_TOTAL + 16)
    expect(first).toContain('<!-- xid-doc-path: /status -->')
    expect(first).toContain('<!-- xid-doc-path: /zh-hans/status -->')
    expect(first).not.toMatch(/^Generated(?: at| on):/im)
    expect(first).not.toMatch(/^Build timestamp:/im)
  })

  it('includes one homepage, one localized hub, 41 docs, and status in each section corpus', () => {
    const [english] = completeGroups()
    const corpus = renderPublicDocsLlmsFull(english)

    expect(corpus.match(/<!-- xid-doc-path:/g)).toHaveLength(44)
    expect(corpus.match(/<!-- xid-doc-slug:/g)).toHaveLength(43)
    expect(corpus).not.toContain('https://xid.dev/zh-hans')
    expect(corpus).toContain('https://xid.dev/getting-started')
  })

  it('derives index and corpus counts from the published document set', () => {
    const [english] = completeGroups()
    const reduced = {
      ...english,
      documents: english.documents.slice(2),
    }
    const index = renderPublicDocsLlmsIndex(reduced)
    const corpus = renderPublicDocsLlmsFull(reduced)

    expect(index.match(/\/index\.md\)/g)).toHaveLength(reduced.documents.length + 3)
    expect(corpus.match(/<!-- xid-doc-path:/g)).toHaveLength(reduced.documents.length + 3)
    expect(index).not.toContain(english.documents[0]?.item.markdownUrl)
    expect(corpus).not.toContain(`<!-- xid-doc-slug: ${english.documents[1]?.slug} -->`)
  })
})
