import { XidPlugin, createXidClient } from '@xid-kit/vue'
import type { XidClientOptions } from '@xid-kit/core'
import type { XidNuxtBrowserOptions } from '../types'

// 由宿主 Nuxt 注入；声明而非 import nuxt/app，避免硬依赖整包 Nuxt。
declare const defineNuxtPlugin: (
  setup: (nuxtApp: {
    vueApp: {
      use: (plugin: typeof XidPlugin, options?: Parameters<typeof XidPlugin.install>[1]) => void
    }
    provide: (name: string, value: unknown) => void
    $config: {
      public: {
        xidApiUrl?: string
        xidBrowser?: XidNuxtBrowserOptions
      }
    }
  }) => void,
) => unknown

export default defineNuxtPlugin((nuxtApp) => {
  const apiUrl = nuxtApp.$config.public.xidApiUrl as string | undefined
  const browser = nuxtApp.$config.public.xidBrowser
  const options: XidClientOptions = browser ?? {
    mode: 'same-origin',
    ...(apiUrl ? { apiUrl } : {}),
  }
  const client = createXidClient(options)

  nuxtApp.vueApp.use(XidPlugin, { client })
  nuxtApp.provide('xid', client)
})
