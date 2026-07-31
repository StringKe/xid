// integration.ts: Astro integration factory.
// Injects configured xidMiddleware into the Astro SSR request pipeline via addMiddleware.
//
// Usage (astro.config.mjs):
//   import { xidIntegration } from '@xid-kit/astro/integration'
//   export default defineConfig({
//     integrations: [xidIntegration({
//       browser: { mode: 'oidc', issuer, clientId, redirectUri },
//       jwtKey: jwks,
//     })]
//   })
//
// The integration:
//   - Registers @xid-kit/astro/integration-middleware as a pre-middleware for SSR/hybrid output.
//   - Supplies serializable server options through a Vite virtual module.
//   - Injects an inline client-side script that sets window.__XID_CONFIG for island hydration.
//     The client.ts initClient() reads this on first island mount.
//
// Security: only the explicit browser OIDC/same-origin configuration enters the browser script.
// jwtKey remains in the server bundle. Imported CryptoKey, fetcher, tokenCache, now and AbortSignal
// are intentionally unsupported because they cannot cross the build-time serialization boundary.
//
// Note: Astro integration API is provided by the astro peer dep at runtime.
// Local type declarations avoid a hard bundle dependency on the full astro package.

import type { XidMiddlewareOptions } from './types'
import type { XidIntegrationOptions } from './types'

const VIRTUAL_CONFIG_ID = 'virtual:@xid-kit/astro:config'
const RESOLVED_VIRTUAL_CONFIG_ID = `\0${VIRTUAL_CONFIG_ID}`

type VitePlugin = {
  name: string
  resolveId: (id: string) => string | undefined
  load: (id: string) => string | undefined
}

// Minimal Astro integration type contract (peer dep).
type AstroIntegrationHooks = {
  'astro:config:setup'?: (params: {
    addMiddleware: (params: { entrypoint: string; order: 'pre' | 'post' }) => void
    injectScript: (stage: string, content: string) => void
    updateConfig: (config: { vite: { plugins: VitePlugin[] } }) => void
    config: { output?: string }
  }) => void | Promise<void>
}

type AstroIntegration = {
  name: string
  hooks: AstroIntegrationHooks
}

type SerializableMiddlewareOptions = Omit<
  XidMiddlewareOptions,
  'jwtKey' | 'sessionTokenExchange'
> & {
  jwtKey: NonNullable<XidIntegrationOptions['jwtKey']>
  sessionTokenExchange?: NonNullable<XidIntegrationOptions['sessionTokenExchange']>
}

function hasServerOptions(options: XidIntegrationOptions): boolean {
  return (
    options.jwtKey !== undefined ||
    options.issuer !== undefined ||
    options.authorizedParties !== undefined ||
    options.jwtCookieName !== undefined ||
    options.sessionTokenExchange !== undefined ||
    options.protectedRoutes !== undefined ||
    options.signInUrl !== undefined ||
    options.publicRoutes !== undefined
  )
}

function assertSerializableOptions(options: XidIntegrationOptions): void {
  const jwtKey = options.jwtKey as Record<string, unknown> | undefined
  if (jwtKey && 'publicKey' in jwtKey) {
    throw new TypeError(
      'xidIntegration.jwtKey must be a serializable public JWK or JWKS, not an imported CryptoKey',
    )
  }

  const exchange = options.sessionTokenExchange as Record<string, unknown> | undefined
  if (exchange && ('fetcher' in exchange || 'signal' in exchange)) {
    throw new TypeError(
      'xidIntegration.sessionTokenExchange supports endpoint only; configure fetcher or signal in createXidMiddleware',
    )
  }

  const browser = options.browser as Record<string, unknown> | undefined
  if (
    browser &&
    ('fetcher' in browser || 'tokenCache' in browser || 'now' in browser || 'secretKey' in browser)
  ) {
    throw new TypeError(
      'xidIntegration.browser supports serializable public client options only; configure runtime hooks in initClient',
    )
  }
}

function middlewareOptions(options: XidIntegrationOptions): SerializableMiddlewareOptions {
  if (!options.jwtKey) {
    throw new TypeError('xidIntegration requires jwtKey when configuring server authentication')
  }

  return {
    jwtKey: options.jwtKey,
    ...(options.issuer ? { issuer: options.issuer } : {}),
    ...(options.authorizedParties ? { authorizedParties: options.authorizedParties } : {}),
    ...(options.jwtCookieName ? { jwtCookieName: options.jwtCookieName } : {}),
    ...(options.sessionTokenExchange ? { sessionTokenExchange: options.sessionTokenExchange } : {}),
    ...(options.protectedRoutes ? { protectedRoutes: options.protectedRoutes } : {}),
    ...(options.signInUrl ? { signInUrl: options.signInUrl } : {}),
    ...(options.publicRoutes ? { publicRoutes: options.publicRoutes } : {}),
  }
}

function configPlugin(options: SerializableMiddlewareOptions): VitePlugin {
  const source = `export default ${JSON.stringify(options)};`
  return {
    name: '@xid-kit/astro:config',
    resolveId(id) {
      return id === VIRTUAL_CONFIG_ID ? RESOLVED_VIRTUAL_CONFIG_ID : undefined
    },
    load(id) {
      return id === RESOLVED_VIRTUAL_CONFIG_ID ? source : undefined
    },
  }
}

// xidIntegration: injects a configured server middleware and a client-side config script.
export function xidIntegration(options: XidIntegrationOptions): AstroIntegration {
  assertSerializableOptions(options)

  return {
    name: '@xid-kit/astro',
    hooks: {
      'astro:config:setup'({ addMiddleware, injectScript, updateConfig, config }) {
        if (options.browser) {
          const browserConfig = JSON.stringify(options.browser)
          injectScript('head-inline', `window.__XID_CONFIG=${browserConfig};`)
        }

        const output = config.output ?? 'static'
        if (output === 'static') {
          if (hasServerOptions(options)) {
            throw new TypeError(
              'xidIntegration server authentication requires Astro output "server" or "hybrid"',
            )
          }
          return
        }

        if (!hasServerOptions(options)) {
          return
        }

        const serverOptions = middlewareOptions(options)
        updateConfig({
          vite: {
            plugins: [configPlugin(serverOptions)],
          },
        })
        addMiddleware({
          entrypoint: '@xid-kit/astro/integration-middleware',
          order: 'pre',
        })
      },
    },
  }
}
