import type { WebMcpToolDefinition } from './types'
import { readModelContext } from './support'
import { waitForModelContext } from './wait-for-model-context'

let activeController: AbortController | null = null

export function unregisterWebMcpTools(): void {
  activeController?.abort()
  activeController = null
}

export function registerWebMcpTools(tools: readonly WebMcpToolDefinition[]): boolean {
  const modelContext = readModelContext()
  if (!modelContext) return false

  activeController?.abort()
  activeController = new AbortController()

  try {
    for (const tool of tools) {
      modelContext.registerTool(tool, { signal: activeController.signal })
    }
    return true
  } catch {
    activeController.abort()
    activeController = null
    return false
  }
}

export type SyncWebMcpToolsOptions = {
  signal?: AbortSignal
  timeoutMs?: number
  buildTools: () => readonly WebMcpToolDefinition[]
}

export async function syncWebMcpTools(options: SyncWebMcpToolsOptions): Promise<boolean> {
  const modelContext = await waitForModelContext({
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  })
  if (!modelContext || options.signal?.aborted) return false

  return registerWebMcpTools(options.buildTools())
}
