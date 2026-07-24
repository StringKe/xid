// runtime/plugin.client.ts: Nuxt client-side runtime plugin.
// Auto-registered by XidNuxtModule via addPlugin({ mode: 'client' }).
// Creates the XidClient singleton, installs XidPlugin into the Vue app
// (making composables available), and exposes the client as nuxtApp.$xid.
//
// runtimeConfig.public.xidApiUrl is written by setupXidModule when the
// consumer sets xid.apiUrl in nuxt.config.ts.
//
// This file requires the Nuxt runtime environment (defineNuxtPlugin / useRuntimeConfig).
// It is loaded by the Nuxt module system, not bundled by this library.

import { XidPlugin, createXidClient } from '@xid-kit/vue'

// Nuxt plugin entry: defineNuxtPlugin is provided by the host Nuxt runtime (peer dep).
// Declared here to avoid importing nuxt/app which would force a hard peer dependency
// on the full Nuxt package inside this library.
declare const defineNuxtPlugin: (
  setup: (nuxtApp: {
    vueApp: {
      use: (plugin: typeof XidPlugin, options?: Parameters<typeof XidPlugin.install>[1]) => void
    }
    provide: (name: string, value: unknown) => void
    $config: {
      public: {
        xidApiUrl?: string
        xidPublishableKey?: string
      }
    }
  }) => void,
) => unknown

export default defineNuxtPlugin((nuxtApp) => {
  // Read values written to runtimeConfig.public by setupXidModule.
  const apiUrl = nuxtApp.$config.public.xidApiUrl as string | undefined
  const publishableKey = nuxtApp.$config.public.xidPublishableKey as string | undefined

  const client = createXidClient({
    ...(apiUrl ? { apiUrl } : {}),
    ...(publishableKey ? { publishableKey } : {}),
  })

  // Install XidPlugin into the Vue app so composables (useXid, useAuth, etc.) work.
  nuxtApp.vueApp.use(XidPlugin, { client })

  // Expose on nuxtApp.$xid for direct access via useNuxtApp().$xid.
  nuxtApp.provide('xid', client)
})
