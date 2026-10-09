// 企业 OIDC 上游 JWKS 的 KV 缓存(provider_jwks:{jwks_uri})与未知 kid 时的限速强制刷新。

import type { VerifyKeySet } from '@xid-kit/crypto'
import {
  PROVIDER_JWKS_FORCED_REFRESH_MIN_INTERVAL_SEC,
  SSO_OIDC_JWKS_CACHE_TTL_SEC,
} from '../lib/ttl'
import { buildProviderKeySet, fetchProviderJwks, parseProviderJwks } from './oidc-upstream'
import type { JwksResponse } from './oidc-upstream'

// forceRefresh=true 时绕过缓存回源;刷新间隔内已刷新过返回 null,调用方按原失败处理。
export type ProviderKeyLoader = (forceRefresh: boolean) => Promise<VerifyKeySet | null>

type ProviderKeyLoaderInput = {
  cache: KVNamespace
  jwksUri: string
  permitsLoopbackHttp: boolean
}

function cacheKey(jwksUri: string): string {
  return `provider_jwks:${jwksUri}`
}

function refreshMarkerKey(jwksUri: string): string {
  return `provider_jwks_refresh:${jwksUri}`
}

async function readCachedJwks(cache: KVNamespace, jwksUri: string): Promise<JwksResponse | null> {
  const raw = await cache.get(cacheKey(jwksUri))
  if (raw === null) return null
  try {
    return parseProviderJwks(JSON.parse(raw))
  } catch (cause) {
    // 缓存内容损坏时当作未命中回源,回源结果会覆盖它。
    console.warn('provider_jwks_cache_invalid', { jwksUri, cause: String(cause) })
    return null
  }
}

// 任何一次回源都记入最短刷新间隔,冷缓存回源后紧接的未知 kid 不会再回源一次。
async function fetchAndCache(input: ProviderKeyLoaderInput): Promise<JwksResponse> {
  await input.cache.put(refreshMarkerKey(input.jwksUri), String(Date.now()), {
    expirationTtl: PROVIDER_JWKS_FORCED_REFRESH_MIN_INTERVAL_SEC,
  })
  const jwks = await fetchProviderJwks(input.jwksUri, input.permitsLoopbackHttp)
  await input.cache.put(cacheKey(input.jwksUri), JSON.stringify(jwks), {
    expirationTtl: SSO_OIDC_JWKS_CACHE_TTL_SEC,
  })
  return jwks
}

export function createProviderKeyLoader(input: ProviderKeyLoaderInput): ProviderKeyLoader {
  return async (forceRefresh) => {
    if (forceRefresh) {
      if ((await input.cache.get(refreshMarkerKey(input.jwksUri))) !== null) return null
      return buildProviderKeySet(await fetchAndCache(input))
    }
    const cached = await readCachedJwks(input.cache, input.jwksUri)
    return buildProviderKeySet(cached ?? (await fetchAndCache(input)))
  }
}
