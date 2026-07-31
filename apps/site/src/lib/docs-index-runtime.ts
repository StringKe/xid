import { getIndexedEntries } from '@cloudflare/nimbus-docs'
import type { PublicDocSlug } from '@xid-kit/types'
import documents from '../content-source/docs/documents.json'
import { assertDocumentAstBundle, type DocumentAstBundle } from '../content-source/docs/types'
import { isDocumentAgentPublished } from './docs-publication'
import {
  isPublicDocsAgentIndexable,
  validatePublicDocsIndex,
  type PublicDocsIndexedLocale,
} from './docs-registry'

let publicDocsIndex: Promise<readonly PublicDocsIndexedLocale[]> | undefined

export function loadPublicDocsIndex(): Promise<readonly PublicDocsIndexedLocale[]> {
  assertDocumentAstBundle(documents)
  const sourceBundle = documents as DocumentAstBundle
  const expectedDocumentSlugs = sourceBundle.documents
    .filter(isDocumentAgentPublished)
    .map((document) => document.slug as PublicDocSlug)
  publicDocsIndex ??= getIndexedEntries().then((entries) =>
    validatePublicDocsIndex(entries.filter(isPublicDocsAgentIndexable), expectedDocumentSlugs),
  )
  return publicDocsIndex
}
