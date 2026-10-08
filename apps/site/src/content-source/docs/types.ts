export const DOCUMENT_AST_VERSION = 1 as const

export const DOCUMENT_LOCALES = ['en', 'zh-Hans', 'ja', 'ko', 'fr', 'de', 'es', 'pt-BR'] as const

export type DocumentLocale = (typeof DOCUMENT_LOCALES)[number]

export const DOCUMENT_LOCALE_ROUTE_SEGMENTS = {
  en: '',
  'zh-Hans': 'zh-hans',
  ja: 'ja',
  ko: 'ko',
  fr: 'fr',
  de: 'de',
  es: 'es',
  'pt-BR': 'pt-br',
} as const satisfies Readonly<Record<DocumentLocale, string>>

export type RichTag = { kind: 'inlineCode' } | { kind: 'strong' } | { kind: 'link'; href: string }

export type MessageValue = {
  source: 'static' | 'literal'
  value: string
}

export type MessageDescriptor = {
  kind: 'message'
  id: string
  message: string
  values: Readonly<Record<string, MessageValue>>
  tags: Readonly<Record<string, RichTag>>
}

export type LiteralText = {
  kind: 'literal'
  value: string
}

export type InlineCode = {
  kind: 'inlineCode'
  value: string
}

export type RichSequence = {
  kind: 'sequence'
  children: readonly RichText[]
}

export type RichText = MessageDescriptor | LiteralText | InlineCode | RichSequence

export type ParagraphBlock = {
  kind: 'paragraph'
  content: RichText
}

export type ListBlock = {
  kind: 'list'
  items: readonly RichText[]
}

export type TableBlock = {
  kind: 'table'
  headers: readonly RichText[]
  rows: readonly (readonly RichText[])[]
}

export type CodeBlock = {
  kind: 'code'
  language: string
  value: string
  sourcePosition: string
}

export type DocumentBlock = ParagraphBlock | ListBlock | TableBlock | CodeBlock

export type DocumentSection = {
  heading: RichText
  blocks: readonly DocumentBlock[]
}

export type DocumentAst = {
  slug: string
  title: RichText
  summary: RichText
  sections: readonly DocumentSection[]
  /** 正常发布省略；draft 时 Nimbus 不产出生产构建。 */
  draft?: boolean
  /** 正常发布省略；HTML 仍可访问但不进 agent 索引。 */
  noindex?: boolean
}

export type DocumentHubItem = {
  /** 顶层文章；`sdks/*` 这类子文章归在父文章的行下。 */
  slug: string
  summary: MessageDescriptor
}

export type DocumentHubGroup = {
  label: MessageDescriptor
  items: readonly DocumentHubItem[]
}

/** 文档首页与侧栏共用的产品分组，与网站首页的分节一致。hub 始终发布，故意不暴露 draft/noindex。 */
export type DocumentHubAst = {
  title: MessageDescriptor
  summary: MessageDescriptor
  groups: readonly DocumentHubGroup[]
}

export function parentDocumentSlug(slug: string): string {
  return slug.split('/')[0] ?? slug
}

export type MessageCatalogEntry = {
  id: string
  message: string
}

export type DocumentAstStats = {
  documents: number
  sections: number
  paragraphs: number
  listItems: number
  tables: number
  tableRows: number
  codeBlocks: number
  richTags: Readonly<Record<'inlineCode' | 'strong' | 'link', number>>
  staticValues: number
  literalValues: number
  catalogMessages: number
}

