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
}

export type DocumentHubNavigationGroup = {
  label: MessageDescriptor
  slugs: readonly string[]
}

export type DocumentHubSection =
  | {
      kind: 'product'
      heading: MessageDescriptor
      paragraphs: readonly MessageDescriptor[]
    }
  | {
      kind: 'capabilities'
      heading: MessageDescriptor
      items: readonly MessageDescriptor[]
    }
  | {
      kind: 'navigation'
      heading: MessageDescriptor
      groups: readonly DocumentHubNavigationGroup[]
    }

export type DocumentHubAst = {
  eyebrow: MessageDescriptor
  title: MessageDescriptor
  summary: MessageDescriptor
  sections: readonly DocumentHubSection[]
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

  assertRecord(value.hub, 'document AST hub')
  for (const key of ['eyebrow', 'title', 'summary']) {
    assertRichText(value.hub[key], `document AST hub.${key}`)
  }
  if (!Array.isArray(value.hub.sections) || value.hub.sections.length !== 3) {
    throw new TypeError('document AST hub.sections must contain three sections')
  }
  const navigationSlugs: string[] = []
  const sectionKinds = new Set<string>()
  value.hub.sections.forEach((section, sectionIndex) => {
    const label = `document AST hub.sections.${sectionIndex}`
    assertRecord(section, label)
    assertString(section.kind, `${label}.kind`)
    if (sectionKinds.has(section.kind)) {
      throw new TypeError(`${label}.kind is duplicated`)
    }
    sectionKinds.add(section.kind)
    assertRichText(section.heading, `${label}.heading`)
    if (section.kind === 'product') {
      if (!Array.isArray(section.paragraphs) || section.paragraphs.length === 0) {
        throw new TypeError(`${label}.paragraphs must be a non-empty array`)
      }
      section.paragraphs.forEach((paragraph, index) =>
        assertRichText(paragraph, `${label}.paragraphs.${index}`),
      )
      return
    }
    if (section.kind === 'capabilities') {
      if (!Array.isArray(section.items) || section.items.length === 0) {
        throw new TypeError(`${label}.items must be a non-empty array`)
      }
      section.items.forEach((item, index) =>
        assertRichText(item, `${label}.items.${index}`),
      )
      return
    }
    if (section.kind !== 'navigation') {
      throw new TypeError(`${label}.kind is not supported`)
    }
    if (!Array.isArray(section.groups) || section.groups.length === 0) {
      throw new TypeError(`${label}.groups must be a non-empty array`)
    }
    section.groups.forEach((group, groupIndex) => {
      const groupLabel = `${label}.groups.${groupIndex}`
      assertRecord(group, groupLabel)
      assertRichText(group.label, `${groupLabel}.label`)
      if (!Array.isArray(group.slugs) || group.slugs.length === 0) {
        throw new TypeError(`${groupLabel}.slugs must be a non-empty array`)
      }
      group.slugs.forEach((slug, slugIndex) => {
        assertString(slug, `${groupLabel}.slugs.${slugIndex}`)
        navigationSlugs.push(slug)
      })
    })
  })
  for (const kind of ['product', 'capabilities', 'navigation']) {
    if (!sectionKinds.has(kind)) {
      throw new TypeError(`document AST hub.sections is missing ${kind}`)
    }
  }

  if (!Array.isArray(value.documents) || value.documents.length !== 40) {
    throw new TypeError('document AST must contain 40 documents')
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
    if (!Array.isArray(documentValue.sections)) {
      throw new TypeError(`${label}.sections must be an array`)
    }
    documentValue.sections.forEach((section, sectionIndex) =>
      assertSection(section, `${label}.sections.${sectionIndex}`),
    )
  })
  if (
    navigationSlugs.length !== slugs.size ||
    new Set(navigationSlugs).size !== slugs.size ||
    navigationSlugs.some((slug) => !slugs.has(slug))
  ) {
    throw new TypeError('document AST hub navigation must contain every document slug exactly once')
  }

  if (!Array.isArray(value.messageCatalog) || value.messageCatalog.length !== 1135) {
    throw new TypeError('document AST must contain 1135 catalog messages')
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
