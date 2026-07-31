import {
  DOCUMENT_LOCALES,
  DOCUMENT_LOCALE_ROUTE_SEGMENTS,
  type DocumentLocale,
} from '../content-source/docs/types'

export type DocumentPublicationControls = {
  slug: string
  draft?: boolean
  noindex?: boolean
}

export function isDocumentHtmlPublished(document: DocumentPublicationControls): boolean {
  return document.draft !== true
}

export function isDocumentAgentPublished(document: DocumentPublicationControls): boolean {
  return document.draft !== true && document.noindex !== true
}

export function getLocalizedDocumentPath(locale: DocumentLocale, slug: string): string {
  const routeSegment = DOCUMENT_LOCALE_ROUTE_SEGMENTS[locale]
  return `${routeSegment === '' ? '' : `/${routeSegment}`}/${slug}`
}

export function getAgentExcludedDocumentPaths(
  documents: readonly DocumentPublicationControls[],
): ReadonlySet<string> {
  return new Set(
    DOCUMENT_LOCALES.flatMap((locale) =>
      documents
        .filter((document) => !isDocumentAgentPublished(document))
        .map((document) => getLocalizedDocumentPath(locale, document.slug)),
    ),
  )
}
