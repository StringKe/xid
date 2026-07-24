// XidPlugin: Vue 3 app.use() plugin. Injects an XidClient singleton and
// handles cleanup on app.unmount().
// provide/inject uses XID_INJECTION_KEY (InjectionKey<XidClient>) to pass the client.

import { inject, type InjectionKey } from 'vue'

import { XidClient, type XidClientOptions } from '@xid-kit/core'

// Injection key: unique Symbol prevents collisions with other plugins.
export const XID_INJECTION_KEY: InjectionKey<XidClient> = Symbol('xid-client')

export type XidPluginOptions = XidClientOptions & {
  // Override API root (self-hosted scenario).
  apiUrl?: string
  // Pre-built client instance (testing / SSR: skip internal factory).
  client?: XidClient
}

// createXidClient: factory function used by XidPlugin and plain TS contexts.
export function createXidClient(options: XidClientOptions = {}): XidClient {
  return new XidClient(options)
}

// useXidClient: retrieves the XidClient from provide/inject.
// Must be called inside a component with XidPlugin installed, otherwise throws.
export function useXidClient(): XidClient {
  const client = inject(XID_INJECTION_KEY)
  if (!client) {
    throw new Error(
      '[xid-kit] useXidClient: must be called inside a component with XidPlugin installed. ' +
        "Install it via app.use(XidPlugin, { apiUrl: 'https://...' }).",
    )
  }
  return client
}

// XidPlugin: Vue 3 Plugin interface (install method).
export const XidPlugin = {
  install(
    app: {
      provide: (key: symbol, value: unknown) => void
      unmount: () => void
    },
    options: XidPluginOptions = {},
  ): void {
    const client = options.client ?? createXidClient(options)

    // Inject globally so all child components can access via inject(XID_INJECTION_KEY).
    app.provide(XID_INJECTION_KEY as symbol, client)

    // Bootstrap: fetch initial auth snapshot.
    // Rejection is caught and logged; it must not produce an unhandled rejection
    // that crashes the host application (e.g. when the API server is unreachable).
    client.load().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[xid-kit] XidPlugin: client.load() failed:', msg)
    })

    // Cleanup on app.unmount: unsubscribe all XidClient listeners by calling destroy()
    // if the client exposes it. Monkey-patch app.unmount so plugin cleanup runs before
    // Vue tears down the component tree.
    const originalUnmount = app.unmount.bind(app)
    app.unmount = function unmountWithCleanup() {
      // Call destroy() if available (future XidClient API) to flush subscriptions.
      ;(client as { destroy?: () => void }).destroy?.()
      originalUnmount()
    }
  },
} as const
