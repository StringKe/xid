// XidNuxtModule: Nuxt module definition (defineNuxtModule wrapper).
// Registers the client plugin, runtimeConfig, auto-import composables,
// and (optionally) the server middleware.
//
// Usage (nuxt.config.ts):
//   export default defineNuxtConfig({
//     modules: ['@xid-kit/nuxt'],
//     xid: { publishableKey: 'pk_live_...' },
//   })
//
// Nuxt/kit is a peer dep provided by the host; dynamic import avoids hard-bundling nuxt.

import type { XidNuxtModuleOptions } from './types'

// Nuxt module metadata (defineNuxtModule meta convention).
export const moduleMetadata = {
  name: '@xid-kit/nuxt',
  configKey: 'xid',
  version: '0.0.0',
  compatibility: {
    nuxt: '>=3.0.0',
  },
} as const

// NuxtModuleSetupContext: minimal shape of the second argument Nuxt passes to setup().
type NuxtModuleSetupContext = {
  options: XidNuxtModuleOptions
  nuxt: unknown
}

// setupXidModule: module setup function. Testable independently of Nuxt's module loader.
// Registers plugin, runtimeConfig, auto-import composables, and optional server middleware.
export async function setupXidModule(
  options: XidNuxtModuleOptions,
  _context: NuxtModuleSetupContext,
): Promise<void> {
  // Dynamic import of nuxt/kit (peer dep; not bundled into this library).
  const kit = (await import('nuxt/kit')) as {
    addPlugin: (plugin: { src: string; mode?: 'client' | 'server' | 'all' }) => void
    addImports: (imports: ReadonlyArray<{ name: string; as?: string; from: string }>) => void
    addServerHandler?: (handler: { middleware: boolean; handler: string }) => void
    useNuxt?: () => { options: { runtimeConfig: { public: Record<string, unknown> } } }
  }

  // Expose publishableKey and apiUrl via runtimeConfig.public so the client plugin
  // can read them without hardcoding values in the source.
  if (kit.useNuxt) {
    const nuxt = kit.useNuxt()
    nuxt.options.runtimeConfig.public['xidApiUrl'] = options.apiUrl ?? ''
    nuxt.options.runtimeConfig.public['xidPublishableKey'] = options.publishableKey ?? ''
  }

  // Register the client-only runtime plugin.
  // The file path uses an absolute URL so Nuxt can resolve it across package boundaries.
  kit.addPlugin({
    src: new URL('./runtime/plugin.client.ts', import.meta.url).pathname,
    mode: 'client',
  })

  // Auto-import composables: consumers get useXid / useAuth / etc. without explicit imports.
  kit.addImports([
    { name: 'useXid', from: '@xid-kit/vue' },
    { name: 'useAuth', from: '@xid-kit/vue' },
    { name: 'useUser', from: '@xid-kit/vue' },
    { name: 'useOrganization', from: '@xid-kit/vue' },
    { name: 'useSession', from: '@xid-kit/vue' },
  ])
}

// defineXidModule: returns the Nuxt module definition object.
// Nuxt's module system loads the default export from this package's main entry (index.ts),
// which re-exports defineXidModule() result. The module meta configKey 'xid' maps to
// nuxt.config.ts `xid: XidNuxtModuleOptions`.
export function defineXidModule() {
  return {
    meta: moduleMetadata,
    setup: setupXidModule,
  }
}

// Default export: required by Nuxt's module loader.
// When 'modules: ["@xid-kit/nuxt"]' is set in nuxt.config.ts, Nuxt imports this file
// and calls the default export as a Nuxt module factory.
export default defineXidModule()
