// Main process: custom protocol (deep link) callback handler.
// Alternative to the loopback strategy for apps that register a custom
// URL scheme (e.g. 'myapp') with Electron / the OS.
//
// OAuth redirect_uri: myapp://callback
//
// Integration steps (caller's responsibility):
//   1. app.setAsDefaultProtocolClient('myapp') in main before app.ready
//   2. Register the 'open-url' (macOS/Linux) or second-instance (Windows) handler
//      by calling registerCustomSchemeHandler() from this module.
//   3. Pass the XidCustomSchemeHandler to XidElectronApp in the main process.
//
// This module must only run in the main process.

import type { App } from 'electron'

import type { LoopbackCallbackServer } from '../types'

const DEFAULT_TIMEOUT_MS = 300_000

type PendingCallback = {
  resolve: (url: URL) => void
  reject: (reason: Error) => void
}

/**
 * Custom-scheme callback handler.
 * Wraps the Electron 'open-url' / second-instance event as a
 * LoopbackCallbackServer-compatible interface so the rest of the OAuth flow
 * can treat both strategies uniformly.
 */
export class XidCustomSchemeHandler {
  readonly #scheme: string
  #pending: PendingCallback | null = null

  constructor(scheme: string) {
    this.#scheme = scheme
  }

  /**
   * Call during app.whenReady() to start listening for deep links.
   */
  register(app: App): void {
    // macOS / Linux: app emits 'open-url' for deep links when already running.
    app.on('open-url', (_event, url) => {
      this.#dispatchUrl(url)
    })

    // Windows / Linux (second instance): deep link arrives as argv.
    app.on('second-instance', (_event, argv) => {
      const deepLink = argv.find((arg) => arg.startsWith(`${this.#scheme}://`))
      if (deepLink) this.#dispatchUrl(deepLink)
    })
  }

  /**
   * Returns a LoopbackCallbackServer-compatible object for a single sign-in
   * attempt. The redirectUri uses the custom scheme.
   */
  asCallbackServer(): LoopbackCallbackServer {
    const redirectUri = `${this.#scheme}://callback`
    return {
      redirectUri,
      waitForCallback: (options) => this.#waitForCallback(options?.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      close: async () => {
        this.#pending = null
      },
    }
  }

  #dispatchUrl(rawUrl: string): void {
    if (!this.#pending) return
    const { resolve, reject } = this.#pending
    this.#pending = null
    try {
      resolve(new URL(rawUrl))
    } catch {
      reject(new Error(`[xid-electron] invalid deep link URL: ${rawUrl}`))
    }
  }

  #waitForCallback(timeoutMs: number): Promise<URL> {
    if (this.#pending) {
      // Reject any previous waiter before creating a new one.
      this.#pending.reject(new Error('[xid-electron] replaced by new sign-in attempt'))
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.#pending?.reject === reject) this.#pending = null
        reject(new Error('[xid-electron] custom-scheme callback timed out'))
      }, timeoutMs)

      this.#pending = {
        resolve: (url) => {
          clearTimeout(timer)
          resolve(url)
        },
        reject: (err) => {
          clearTimeout(timer)
          reject(err)
        },
      }
    })
  }
}
