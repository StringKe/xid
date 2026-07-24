import type { WebMcpModelContext } from './types'
import { readModelContext } from './support'

const DEFAULT_POLL_MS = 50
const DEFAULT_TIMEOUT_MS = 15_000

export type WaitForModelContextOptions = {
  signal?: AbortSignal
  pollMs?: number
  timeoutMs?: number
}

function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(false)
      return
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve(true)
    }, ms)

    const onAbort = (): void => {
      clearTimeout(timer)
      resolve(false)
    }

    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export async function waitForModelContext(
  options: WaitForModelContextOptions = {},
): Promise<WebMcpModelContext | null> {
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (options.signal?.aborted) return null

    const modelContext = readModelContext()
    if (modelContext) return modelContext

    const continued = await sleep(pollMs, options.signal)
    if (!continued) return null
  }

  if (options.signal?.aborted) return null
  return readModelContext()
}
