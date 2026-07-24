// client.ts: island client helper.
// getClient(): returns the XidClient singleton for Astro islands in the browser.
// Singleton logic: multiple islands on the same page share one XidClient instance,
// avoiding duplicate load() calls.
//
// publishableKey is read from window.__XID_CONFIG (set by xidIntegration's injectScript)
// when initClient() is called without explicit options. This bridges the integration's
// server-side config to the browser-side island hydration.

import { XidClient } from '@xid-kit/core'
import type { XidClientOptions } from '@xid-kit/core'

type XidBrowserConfig = {
  publishableKey?: string
}

type IslandClientOptions = XidClientOptions & {
  // Client-visible publishable key (pk_live_xxx / pk_test_xxx).
  publishableKey?: string
}

declare global {
  // Injected by xidIntegration injectScript('head-inline', ...).
  // Contains only client-safe config (no jwtKey / secretKey).
  // eslint-disable-next-line no-var
  var __XID_CONFIG: XidBrowserConfig | undefined
}

let singleton: XidClient | null = null
let singletonOptions: IslandClientOptions | null = null

// initClient: initialises the singleton (usually called by XidProvider island or inline script).
// Repeated calls with matching options are no-ops; changed options rebuild the instance.
export function initClient(options?: IslandClientOptions): XidClient {
  // Read publishableKey from window.__XID_CONFIG when not supplied explicitly.
  const resolved: IslandClientOptions = {
    ...(typeof globalThis.__XID_CONFIG?.publishableKey === 'string'
      ? { publishableKey: globalThis.__XID_CONFIG.publishableKey }
      : {}),
    ...options,
  }

  if (singleton && singletonOptions && optionsMatch(singletonOptions, resolved)) {
    return singleton
  }
  singleton = new XidClient(resolved)
  singletonOptions = resolved
  return singleton
}

// getClient: returns the current singleton, creating a default one if not yet initialised.
export function getClient(options?: IslandClientOptions): XidClient {
  if (singleton) return singleton
  return initClient(options)
}

// resetClient: test utility; resets the singleton so each test runs in isolation.
export function resetClient(): void {
  singleton = null
  singletonOptions = null
}

function optionsMatch(a: IslandClientOptions, b: IslandClientOptions): boolean {
  return a.apiUrl === b.apiUrl && a.publishableKey === b.publishableKey
}
