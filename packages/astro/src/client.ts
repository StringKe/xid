// 多 island 共享 XidClient 单例;无参时读 integration 注入的 window.__XID_CONFIG。

import { XidClient } from '@xid-kit/core'
import type { XidClientOptions } from '@xid-kit/core'

type IslandClientOptions = XidClientOptions

declare global {
  // 仅含 client-safe 配置,不含 jwtKey / secretKey。
  // eslint-disable-next-line no-var
  var __XID_CONFIG: XidClientOptions | undefined
}

let singleton: XidClient | null = null
let singletonOptions: IslandClientOptions | null = null

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

export function getClient(options?: IslandClientOptions): XidClient {
  if (singleton) return singleton
  return initClient(options)
}

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
