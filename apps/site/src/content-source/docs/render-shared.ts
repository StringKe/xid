import {
  DOCUMENT_LOCALE_ROUTE_SEGMENTS,
  type DocumentLocale,
  type MessageDescriptor,
  type RichTag,
  type RichText,
} from './types.ts'

export type MessageTranslator = (descriptor: MessageDescriptor) => string

export type RenderContext = {
  locale: DocumentLocale
  translate: MessageTranslator
}

export type RichSegment =
  | { kind: 'text'; value: string }
  | { kind: 'inlineCode'; children: readonly RichSegment[] }
  | { kind: 'strong'; children: readonly RichSegment[] }
  | { kind: 'link'; href: string; children: readonly RichSegment[] }

type OpenSegment = {
  index: string
  tag: RichTag
  children: RichSegment[]
}

function appendText(segments: RichSegment[], value: string): void {
  if (value.length === 0) return
  const previous = segments.at(-1)
  if (previous?.kind === 'text') {
    previous.value += value
    return
  }
  segments.push({ kind: 'text', value })
}

function closeSegment(open: OpenSegment): RichSegment {
  if (open.tag.kind === 'inlineCode') {
    return { kind: 'inlineCode', children: open.children }
  }
  if (open.tag.kind === 'strong') {
    return { kind: 'strong', children: open.children }
  }
  return { kind: 'link', href: open.tag.href, children: open.children }
}

export function parseTranslatedRichText(
  translated: string,
  tags: Readonly<Record<string, RichTag>>,
): readonly RichSegment[] {
  const root: RichSegment[] = []
  const stack: OpenSegment[] = []
  const usedTags = new Set<string>()
  const tokenPattern = /<\/?(\d+)>/g
  let cursor = 0
  let match: RegExpExecArray | null

  while ((match = tokenPattern.exec(translated)) !== null) {
    const target = stack.at(-1)?.children ?? root
    appendText(target, translated.slice(cursor, match.index))
    const token = match[0]
    const index = match[1]
    const tag = tags[index]
    if (!tag) {
      throw new TypeError(`translated message references undeclared rich tag ${index}`)
    }

    if (token.startsWith('</')) {
      const open = stack.pop()
      if (!open || open.index !== index) {
        throw new TypeError(`translated message closes rich tag ${index} out of order`)
      }
      const parent = stack.at(-1)?.children ?? root
      parent.push(closeSegment(open))
      usedTags.add(index)
    } else {
      if (stack.some((open) => open.index === index) || usedTags.has(index)) {
        throw new TypeError(`translated message repeats rich tag ${index}`)
      }
      stack.push({ index, tag, children: [] })
    }
    cursor = tokenPattern.lastIndex
  }

  appendText(stack.at(-1)?.children ?? root, translated.slice(cursor))
  if (stack.length > 0) {
    throw new TypeError(`translated message leaves rich tag ${stack.at(-1)?.index} open`)
  }
  for (const index of Object.keys(tags)) {
    if (!usedTags.has(index)) {
      throw new TypeError(`translated message did not consume rich tag ${index}`)
    }
  }
  return root
}

export function resolveRichText(value: RichText, context: RenderContext): readonly RichSegment[] {
  if (value.kind === 'literal') {
    return [{ kind: 'text', value: value.value }]
  }
  if (value.kind === 'inlineCode') {
    return [{ kind: 'inlineCode', children: [{ kind: 'text', value: value.value }] }]
  }
  if (value.kind === 'sequence') {
    return value.children.flatMap((child) => resolveRichText(child, context))
  }
  return parseTranslatedRichText(context.translate(value), value.tags)
}

export function localizedDocsHref(href: string, locale: DocumentLocale): string {
  if (!href.startsWith('/') || href.startsWith('//') || href.startsWith('/docs/')) {
    throw new TypeError(`rich link does not target canonical docs: ${href}`)
  }
  const routeSegment = DOCUMENT_LOCALE_ROUTE_SEGMENTS[locale]
  return routeSegment === '' ? href : `/${routeSegment}${href}`
}
