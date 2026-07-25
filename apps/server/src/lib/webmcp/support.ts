import { isPublicDocsPath } from '../../../public-docs'
import type { WebMcpDocument, WebMcpModelContext } from './types'

const BLOCKED_PATH_PREFIXES = [
  '/sign-in',
  '/sign-up',
  '/forgot-password',
  '/reset-password',
  '/mfa',
  '/verify-email',
  '/consent',
  '/activate',
  '/ciba-activation',
  '/accept-invitation',
  '/create-organization',
  '/select-organization',
  '/account',
  '/auth',
  '/v1',
  '/admin',
  '/platform-admin',
] as const

type ModelContextHost = WebMcpDocument & {
  navigator?: Navigator & { modelContext?: WebMcpModelContext }
}

function readModelContextFromHost(host: ModelContextHost): WebMcpModelContext | null {
  const candidates = [host.modelContext, host.navigator?.modelContext]
  for (const modelContext of candidates) {
    if (modelContext && typeof modelContext.registerTool === 'function') return modelContext
  }
  return null
}

export function readModelContext(): WebMcpModelContext | null {
  if (typeof document === 'undefined') return null
  return readModelContextFromHost(document as ModelContextHost)
}

export function isWebMcpSupported(): boolean {
  return readModelContext() !== null
}

export function isPublicWebMcpSurface(pathname: string): boolean {
  if (pathname === '/') return true
  return isPublicDocsPath(pathname)
}

export function isConsoleWebMcpSurface(pathname: string): boolean {
  return pathname === '/console' || pathname.startsWith('/console/')
}

export type WebMcpSurfaceKind = 'public' | 'console' | 'blocked'

export function getWebMcpSurfaceKind(pathname: string): WebMcpSurfaceKind {
  if (isBlockedWebMcpPath(pathname)) return 'blocked'
  if (isConsoleWebMcpSurface(pathname)) return 'console'
  if (isPublicWebMcpSurface(pathname)) return 'public'
  return 'blocked'
}

export function isBlockedWebMcpPath(pathname: string): boolean {
  return BLOCKED_PATH_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  )
}
