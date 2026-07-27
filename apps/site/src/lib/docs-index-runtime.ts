import { getIndexedEntries } from '@cloudflare/nimbus-docs'
import {
  isPublicDocsAgentIndexable,
  validatePublicDocsIndex,
  type PublicDocsIndexedLocale,
} from './docs-registry'

let publicDocsIndex: Promise<readonly PublicDocsIndexedLocale[]> | undefined

export function loadPublicDocsIndex(): Promise<readonly PublicDocsIndexedLocale[]> {
  publicDocsIndex ??= getIndexedEntries().then((entries) =>
    validatePublicDocsIndex(entries.filter(isPublicDocsAgentIndexable)),
  )
  return publicDocsIndex
}
