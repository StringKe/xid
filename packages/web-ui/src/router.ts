import {
  ACCOUNT_EXACT_PATH,
  CONSOLE_EXACT_PATH,
  isConsoleRoute,
  isCoreSpaRoute,
  normalizeLocalPath,
} from '@xid-kit/types'

export const NAVIGATION_RUNTIMES = ['core', 'console'] as const
export type NavigationRuntime = (typeof NAVIGATION_RUNTIMES)[number]

type NavigationRuntimeRoutes = {
  ownsPath: (pathname: string) => boolean
  fallbackPath: string
}

// 每个 SPA 只在自己的路由树内做客户端导航;/authorize 等 Worker 端点和另一个 SPA 的路径一律整页请求。
const NAVIGATION_RUNTIME_ROUTES: Readonly<Record<NavigationRuntime, NavigationRuntimeRoutes>> = {
  core: { ownsPath: isCoreSpaRoute, fallbackPath: ACCOUNT_EXACT_PATH },
  console: { ownsPath: isConsoleRoute, fallbackPath: CONSOLE_EXACT_PATH },
}

export function runtimeOwnsPath(runtime: NavigationRuntime, pathname: string): boolean {
  return NAVIGATION_RUNTIME_ROUTES[runtime].ownsPath(pathname)
}

export function navigationFallbackPath(runtime: NavigationRuntime): string {
  return NAVIGATION_RUNTIME_ROUTES[runtime].fallbackPath
}

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

// 同页 ?query / #hash 原样保留;其余目标只接受 normalizeLocalPath 认可的站内路径。
export function normalizeInternalNavigationTarget(to: string, fallback: string): string {
  if (to.startsWith('?') || to.startsWith('#')) return to
  return normalizeLocalPath(to) ?? fallback
}

function targetPathname(to: string, currentPathname: string): string {
  if (to.startsWith('?') || to.startsWith('#')) return currentPathname
  return to.split(/[?#]/, 1)[0] ?? currentPathname
}

export function usesDocumentNavigation(
  runtime: NavigationRuntime,
  to: string,
  currentPathname: string,
): boolean {
  const target = normalizeInternalNavigationTarget(to, navigationFallbackPath(runtime))
  return !runtimeOwnsPath(runtime, targetPathname(target, currentPathname))
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
      const target = normalizeInternalNavigationTarget(to, navigationFallbackPath(input.runtime))
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
