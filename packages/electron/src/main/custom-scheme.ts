// 自定义协议 deep link 回调；与 loopback 二选一。
// 调用方须先 setAsDefaultProtocolClient，再 register，并交给 XidElectronApp。
// 仅 main 进程。

import type { App } from 'electron'

import type { LoopbackCallbackServer } from '../types'

const DEFAULT_TIMEOUT_MS = 300_000

type PendingCallback = {
  resolve: (url: URL) => void
  reject: (reason: Error) => void
}

/** 将 open-url / second-instance 适配为与 loopback 相同的 waitForCallback 接口。 */
export class XidCustomSchemeHandler {
  readonly #scheme: string
  #pending: PendingCallback | null = null

  constructor(scheme: string) {
    this.#scheme = scheme
  }

  register(app: App): void {
    // macOS/Linux：进程已运行时 deep link 走 open-url。
    app.on('open-url', (_event, url) => {
      this.#dispatchUrl(url)
    })

    // Windows/Linux 第二实例：deep link 在 argv 中。
    app.on('second-instance', (_event, argv) => {
      const deepLink = argv.find((arg) => arg.startsWith(`${this.#scheme}://`))
      if (deepLink) this.#dispatchUrl(deepLink)
    })
  }

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
      // 新登录覆盖旧 waiter，避免并发 sign-in 串状态。
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