export type DocumentAstBundle = {
  version: typeof DOCUMENT_AST_VERSION
  locales: readonly DocumentLocale[]
  hub: DocumentHubAst
  documents: readonly DocumentAst[]
  messageCatalog: readonly MessageCatalogEntry[]
  stats: DocumentAstStats
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`)
  }
}

function assertRichText(value: unknown, label: string): asserts value is RichText {
  assertRecord(value, label)
  assertString(value.kind, `${label}.kind`)

  if (value.kind === 'literal' || value.kind === 'inlineCode') {
    if (typeof value.value !== 'string') {
      throw new TypeError(`${label}.value must be a string`)
    }
    return
  }

  if (value.kind === 'sequence') {
    if (!Array.isArray(value.children) || value.children.length === 0) {
      throw new TypeError(`${label}.children must be a non-empty array`)
    }
    value.children.forEach((child, childIndex) =>
      assertRichText(child, `${label}.children.${childIndex}`),
    )
    return
  }

  if (value.kind !== 'message') {
    throw new TypeError(`${label}.kind is not supported`)
  }

  assertString(value.id, `${label}.id`)
  assertString(value.message, `${label}.message`)
  assertRecord(value.values, `${label}.values`)
  assertRecord(value.tags, `${label}.tags`)

  for (const [name, messageValue] of Object.entries(value.values)) {
    assertRecord(messageValue, `${label}.values.${name}`)
    if (
      (messageValue.source !== 'static' && messageValue.source !== 'literal') ||
      typeof messageValue.value !== 'string'
    ) {
      throw new TypeError(`${label}.values.${name} is not a supported value`)
    }
  }

  for (const [index, tag] of Object.entries(value.tags)) {
    if (!/^\d+$/.test(index)) {
      throw new TypeError(`${label}.tags.${index} must use a numeric key`)
    }
    assertRecord(tag, `${label}.tags.${index}`)
    if (tag.kind === 'inlineCode' || tag.kind === 'strong') continue
    if (tag.kind === 'link') {
      assertString(tag.href, `${label}.tags.${index}.href`)
      if (!tag.href.startsWith('/') || tag.href.startsWith('//') || tag.href.startsWith('/docs/')) {
        throw new TypeError(`${label}.tags.${index}.href must target canonical docs`)
      }
      continue
    }
    throw new TypeError(`${label}.tags.${index}.kind is not supported`)
  }
}

function assertSection(value: unknown, label: string): asserts value is DocumentSection {
  assertRecord(value, label)
  assertRichText(value.heading, `${label}.heading`)
  if (!Array.isArray(value.blocks)) {
    throw new TypeError(`${label}.blocks must be an array`)
  }

  for (const [blockIndex, blockValue] of value.blocks.entries()) {
    const blockLabel = `${label}.blocks.${blockIndex}`
    assertRecord(blockValue, blockLabel)
    assertString(blockValue.kind, `${blockLabel}.kind`)

    if (blockValue.kind === 'paragraph') {
      assertRichText(blockValue.content, `${blockLabel}.content`)
      continue
    }

    if (blockValue.kind === 'list') {
      if (!Array.isArray(blockValue.items)) {
        throw new TypeError(`${blockLabel}.items must be an array`)
      }
      blockValue.items.forEach((item, itemIndex) =>
        assertRichText(item, `${blockLabel}.items.${itemIndex}`),
      )
      continue
    }

    if (blockValue.kind === 'table') {
      const headers = blockValue.headers
      const rows = blockValue.rows
      if (!Array.isArray(headers) || !Array.isArray(rows)) {
        throw new TypeError(`${blockLabel} table shape is invalid`)
      }
      headers.forEach((header, headerIndex) =>
        assertRichText(header, `${blockLabel}.headers.${headerIndex}`),
      )
      rows.forEach((row, rowIndex) => {
        if (!Array.isArray(row) || row.length !== headers.length) {
          throw new TypeError(`${blockLabel}.rows.${rowIndex} width is invalid`)
        }
        row.forEach((cell, cellIndex) =>
          assertRichText(cell, `${blockLabel}.rows.${rowIndex}.${cellIndex}`),
        )
      })
      continue
    }

    if (blockValue.kind === 'code') {
      assertString(blockValue.language, `${blockLabel}.language`)
      if (typeof blockValue.value !== 'string') {
        throw new TypeError(`${blockLabel}.value must be a string`)
      }
      assertString(blockValue.sourcePosition, `${blockLabel}.sourcePosition`)
      continue
    }

    throw new TypeError(`${blockLabel}.kind is not supported`)
  }
}

function assertHub(hub: unknown): string[] {
  assertRecord(hub, 'document AST hub')
  assertRichText(hub.title, 'document AST hub.title')
  assertRichText(hub.summary, 'document AST hub.summary')
  if (!Array.isArray(hub.groups) || hub.groups.length === 0) {
    throw new TypeError('document AST hub.groups must be a non-empty array')
  }
  const itemSlugs: string[] = []
  hub.groups.forEach((group, groupIndex) => {
    const label = `document AST hub.groups.${groupIndex}`
    assertRecord(group, label)
    assertRichText(group.label, `${label}.label`)
    if (!Array.isArray(group.items) || group.items.length === 0) {
      throw new TypeError(`${label}.items must be a non-empty array`)
    }
    group.items.forEach((item, itemIndex) => {
      const itemLabel = `${label}.items.${itemIndex}`
      assertRecord(item, itemLabel)
      assertString(item.slug, `${itemLabel}.slug`)
      if (parentDocumentSlug(item.slug) !== item.slug) {
        throw new TypeError(`${itemLabel}.slug must be a top-level document`)
      }
      assertRichText(item.summary, `${itemLabel}.summary`)
      itemSlugs.push(item.slug)
    })
  })
  return itemSlugs
}

export function assertDocumentAstBundle(value: unknown): asserts value is DocumentAstBundle {
  assertRecord(value, 'document AST')
  if (value.version !== DOCUMENT_AST_VERSION) {
    throw new TypeError(`document AST version must be ${DOCUMENT_AST_VERSION}`)
  }
  if (
    !Array.isArray(value.locales) ||
    value.locales.length !== DOCUMENT_LOCALES.length ||
    value.locales.some((locale, index) => locale !== DOCUMENT_LOCALES[index])
  ) {
    throw new TypeError('document AST locales are invalid')
  }

  const navigationSlugs = assertHub(value.hub)

  if (!Array.isArray(value.documents) || value.documents.length === 0) {
    throw new TypeError('document AST must contain documents')
  }
  const slugs = new Set<string>()
  value.documents.forEach((documentValue, documentIndex) => {
    const label = `document AST documents.${documentIndex}`
    assertRecord(documentValue, label)
    assertString(documentValue.slug, `${label}.slug`)
    if (slugs.has(documentValue.slug)) {
      throw new TypeError(`${label}.slug is duplicated`)
    }
    slugs.add(documentValue.slug)
    assertRichText(documentValue.title, `${label}.title`)
    assertRichText(documentValue.summary, `${label}.summary`)
    for (const field of ['draft', 'noindex'] as const) {
      if (documentValue[field] !== undefined && typeof documentValue[field] !== 'boolean') {
        throw new TypeError(`${label}.${field} must be true or false`)
      }
    }
    if (!Array.isArray(documentValue.sections)) {
      throw new TypeError(`${label}.sections must be an array`)
    }
    documentValue.sections.forEach((section, sectionIndex) =>
      assertSection(section, `${label}.sections.${sectionIndex}`),
    )
  })
  const topLevelSlugs = [...slugs].filter((slug) => parentDocumentSlug(slug) === slug)
  if (
    navigationSlugs.length !== topLevelSlugs.length ||
    new Set(navigationSlugs).size !== topLevelSlugs.length ||
    navigationSlugs.some((slug) => !slugs.has(slug)) ||
    [...slugs].some((slug) => !navigationSlugs.includes(parentDocumentSlug(slug)))
  ) {
    throw new TypeError(
      'document AST hub groups must list every top-level document exactly once and cover every nested document through its parent',
    )
  }

  if (!Array.isArray(value.messageCatalog) || value.messageCatalog.length === 0) {
    throw new TypeError('document AST must contain catalog messages')
  }
  const catalogIds = new Set<string>()
  value.messageCatalog.forEach((entryValue, entryIndex) => {
    const label = `document AST messageCatalog.${entryIndex}`
    assertRecord(entryValue, label)
    assertString(entryValue.id, `${label}.id`)
    assertString(entryValue.message, `${label}.message`)
    if (catalogIds.has(entryValue.id)) {
      throw new TypeError(`${label}.id is duplicated`)
    }
    catalogIds.add(entryValue.id)
  })

  assertRecord(value.stats, 'document AST stats')
}
