// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { waitForModelContext } from './wait-for-model-context'

describe('waitForModelContext', () => {
  afterEach(() => {
    Reflect.deleteProperty(document, 'modelContext')
  })

  it('returns null when aborted instead of throwing AbortError', async () => {
    const controller = new AbortController()
    const promise = waitForModelContext({ signal: controller.signal, pollMs: 20, timeoutMs: 200 })

    controller.abort()
    await expect(promise).resolves.toBeNull()
  })

  it('returns immediately when modelContext is already available', async () => {
    const registerTool = vi.fn<() => void>()
    Object.defineProperty(document, 'modelContext', {
      configurable: true,
      value: { registerTool },
    })

    const modelContext = await waitForModelContext({ pollMs: 1, timeoutMs: 50 })
    expect(modelContext?.registerTool).toBe(registerTool)
  })
})
