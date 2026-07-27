export const NAVIGATION_RUNTIMES = ['core', 'console'] as const
export type NavigationRuntime = (typeof NAVIGATION_RUNTIMES)[number]

export type NavigateOptions = {
  replace?: boolean
  state?: unknown
}

export type NavigateFunction = (to: string, options?: NavigateOptions) => void

export type ClientNavigate = (to: string, options?: NavigateOptions) => void | Promise<unknown>

export type DocumentNavigation = {
  assign: (url: string) => void
  replace: (url: string) => void
}

export type RouterAdapter = {
  navigate: NavigateFunction
  usesDocumentNavigation: (to: string) => boolean
}

function hasAsciiControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (codePoint !== undefined && (codePoint < 32 || codePoint === 127)) return true
  }
  return false
}

export function normalizeInternalNavigationTarget(to: string, fallback = '/console'): string {
  if (to.startsWith('?') || to.startsWith('#')) return to
  if (
    to.startsWith('/') &&
    !to.startsWith('//') &&
    !to.includes('\\') &&
    !hasAsciiControlCharacter(to)
  ) {
    return to
  }
  return fallback
}

function targetPathname(to: string, currentPathname: string): string {
  if (to.startsWith('?') || to.startsWith('#')) return currentPathname
  return to.split(/[?#]/, 1)[0] ?? currentPathname
}

function isConsolePath(pathname: string): boolean {
  return pathname === '/console' || pathname.startsWith('/console/')
}

function isSitePath(pathname: string): boolean {
  return pathname === '/'
}

export function usesDocumentNavigation(
  runtime: NavigationRuntime,
  to: string,
  currentPathname: string,
): boolean {
  const target = normalizeInternalNavigationTarget(to)
  const pathname = targetPathname(target, currentPathname)
  if (runtime === 'console') return !isConsolePath(pathname)
  return isConsolePath(pathname) || isSitePath(pathname)
}

function browserDocumentNavigation(): DocumentNavigation {
  const location = globalThis.location
  if (!location) throw new Error('Document navigation requires a browser location')
  return {
    assign: (url) => location.assign(url),
    replace: (url) => location.replace(url),
  }
}

export function createRouterAdapter(input: {
  runtime: NavigationRuntime
  clientNavigate: ClientNavigate
  getCurrentPathname: () => string
  documentNavigation?: DocumentNavigation
}): RouterAdapter {
  const shouldUseDocument = (to: string): boolean =>
    usesDocumentNavigation(input.runtime, to, input.getCurrentPathname())

  return {
    usesDocumentNavigation: shouldUseDocument,
    navigate: (to, options) => {
      const target = normalizeInternalNavigationTarget(to)
      if (!shouldUseDocument(target)) {
        void input.clientNavigate(target, options)
        return
      }
      const documentNavigation = input.documentNavigation ?? browserDocumentNavigation()
      if (options?.replace) {
        documentNavigation.replace(target)
        return
      }
      documentNavigation.assign(target)
    },
  }
}
