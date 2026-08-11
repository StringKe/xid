// Nuxt module：动态 import nuxt/kit（peer），避免把 Nuxt 打进本包。

import type { XidNuxtModuleOptions } from './types'

export const moduleMetadata = {
  name: '@xid-kit/nuxt',
  configKey: 'xid',
  version: '0.1.0-alpha.0',
  compatibility: {
    nuxt: '>=3.0.0',
  },
} as const

type NuxtModuleSetupContext = {
  options: XidNuxtModuleOptions
  nuxt: unknown
}

export async function setupXidModule(
  options: XidNuxtModuleOptions,
  _context: NuxtModuleSetupContext,
): Promise<void> {
  const kit = (await import('nuxt/kit')) as {
    addPlugin: (plugin: { src: string; mode?: 'client' | 'server' | 'all' }) => void
    addImports: (imports: ReadonlyArray<{ name: string; as?: string; from: string }>) => void
    addServerHandler?: (handler: { middleware: boolean; handler: string }) => void
    useNuxt?: () => { options: { runtimeConfig: { public: Record<string, unknown> } } }
  }

  if (options.browser && options.apiUrl) {
    throw new TypeError('xid.browser and xid.apiUrl are mutually exclusive')
  }

  // 仅把可序列化的 public 浏览器配置交给 client plugin。
  if (kit.useNuxt) {
    const nuxt = kit.useNuxt()
    nuxt.options.runtimeConfig.public['xidApiUrl'] = options.apiUrl ?? ''
    nuxt.options.runtimeConfig.public['xidBrowser'] = options.browser
  }

  // 绝对路径，便于跨 package 边界被 Nuxt 解析。
  kit.addPlugin({
    src: new URL('./runtime/plugin.client.ts', import.meta.url).pathname,
    mode: 'client',
  })

  kit.addImports([
    { name: 'useXid', from: '@xid-kit/vue' },
    { name: 'useAuth', from: '@xid-kit/vue' },
    { name: 'useUser', from: '@xid-kit/vue' },
    { name: 'useOrganization', from: '@xid-kit/vue' },
    { name: 'useSession', from: '@xid-kit/vue' },
  ])
}

export function defineXidModule() {
  return {
    meta: moduleMetadata,
    setup: setupXidModule,
  }
}

export default defineXidModule()
