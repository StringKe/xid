// social-profile.ts:Social provider 的 profile 解析(01 章 3)。
// GitHub REST profile、OIDC id_token 验签(provider JWKS,KV 缓存)、非 OIDC provider 的 userinfo。

import { importJwkForVerify, verifyJwt } from '@xid-kit/crypto'
import type { PublicJwk, VerifyKeySet } from '@xid-kit/crypto'
import { AppError } from '../lib/errors'
import { SOCIAL_JWKS_CACHE_TTL_SEC } from '../lib/ttl'
import { isPublicHttpsUrl } from '../lib/validate'
import { isDevOrTestEnvironment } from '../test-harness/dev-gate'
import { readBoundedJson } from '../sso/bounded-json'
import { HostedAuthPolicyError } from './hosted-policy'
import {
  MICROSOFT_TENANT_ISSUER_PLACEHOLDER,
  SOCIAL_PROVIDER_TIMEOUT_MS,
  isGithubEmuIssuer,
} from './social-providers'
import type { Provider, ProviderConfig, ProviderProfile, TokenResponse } from './social-providers'

const ENTRA_TENANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const USERINFO_MAX_BYTES = 64 * 1024
const GITHUB_USER_ENDPOINT = 'https://api.github.com/user'

// JWKS 响应中的 key(provider 侧,含 kid/alg/kty/use)。
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

// JWKS 拉取单点校验:只拿到 jwksUri 字符串,单独挡一次(同 assertPublicProviderEndpoints 语义)。
function assertPublicJwksUri(jwksUri: string, allowNonPublic = false): void {
  if (allowNonPublic) return
  if (!isPublicHttpsUrl(jwksUri)) {
    throw new HostedAuthPolicyError('provider_not_configured', 'invalid_request')
  }
}

