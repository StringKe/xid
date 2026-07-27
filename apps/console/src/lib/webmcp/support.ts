import type { WebMcpDocument, WebMcpModelContext } from './types'

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

export function isConsoleWebMcpSurface(pathname: string): boolean {
  return pathname === '/console' || pathname.startsWith('/console/')
}
