// integration.ts: Astro integration factory.
// Injects xidMiddleware into the Astro SSR request pipeline via addMiddleware.
//
// Usage (astro.config.mjs):
//   import { xidIntegration } from '@xid-kit/astro/integration'
//   export default defineConfig({
//     integrations: [xidIntegration({ publishableKey: '...' })]
//   })
//
// The integration:
//   - Registers @xid-kit/astro/middleware as a pre-middleware (for SSR/hybrid output).
//     That module exports `onRequest` which is the Astro-required middleware entry point.
//   - Injects an inline client-side script that sets window.__XID_CONFIG for island hydration.
//     The client.ts initClient() reads this on first island mount.
//   - Passes jwtKey and other runtime options via a JSON-serialised window.__XID_CONFIG
//     (server-only fields like jwtKey should NOT be included here -- they are wired at
//     middleware creation time inside @xid-kit/astro/middleware).
//
// Note: Astro integration API is provided by the astro peer dep at runtime.
// Local type declarations avoid a hard bundle dependency on the full astro package.

import type { XidIntegrationOptions } from './types'

// Minimal Astro integration type contract (peer dep).
type AstroIntegrationHooks = {
  'astro:config:setup'?: (params: {
    addMiddleware: (params: { entrypoint: string; order: 'pre' | 'post' }) => void
    injectScript: (stage: string, content: string) => void
    config: { output?: string }
  }) => void | Promise<void>
}

type AstroIntegration = {
  name: string
  hooks: AstroIntegrationHooks
}

// xidIntegration: injects @xid-kit/astro's onRequest server middleware and a
// client-side config script into the Astro build pipeline.
//
// The middleware module at @xid-kit/astro/middleware exports `onRequest`
// (Astro's required named export for middleware entrypoints) which wraps
// createXidMiddleware. Runtime options (jwtKey, issuer, etc.) must be set
// by the consumer in their own src/middleware.ts if they need custom configuration.
// This integration wires the default middleware for zero-config SSR auth.
export function xidIntegration(options: XidIntegrationOptions): AstroIntegration {
  return {
    name: '@xid-kit/astro',
    hooks: {
      'astro:config:setup'({ addMiddleware, injectScript, config }) {
        // Only SSR (server / hybrid) output has a middleware runtime.
        const output = config.output ?? 'static'
        if (output === 'static') {
          return
        }

        // Register the middleware entrypoint. The module at this path must export
        // `onRequest` -- that named export is what Astro looks for in middleware files.
        addMiddleware({
          entrypoint: '@xid-kit/astro/middleware',
          order: 'pre',
        })

        // Inject client-side config for island components.
        // Only publishableKey is safe to expose on the client; jwtKey is server-only.
        if (options.publishableKey) {
          const config = JSON.stringify({ publishableKey: options.publishableKey })
          injectScript('head-inline', `window.__XID_CONFIG=${config};`)
        }
      },
    },
  }
}
