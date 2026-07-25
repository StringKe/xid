// Tests for XidCustomSchemeHandler -- pure Node logic, no Electron runtime needed.
// We mock the App event emitter interface to avoid importing Electron.

import { describe, expect, it } from 'vitest'

import { XidCustomSchemeHandler } from '../main/custom-scheme'

// ---------------------------------------------------------------------------
// Minimal App event-emitter mock
// ---------------------------------------------------------------------------

type AppEventName = 'open-url' | 'second-instance'
type AppListener = (...args: unknown[]) => void

function createMockApp(): {
  app: import('electron').App
  emit: (event: AppEventName, ...args: unknown[]) => void
} {
  const listeners = new Map<AppEventName, AppListener[]>()

  const app = {
    on(event: string, listener: AppListener): typeof app {
      const key = event as AppEventName
      if (!listeners.has(key)) listeners.set(key, [])
      listeners.get(key)!.push(listener)
      return app
    },
  } as unknown as import('electron').App

  const emit = (event: AppEventName, ...args: unknown[]): void => {
    for (const listener of listeners.get(event) ?? []) {
      listener(...args)
    }
  }

  return { app, emit }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('XidCustomSchemeHandler', () => {
  it('asCallbackServer() redirectUri uses the registered scheme', () => {
    const handler = new XidCustomSchemeHandler('myapp')
    const server = handler.asCallbackServer()
    expect(server.redirectUri).toBe('myapp://callback')
  })

  it('resolves waitForCallback when open-url fires with matching scheme', async () => {
    const handler = new XidCustomSchemeHandler('myapp')
    const { app, emit } = createMockApp()
    handler.register(app)

    const server = handler.asCallbackServer()
    const promise = server.waitForCallback({ timeoutMs: 5000 })

    emit('open-url', {}, 'myapp://callback?code=abc&state=xyz')

    const result = await promise
    expect(result.searchParams.get('code')).toBe('abc')
    expect(result.searchParams.get('state')).toBe('xyz')
  })

  it('resolves waitForCallback from second-instance argv', async () => {
    const handler = new XidCustomSchemeHandler('myapp')
    const { app, emit } = createMockApp()
    handler.register(app)

    const server = handler.asCallbackServer()
    const promise = server.waitForCallback({ timeoutMs: 5000 })

    emit('second-instance', {}, ['electron', '.', 'myapp://callback?code=def&state=stu'])

    const result = await promise
    expect(result.searchParams.get('code')).toBe('def')
  })

  it('rejects on timeout', async () => {
    const handler = new XidCustomSchemeHandler('myapp')
    const { app } = createMockApp()
    handler.register(app)

    const server = handler.asCallbackServer()
    await expect(server.waitForCallback({ timeoutMs: 10 })).rejects.toThrow('timed out')
  })

  it('ignores second-instance argv that does not match scheme', async () => {
    const handler = new XidCustomSchemeHandler('myapp')
    const { app, emit } = createMockApp()
    handler.register(app)

    const server = handler.asCallbackServer()
    const promise = server.waitForCallback({ timeoutMs: 50 })

    // Wrong scheme -- should not resolve the promise.
    emit('second-instance', {}, ['electron', '.', 'other://callback?code=xxx&state=yyy'])

    await expect(promise).rejects.toThrow('timed out')
  })

  it('close() resolves without throwing', async () => {
    const handler = new XidCustomSchemeHandler('myapp')
    const server = handler.asCallbackServer()
    await expect(server.close()).resolves.toBeUndefined()
  })

  it('replaces previous pending waiter when a new one is created', async () => {
    const handler = new XidCustomSchemeHandler('myapp')
    const { app, emit } = createMockApp()
    handler.register(app)

    const server = handler.asCallbackServer()
    const first = server.waitForCallback({ timeoutMs: 5000 })

    // Start a second waiter -- should reject the first.
    const second = server.waitForCallback({ timeoutMs: 5000 })
    await expect(first).rejects.toThrow('replaced')

    // Now emit the callback -- second should resolve.
    emit('open-url', {}, 'myapp://callback?code=fresh&state=ok')
    const result = await second
    expect(result.searchParams.get('code')).toBe('fresh')
  })
})
