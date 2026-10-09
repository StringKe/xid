// Social provider JWKS:KV 缓存 provider_jwks:{jwks_uri}(TTL 1h)。id_token 的 kid 不在缓存里时
// 绕过缓存重拉一次并覆盖缓存,同一 jwks_uri 的强制刷新受最短间隔限制,防止伪造 kid 打满上游。

import { importJwkForVerify, verifyJwt } from '@xid-kit/crypto'
import type { PublicJwk, VerifiedJwt, VerifyKeySet } from '@xid-kit/crypto'
import { AppError } from '../lib/errors'
import {
  PROVIDER_JWKS_FORCED_REFRESH_MIN_INTERVAL_SEC,
  SOCIAL_JWKS_CACHE_TTL_SEC,
} from '../lib/ttl'
import { isPublicHttpsUrl } from '../lib/validate'
import { isDevOrTestEnvironment } from '../test-harness/dev-gate'
import { HostedAuthPolicyError } from './hosted-policy-core'
import { SOCIAL_PROVIDER_TIMEOUT_MS } from './social-providers'

type ProviderJwk = JsonWebKey & { kid?: string; alg?: string; kty?: string; use?: string }

type VerifyAlg = 'ES256' | 'RS256' | 'PS256'

// Entra 等 provider 的 JWKS key 不带 alg:按 kty/crv 推断。verifyJwt 仍要求 token header alg
// 与 key alg 一致,推断不会放开 none / HS* 或算法混淆。
function providerKeyAlg(key: ProviderJwk): VerifyAlg | null {
  if (key.use !== undefined && key.use !== 'sig') return null
  if (key.alg !== undefined) {
    return key.alg === 'ES256' || key.alg === 'RS256' || key.alg === 'PS256' ? key.alg : null
  }
  if (key.kty === 'RSA') return 'RS256'
  if (key.kty === 'EC' && key.crv === 'P-256') return 'ES256'
  return null
}

function assertPublicJwksUri(jwksUri: string, allowNonPublic: boolean): void {
  if (allowNonPublic) return
  if (!isPublicHttpsUrl(jwksUri)) {
    throw new HostedAuthPolicyError('provider_not_configured', 'invalid_request')
  }
}

function jwksCacheKey(jwksUri: string): string {
  return `provider_jwks:${jwksUri}`
}

function jwksRefreshMarkerKey(jwksUri: string): string {
  return `provider_jwks_refresh:${jwksUri}`
}

async function downloadJwks(env: Env, jwksUri: string): Promise<string> {
  const res = await fetch(jwksUri, { signal: AbortSignal.timeout(SOCIAL_PROVIDER_TIMEOUT_MS) })
  if (!res.ok) throw new AppError('invalid_credentials')
  const raw = await res.text()
  await env.CACHE.put(jwksCacheKey(jwksUri), raw, { expirationTtl: SOCIAL_JWKS_CACHE_TTL_SEC })
  return raw
}

async function toVerifyKeySet(raw: string): Promise<VerifyKeySet> {
  let jwks: { keys?: unknown }
  try {
    jwks = JSON.parse(raw) as { keys?: unknown }
  } catch (cause) {
    throw new AppError('invalid_credentials', { cause })
  }
  if (!Array.isArray(jwks.keys)) throw new AppError('invalid_credentials')
  const usable = (jwks.keys as ProviderJwk[]).flatMap((key) => {
    const alg = providerKeyAlg(key)
    return key.kid && alg ? [{ key, kid: key.kid, alg }] : []
  })
  const keys = await Promise.all(
    usable.map(async ({ key, kid, alg }) => {
      const jwk: PublicJwk = { ...key, kid, use: 'sig', alg }
      return { kid, alg, publicKey: await importJwkForVerify(jwk) }
    }),
  )
  return { keys }
}

// 返回 true 表示本次获准强制刷新;限速窗口内已刷新过则返回 false。
async function claimForcedRefresh(env: Env, jwksUri: string): Promise<boolean> {
  const marker = jwksRefreshMarkerKey(jwksUri)
  if (await env.CACHE.get(marker)) return false
  await env.CACHE.put(marker, String(Date.now()), {
    expirationTtl: PROVIDER_JWKS_FORCED_REFRESH_MIN_INTERVAL_SEC,
  })
  return true
}

// 用 provider JWKS 验 id_token 签名、exp 和 aud;只有 unknown_kid 会触发一次受限速的强制刷新。
export async function verifyWithProviderJwks(input: {
  env: Env
  jwksUri: string
  idToken: string
  audience: string
}): Promise<VerifiedJwt> {
  const { env, jwksUri, idToken, audience } = input
  assertPublicJwksUri(jwksUri, isDevOrTestEnvironment(env))
  const cached = await env.CACHE.get(jwksCacheKey(jwksUri))
  const raw = cached ?? (await downloadJwks(env, jwksUri))
  let verified = await verifyJwt(idToken, await toVerifyKeySet(raw), {
    expectedAudience: audience,
  })
  if (!verified.ok && verified.error.reason === 'unknown_kid' && cached !== null) {
    if (await claimForcedRefresh(env, jwksUri)) {
      const refreshed = await downloadJwks(env, jwksUri)
      verified = await verifyJwt(idToken, await toVerifyKeySet(refreshed), {
        expectedAudience: audience,
      })
    }
  }
  if (!verified.ok) throw new AppError('invalid_credentials')
  return verified.value
}
