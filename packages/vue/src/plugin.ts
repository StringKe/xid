import { inject, type InjectionKey } from 'vue'

import { XidClient, type XidClientOptions } from '@xid-kit/core'

// Symbol 注入 key，避免与其他插件的 provide 冲突。
export const XID_INJECTION_KEY: InjectionKey<XidClient> = Symbol('xid-client')

export type XidPluginOptions = XidClientOptions & {
  // 预建 client：测试 / SSR 跳过内部工厂。
  client?: XidClient
}

export function createXidClient(options: XidClientOptions = {}): XidClient {
  return new XidClient(options)
}

export function useXidClient(): XidClient {
  const client = inject(XID_INJECTION_KEY)
  if (!client) {
    throw new Error(
      '[xid-kit] useXidClient: must be called inside a component with XidPlugin installed. ' +
        "Install it via app.use(XidPlugin, { mode: 'same-origin' }).",
    )
  }
  return client
}

export const XidPlugin = {
  install(
    app: {
      provide: (key: symbol, value: unknown) => void
      unmount: () => void
    },
    options: XidPluginOptions = {},
  ): void {
    const client = options.client ?? createXidClient(options)

    app.provide(XID_INJECTION_KEY as symbol, client)

    // load() 失败只打日志，禁止 unhandled rejection 拖垮宿主应用。
    client.load().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[xid-kit] XidPlugin: client.load() failed:', msg)
    })

    // monkey-patch unmount：在 Vue 拆组件树前清理 client 订阅。
    const originalUnmount = app.unmount.bind(app)
    app.unmount = function unmountWithCleanup() {
      ;(client as { destroy?: () => void }).destroy?.()
      originalUnmount()
    }
  },
} as const
