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

export type HtmlRenderOptions = {
  locale: DocumentLocale
  translate: MessageTranslator
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function renderSegments(segments: readonly RichSegment[], context: RenderContext): string {
  return segments
    .map((segment) => {
      if (segment.kind === 'text') {
        return escapeHtml(segment.value)
      }
      if (segment.kind === 'inlineCode') {
        return `<code>${renderSegments(segment.children, context)}</code>`
      }
      if (segment.kind === 'strong') {
        return `<strong>${renderSegments(segment.children, context)}</strong>`
      }
      const href = escapeHtml(localizedDocsHref(segment.href, context.locale))
      return `<a href="${href}">${renderSegments(segment.children, context)}</a>`
    })
    .join('')
}

export function renderHtmlInline(value: RichText, options: HtmlRenderOptions): string {
  return renderSegments(resolveRichText(value, options), options)
}

function renderBlock(block: DocumentBlock, options: HtmlRenderOptions): string {
  if (block.kind === 'paragraph') {
    return `<p>${renderHtmlInline(block.content, options)}</p>`
  }
  if (block.kind === 'list') {
    const items = block.items.map((item) => `<li>${renderHtmlInline(item, options)}</li>`).join('')
    return `<ul>${items}</ul>`
  }
  if (block.kind === 'table') {
    const headers = block.headers
      .map((header) => `<th>${renderHtmlInline(header, options)}</th>`)
      .join('')
    const rows = block.rows
      .map(
        (row) =>
          `<tr>${row.map((cell) => `<td>${renderHtmlInline(cell, options)}</td>`).join('')}</tr>`,
      )
      .join('')
    return `<table><thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table>`
  }
  const language = escapeHtml(block.language)
  return `<pre><code class="language-${language}">${escapeHtml(block.value)}</code></pre>`
}

export function renderHtmlDocument(document: DocumentAst, options: HtmlRenderOptions): string {
  const title = renderHtmlInline(document.title, options)
  const summary = renderHtmlInline(document.summary, options)
  const sections = document.sections
    .map((section) => {
      const heading = renderHtmlInline(section.heading, options)
      const blocks = section.blocks.map((block) => renderBlock(block, options)).join('')
      return `<section><h2>${heading}</h2>${blocks}</section>`
    })
    .join('')
  return `<article><header><h1>${title}</h1><p>${summary}</p></header>${sections}</article>`
}

export function renderHtmlHub(
  hub: DocumentHubAst,
  documents: readonly DocumentAst[],
  options: HtmlRenderOptions,
): string {
  const documentsBySlug = new Map(documents.map((document) => [document.slug, document]))

  const renderGroup = (
    label: RichText,
    slugs: readonly string[],
  ): string => {
      const items = slugs
        .map((slug) => {
          const document = documentsBySlug.get(slug)
          if (!document) {
            throw new TypeError(`hub navigation references unknown document ${slug}`)
          }
          const href = localizedDocsHref(`/${document.slug}`, options.locale)
          return `<li><a href="${escapeHtml(href)}">${renderHtmlInline(document.title, options)}</a><p>${renderHtmlInline(document.summary, options)}</p></li>`
        })
        .join('')
      return `<section><h3>${renderHtmlInline(label, options)}</h3><ul>${items}</ul></section>`
  }

  const sectionHtml = hub.sections
    .map((section) => {
      const heading = renderHtmlInline(section.heading, options)
      if (section.kind === 'product') {
        const paragraphs = section.paragraphs
          .map(
            (paragraph) =>
              `<p>${renderHtmlInline(paragraph, options)}</p>`,
          )
          .join('')
        return `<section><h2>${heading}</h2>${paragraphs}</section>`
      }
      if (section.kind === 'capabilities') {
        const items = section.items
          .map((item) => `<li>${renderHtmlInline(item, options)}</li>`)
          .join('')
        return `<section><h2>${heading}</h2><ul>${items}</ul></section>`
      }
      const groups = section.groups
        .map((group) => renderGroup(group.label, group.slugs))
        .join('')
      return `<section><h2>${heading}</h2>${groups}</section>`
    })
    .join('')

  return `<article><header><p>${renderHtmlInline(hub.eyebrow, options)}</p><h1>${renderHtmlInline(hub.title, options)}</h1><p>${renderHtmlInline(hub.summary, options)}</p></header>${sectionHtml}</article>`
}
