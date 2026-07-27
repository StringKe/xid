import type {
  DocumentAst,
  DocumentBlock,
  DocumentHubAst,
  DocumentLocale,
  RichText,
} from './types.ts'
import {
  localizedDocsHref,
  resolveRichText,
  type MessageTranslator,
  type RenderContext,
  type RichSegment,
} from './render-shared.ts'

export type MarkdownRenderOptions = {
  locale: DocumentLocale
  translate: MessageTranslator
}

function escapeMarkdownText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('{', '&#123;')
    .replaceAll('}', '&#125;')
    .replace(/([*_[\]])/g, '\\$1')
}

function renderInlineCode(value: string): string {
  const runs = value.match(/`+/g) ?? []
  const longestRun = runs.reduce((maximum, run) => Math.max(maximum, run.length), 0)
  const delimiter = '`'.repeat(longestRun + 1)
  const padding = value.startsWith('`') || value.endsWith('`') ? ' ' : ''
  return `${delimiter}${padding}${value}${padding}${delimiter}`
}

function plainTextFromSegments(segments: readonly RichSegment[]): string {
  return segments
    .map((segment) =>
      segment.kind === 'text' ? segment.value : plainTextFromSegments(segment.children),
    )
    .join('')
}

function renderSegments(segments: readonly RichSegment[], context: RenderContext): string {
  return segments
    .map((segment) => {
      if (segment.kind === 'text') {
        return escapeMarkdownText(segment.value)
      }
      if (segment.kind === 'inlineCode') {
        return renderInlineCode(plainTextFromSegments(segment.children))
      }
      if (segment.kind === 'strong') {
        return `**${renderSegments(segment.children, context)}**`
      }
      const label = renderSegments(segment.children, context)
      return `[${label}](${localizedDocsHref(segment.href, context.locale)})`
    })
    .join('')
}

export function renderMarkdownInline(value: RichText, options: MarkdownRenderOptions): string {
  return renderSegments(resolveRichText(value, options), options)
}

export function renderPlainText(value: RichText, options: MarkdownRenderOptions): string {
  return plainTextFromSegments(resolveRichText(value, options))
}

function renderTableCell(value: RichText, options: MarkdownRenderOptions): string {
  return renderMarkdownInline(value, options).replaceAll('|', '\\|').replace(/\r?\n/g, '<br />')
}

function renderCodeFence(language: string, value: string): string {
  const runs = value.match(/`{3,}/g) ?? []
  const longestRun = runs.reduce((maximum, run) => Math.max(maximum, run.length), 2)
  const fence = '`'.repeat(longestRun + 1)
  return `${fence}${language}\n${value}\n${fence}`
}

function renderBlock(block: DocumentBlock, options: MarkdownRenderOptions): string {
  if (block.kind === 'paragraph') {
    return renderMarkdownInline(block.content, options)
  }
  if (block.kind === 'list') {
    return block.items.map((item) => `- ${renderMarkdownInline(item, options)}`).join('\n')
  }
  if (block.kind === 'table') {
    const header = `| ${block.headers.map((cell) => renderTableCell(cell, options)).join(' | ')} |`
    const divider = `| ${block.headers.map(() => '---').join(' | ')} |`
    const rows = block.rows.map(
      (row) => `| ${row.map((cell) => renderTableCell(cell, options)).join(' | ')} |`,
    )
    return [header, divider, ...rows].join('\n')
  }
  return renderCodeFence(block.language, block.value)
}

export function renderMarkdownDocument(
  document: DocumentAst,
  options: MarkdownRenderOptions,
): string {
  const sections = document.sections.map((section) => {
    const heading = `## ${renderMarkdownInline(section.heading, options)}`
    const blocks = section.blocks.map((block) => renderBlock(block, options))
    return [heading, ...blocks].join('\n\n')
  })
  return sections.join('\n\n')
}

export function renderMarkdownHub(
  hub: DocumentHubAst,
  documents: readonly DocumentAst[],
  options: MarkdownRenderOptions,
): string {
  const documentsBySlug = new Map(documents.map((document) => [document.slug, document]))

  const renderGroup = (heading: RichText, slugs: readonly string[]): string => {
    const rows = slugs.map((slug) => {
      const document = documentsBySlug.get(slug)
      if (!document) {
        throw new TypeError(`hub navigation references unknown document ${slug}`)
      }
      const title = renderMarkdownInline(document.title, options)
      const summary = renderMarkdownInline(document.summary, options)
      const href = localizedDocsHref(`/${document.slug}`, options.locale)
      return `- [${title}](${href})\n  ${summary}`
    })
    return [`### ${renderMarkdownInline(heading, options)}`, ...rows].join('\n\n')
  }

  const renderedSections = hub.sections.map((section) => {
    const heading = `## ${renderMarkdownInline(section.heading, options)}`
    if (section.kind === 'product') {
      return [
        heading,
        ...section.paragraphs.map((paragraph) =>
          renderMarkdownInline(paragraph, options),
        ),
      ].join('\n\n')
    }
    if (section.kind === 'capabilities') {
      const items = section.items
        .map((item) => `- ${renderMarkdownInline(item, options)}`)
        .join('\n')
      return `${heading}\n\n${items}`
    }
    return [
      heading,
      ...section.groups.map((group) =>
        renderGroup(group.label, group.slugs),
      ),
    ].join('\n\n')
  })

  return [
    renderMarkdownInline(hub.eyebrow, options),
    renderMarkdownInline(hub.summary, options),
    ...renderedSections,
  ].join('\n\n')
}
