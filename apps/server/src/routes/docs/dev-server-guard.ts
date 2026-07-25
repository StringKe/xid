import { isDocsPath, isPublicDocsPath } from '../../../public-docs'
import { trimTrailingSlashes } from '../../../shared/url'

function safeDecodePath(pathname: string): string {
  try {
    return decodeURIComponent(pathname)
  } catch {
    return pathname
  }
}

export function isInternalRepositoryDocsFsPath(pathname: string, docsFsPrefix: string): boolean {
  const path = trimTrailingSlashes(safeDecodePath(pathname).replace(/^\/%40fs/, '/@fs'))
  const prefix = trimTrailingSlashes(safeDecodePath(docsFsPrefix).replace(/^\/%40fs/, '/@fs'))
  return path === prefix || path.startsWith(`${prefix}/`)
}

export function isBlockedDocsRoutePath(pathname: string): boolean {
  return isDocsPath(pathname) && !isPublicDocsPath(pathname)
}
