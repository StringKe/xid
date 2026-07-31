// client.ts: island client helper.
// getClient(): returns the XidClient singleton for Astro islands in the browser.
// Singleton logic: multiple islands on the same page share one XidClient instance,
// avoiding duplicate load() calls.
//
// Serializable browser options are read from window.__XID_CONFIG (set by xidIntegration's
// injectScript) when initClient() is called without explicit options.

import { XidClient } from '@xid-kit/core'
import type { XidClientOptions } from '@xid-kit/core'

type IslandClientOptions = XidClientOptions

declare global {
  // Injected by xidIntegration injectScript('head-inline', ...).
  // Contains only client-safe config (no jwtKey / secretKey).
  // eslint-disable-next-line no-var
  var __XID_CONFIG: XidClientOptions | undefined
}

let singleton: XidClient | null = null
let singletonOptions: IslandClientOptions | null = null

// initClient: initialises the singleton (usually called by XidProvider island or inline script).
// Repeated calls with matching options are no-ops; changed options rebuild the instance.
export function initClient(options?: IslandClientOptions): XidClient {
  const resolved: IslandClientOptions = options ??
    globalThis.__XID_CONFIG ?? { mode: 'same-origin' }

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
  if (a.mode === 'oidc') {
    return (
      b.mode === 'oidc' &&
      a.issuer === b.issuer &&
      a.clientId === b.clientId &&
      a.redirectUri === b.redirectUri &&
      stringArraysMatch(a.scopes, b.scopes) &&
      a.postLogoutRedirectUri === b.postLogoutRedirectUri &&
      a.tokenCache === b.tokenCache &&
      a.fetcher === b.fetcher &&
      a.now === b.now
    )
  }
  if (b.mode === 'oidc') return false
  return (
    a.apiUrl === b.apiUrl &&
    a.secretKey === b.secretKey &&
    a.fetcher === b.fetcher &&
    a.now === b.now
  )
}

function stringArraysMatch(a: readonly string[] | undefined, b: readonly string[] | undefined) {
  if (a === b) return true
  if (!a || !b || a.length !== b.length) return false
  return a.every((value, index) => value === b[index])
}
