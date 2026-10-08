import type { DocumentAst, DocumentBlock, DocumentLocale, RichText } from './types.ts'
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