// 拉 provider JWKS 并构建 VerifyKeySet(KV 缓存 TTL 1h,见 cloudflare-bindings rule)。
async function fetchProviderVerifyKeys(env: Env, jwksUri: string): Promise<VerifyKeySet> {
  assertPublicJwksUri(jwksUri, isDevOrTestEnvironment(env))
  const cacheKey = `provider_jwks:${jwksUri}`
  let raw = await env.CACHE.get(cacheKey)
  if (!raw) {
    const res = await fetch(jwksUri, { signal: AbortSignal.timeout(SOCIAL_PROVIDER_TIMEOUT_MS) })
    if (!res.ok) throw new AppError('invalid_credentials')
    raw = await res.text()
    await env.CACHE.put(cacheKey, raw, { expirationTtl: SOCIAL_JWKS_CACHE_TTL_SEC })
  }
  const jwks = JSON.parse(raw) as { keys: ProviderJwk[] }
  const usable = jwks.keys.flatMap((key) => {
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

function issuerTemplateMatches(
  provider: Provider,
  template: string,
  claims: Record<string, unknown>,
): boolean {
  if (provider !== 'microsoft' || !template.includes(MICROSOFT_TENANT_ISSUER_PLACEHOLDER)) {
    return claims['iss'] === template
  }
  const tid = claims['tid']
  if (typeof tid !== 'string' || !ENTRA_TENANT_ID.test(tid)) return false
  return claims['iss'] === template.replace(MICROSOFT_TENANT_ISSUER_PLACEHOLDER, tid)
}

type VerifyIdTokenInput = {
  env: Env
  provider: Provider
  idToken: string
  config: ProviderConfig
  expectedNonce: string
}

// 验 OIDC id_token:签名(provider JWKS)+ iss + aud(=client_id)+ exp + nonce。失败抛 invalid_credentials。
async function verifyOidcIdToken(opts: VerifyIdTokenInput): Promise<Record<string, unknown>> {
  const { env, provider, idToken, config, expectedNonce } = opts
  const isGithubEmu = provider === 'github_emu'
  if (!config.jwksUri || (!isGithubEmu && !config.issuer)) {
    throw new AppError('invalid_credentials')
  }
  const verifyKeys = await fetchProviderVerifyKeys(env, config.jwksUri)
  const verified = await verifyJwt(idToken, verifyKeys, { expectedAudience: config.clientId })
  if (!verified.ok) throw new AppError('invalid_credentials')
  const claims = verified.value.payload as Record<string, unknown>
  const issuerValid = isGithubEmu
    ? isGithubEmuIssuer(typeof claims['iss'] === 'string' ? claims['iss'] : '', config)
    : issuerTemplateMatches(provider, config.issuer ?? '', claims)
  if (!issuerValid) throw new AppError('invalid_credentials')
  // nonce 防重放:必须与发起时存入 DO 的 nonce 一致。
  if (claims['nonce'] !== expectedNonce) throw new AppError('invalid_credentials')
  return claims
}

function readClaimString(claims: Record<string, unknown>, key: string): string | null {
  const value = claims[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

type GitHubEmail = {
  email: string
  primary: true
  verified: true
}

function primaryVerifiedGitHubEmail(value: unknown): GitHubEmail | null {
  if (!Array.isArray(value)) throw new AppError('internal_error')
  for (const candidate of value) {
    if (
      candidate &&
      typeof candidate === 'object' &&
      (candidate as Record<string, unknown>)['primary'] === true &&
      (candidate as Record<string, unknown>)['verified'] === true
    ) {
      const email = (candidate as Record<string, unknown>)['email']
      if (typeof email === 'string' && email.trim().length > 0) {
        return { email: email.trim(), primary: true, verified: true }
      }
    }
  }
  return null
}

// GitHub non-OIDC:/user 提供 profile，/user/emails 是 Email 验证状态的唯一可信来源。
// 配置了 userInfoEndpoint(GitHub Enterprise Server 的 /api/v3/user)时以它为 API base。
async function fetchGitHubProfile(
  accessToken: string,
  config: ProviderConfig,
): Promise<ProviderProfile> {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'xid-server',
  }
  const userUrl = (config.userInfoEndpoint || GITHUB_USER_ENDPOINT).replace(/\/+$/, '')
  const userRes = await fetch(userUrl, {
    headers,
    signal: AbortSignal.timeout(SOCIAL_PROVIDER_TIMEOUT_MS),
  })
  if (!userRes.ok) throw new AppError('internal_error')
  const user = (await userRes.json()) as Record<string, unknown>
  const idpUserId = String(user['id'])

  const emailsRes = await fetch(`${userUrl}/emails`, {
    headers,
    signal: AbortSignal.timeout(SOCIAL_PROVIDER_TIMEOUT_MS),
  })
  if (!emailsRes.ok) throw new AppError('internal_error')
  const primaryEmail = primaryVerifiedGitHubEmail(await emailsRes.json())

  return {
    idpUserId,
    email: primaryEmail?.email ?? null,
    emailVerified: primaryEmail !== null,
    name: (user['name'] as string | null) ?? null,
    profileRaw: user,
  }
}

// 标准 OIDC id_token claims 提取(Google/Microsoft/Apple)。
function extractOidcProfile(
  claims: Record<string, unknown>,
  externalIdClaim?: string,
): ProviderProfile {
  const emailVerifiedRaw = claims['email_verified']
  const emailVerified =
    emailVerifiedRaw === true || emailVerifiedRaw === 'true' || emailVerifiedRaw === 1
  const externalIdKey = externalIdClaim ?? 'external_id'
  const externalId = readClaimString(claims, externalIdKey) ?? readClaimString(claims, 'sub')

  return {
    idpUserId: String(claims['sub']),
    email: (claims['email'] as string | null) ?? null,
    emailVerified,
    name: (claims['name'] as string | null) ?? null,
    externalId,
    profileRaw: claims,
  }
}

// 非 OIDC 自定义 provider:用 access token 读 userinfo。只有显式 email_verified === true 才算已验证,
// 未验证 email 不能参与账号合并。
async function fetchUserInfoProfile(
  accessToken: string,
  config: ProviderConfig,
): Promise<ProviderProfile> {
  if (!config.userInfoEndpoint) throw new AppError('invalid_credentials')
  let response: Response
  try {
    response = await fetch(config.userInfoEndpoint, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(SOCIAL_PROVIDER_TIMEOUT_MS),
    })
  } catch (cause) {
    throw new AppError('invalid_credentials', { cause })
  }
  if (!response.ok) throw new AppError('invalid_credentials')
  let payload: unknown
  try {
    payload = await readBoundedJson(response, USERINFO_MAX_BYTES)
  } catch (cause) {
    throw new AppError('invalid_credentials', { cause })
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new AppError('invalid_credentials')
  }
  const claims = payload as Record<string, unknown>
  const sub = readClaimString(claims, 'sub')
  if (!sub) throw new AppError('invalid_credentials')
  const externalIdKey = config.externalIdClaim ?? 'external_id'
  return {
    idpUserId: sub,
    email: readClaimString(claims, 'email'),
    emailVerified: claims['email_verified'] === true,
    name: readClaimString(claims, 'name'),
    externalId: readClaimString(claims, externalIdKey) ?? sub,
    profileRaw: claims,
  }
}

// 取 provider profile:GitHub 走 REST profile;有 id_token 走验签后的 claims;否则走 userinfo。
export async function resolveProfile(opts: {
  env: Env
  provider: Provider
  config: ProviderConfig
  tokens: TokenResponse
  nonce: string
}): Promise<ProviderProfile> {
  const { env, provider, config, tokens, nonce } = opts
  if (provider === 'github') return fetchGitHubProfile(tokens.accessToken, config)
  if (!tokens.idToken) return fetchUserInfoProfile(tokens.accessToken, config)
  const claims = await verifyOidcIdToken({
    env,
    provider,
    idToken: tokens.idToken,
    config,
    expectedNonce: nonce,
  })
  return extractOidcProfile(claims, config.externalIdClaim)
}
