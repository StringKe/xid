// social-providers.ts:Social OAuth 的 provider 集成层(从 social.ts 抽出以控制文件行数)。
// 职责:provider 配置、OIDC id_token 验签(provider JWKS,KV 缓存)、GitHub non-OIDC profile、
//   PKCE code_challenge、provider token 信封加密、code exchange、profile 解析。
// 不含路由与 account linking 逻辑(那些留在 social.ts)。见 01 章 3。

import { base64UrlEncode, envelopeEncrypt, importJwkForVerify, verifyJwt } from '@xid-kit/crypto'
import type { PublicJwk, VerifyKeySet } from '@xid-kit/crypto'
import type { SocialProviderPolicy, TenantContext } from '@xid-kit/types'
import { AppError } from '../lib/errors'
import { SOCIAL_JWKS_CACHE_TTL_SEC } from '../lib/ttl'
import { isPublicHttpsUrl } from '../lib/validate'
import { isDevOrTestEnvironment } from '../test-harness/dev-gate'
import { HostedAuthPolicyError } from './hosted-policy'

// provider 标识:内置 google/github/microsoft/apple,亦支持自定义 provider key(任意字符串)。
export type Provider = string

export type ProviderProfile = {
  idpUserId: string
  email: string | null
  emailVerified: boolean
  name: string | null
  externalId?: string | null
  profileRaw: Record<string, unknown>
}

// provider 配置:token endpoint、client_id、client_secret 等。
// 真实实现从 TenantContext 或 KV provider config 取;此处定义接口为扩展点。
export type ProviderConfig = {
  authorizationEndpoint: string
  tokenEndpoint: string
  clientId: string
  clientSecret?: string
  userInfoEndpoint?: string
  scopes: string[]
  usesPkce: boolean
  // OIDC provider 的 issuer 与 JWKS endpoint(用于验 id_token 签名;non-OIDC 如 GitHub 留空)。
  issuer?: string
  jwksUri?: string
  externalIdClaim?: string
  // 本 client 注册的 redirectAfterLogin 白名单(精确匹配,防 open redirect)。
  redirectUris?: string[]
}

export const GITHUB_EMU_ISSUER_BOUNDARIES = ['https://token.actions.githubusercontent.com'] as const

// SSRF 防护:provider 端点来自租户策略(org admin 可写,写面校验管不到所有路径),
// worker 出网 fetch / 302 前必须确认 https + 公网,防内网与云 metadata 探测。
// 抛 HostedAuthPolicyError:social.ts 统一经 auditPolicyDeniedError 记 auth.policy_denied 审计。
export function assertPublicProviderEndpoints(
  config: ProviderConfig,
  allowNonPublic = false,
): void {
  // dev/test 环境放行非公网端点(fake provider 跑在 localhost http,生产仍强制公网 https)
  if (allowNonPublic) return
  const endpoints = [
    config.authorizationEndpoint,
    config.tokenEndpoint,
    config.userInfoEndpoint,
    config.jwksUri,
  ]
  for (const endpoint of endpoints) {
    if (endpoint !== undefined && !isPublicHttpsUrl(endpoint)) {
      throw new HostedAuthPolicyError('provider_not_configured', 'invalid_request')
    }
  }
}

// JWKS 拉取单点校验:fetchProviderVerifyKeys 只拿到 jwksUri 字符串,单独挡一次(同 assertPublicProviderEndpoints 语义)。
function assertPublicJwksUri(jwksUri: string, allowNonPublic = false): void {
  if (allowNonPublic) return
  if (!isPublicHttpsUrl(jwksUri)) {
    throw new HostedAuthPolicyError('provider_not_configured', 'invalid_request')
  }
}

export function resolveGithubEmuAllowedIssuers(config: ProviderConfig): string[] {
  const allowed = new Set<string>([...GITHUB_EMU_ISSUER_BOUNDARIES])
  if (config.issuer) allowed.add(config.issuer)
  return [...allowed]
}

export function isGithubEmuIssuer(issuer: string, config?: ProviderConfig): boolean {
  if (config) return resolveGithubEmuAllowedIssuers(config).includes(issuer)
  return GITHUB_EMU_ISSUER_BOUNDARIES.includes(
    issuer as (typeof GITHUB_EMU_ISSUER_BOUNDARIES)[number],
  )
}

export type TokenResponse = {
  accessToken: string
  refreshToken: string | null
  idToken: string | null
}

// JWKS 响应中的 key(provider 侧,含 kid/alg/kty)。
type ProviderJwk = JsonWebKey & { kid?: string; alg?: string; kty?: string }

// SHA-256(codeVerifier) -> base64url(PKCE S256,01 章 3)。
export async function computeCodeChallenge(codeVerifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier))
  return base64UrlEncode(new Uint8Array(digest))
}

// 从 env.KEK(base64)解码 KEK 字节。
function kekBytes(env: Env): Uint8Array {
  const raw = atob(env.KEK)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

// 信封加密 provider token(AES-256-GCM,租户 KEK,见 01 章 3 provider token 加密)。
export async function encryptToken(env: Env, token: string): Promise<Uint8Array> {
  const blob = await envelopeEncrypt(new TextEncoder().encode(token), kekBytes(env), 1)
  // 格式:version(1byte) || iv(12) || ciphertext || tag(16)
  const total = 1 + blob.iv.byteLength + blob.ciphertext.byteLength + blob.tag.byteLength
  const out = new Uint8Array(total)
  let off = 0
  out[off++] = blob.kekVersion & 0xff
  out.set(blob.iv, off)
  off += blob.iv.byteLength
  out.set(blob.ciphertext, off)
  off += blob.ciphertext.byteLength
  out.set(blob.tag, off)
  return out
}

// 拉 provider JWKS 并构建 VerifyKeySet(KV 缓存 TTL 1h,见 cloudflare-bindings rule)。
async function fetchProviderVerifyKeys(env: Env, jwksUri: string): Promise<VerifyKeySet> {
  assertPublicJwksUri(jwksUri, isDevOrTestEnvironment(env))
  const cacheKey = `provider_jwks:${jwksUri}`
  let raw = await env.CACHE.get(cacheKey)
  if (!raw) {
    const res = await fetch(jwksUri)
    if (!res.ok) throw new AppError('invalid_credentials')
    raw = await res.text()
    await env.CACHE.put(cacheKey, raw, { expirationTtl: SOCIAL_JWKS_CACHE_TTL_SEC })
  }
  const jwks = JSON.parse(raw) as { keys: ProviderJwk[] }
  const keys = await Promise.all(
    jwks.keys
      .filter((k) => k.kid && (k.alg === 'ES256' || k.alg === 'RS256' || k.alg === 'PS256'))
      .map(async (k) => {
        const alg = k.alg as 'ES256' | 'RS256' | 'PS256'
        const jwk: PublicJwk = { ...k, kid: k.kid as string, use: 'sig', alg }
        return { kid: k.kid as string, alg, publicKey: await importJwkForVerify(jwk) }
      }),
  )
  return { keys }
}

// 验 OIDC id_token:签名(provider JWKS)+ iss + aud(=client_id)+ exp + nonce。失败抛 invalid_credentials。
async function verifyOidcIdToken(opts: {
  env: Env
  idToken: string
  config: ProviderConfig
  expectedNonce: string
}): Promise<Record<string, unknown>> {
  const { env, idToken, config, expectedNonce } = opts
  if (!config.issuer || !config.jwksUri) throw new AppError('invalid_credentials')
  const verifyKeys = await fetchProviderVerifyKeys(env, config.jwksUri)
  const verified = await verifyJwt(idToken, verifyKeys, {
    expectedIssuer: config.issuer,
    expectedAudience: config.clientId,
  })
  if (!verified.ok) throw new AppError('invalid_credentials')
  const claims = verified.value.payload as Record<string, unknown>
  // nonce 防重放:必须与发起时存入 DO 的 nonce 一致。
  if (claims['nonce'] !== expectedNonce) throw new AppError('invalid_credentials')
  return claims
}

function readClaimString(claims: Record<string, unknown>, key: string): string | null {
  const value = claims[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function providerConfigFromPolicy(env: Env, policy: SocialProviderPolicy): ProviderConfig {
  const secretRef = policy.clientSecretRef
  const envRecord = env as unknown as Record<string, unknown>
  const secretValue = secretRef ? envRecord[secretRef] : undefined
  if (secretRef && typeof secretValue !== 'string') throw new AppError('invalid_request')
  return {
    authorizationEndpoint: policy.authorizationEndpoint,
    tokenEndpoint: policy.tokenEndpoint,
    clientId: policy.clientId,
    clientSecret: typeof secretValue === 'string' ? secretValue : undefined,
    userInfoEndpoint: policy.userInfoEndpoint,
    scopes: [...policy.scopes],
    usesPkce: policy.usesPkce,
    issuer: policy.issuer,
    jwksUri: policy.jwksUri,
    externalIdClaim: policy.externalIdClaim,
    redirectUris: policy.redirectUris ? [...policy.redirectUris] : undefined,
  }
}

export function hasProviderSecret(env: Env, policy: SocialProviderPolicy): boolean {
  const secretRef = policy.clientSecretRef
  if (!secretRef) return false
  const envRecord = env as unknown as Record<string, unknown>
  return typeof envRecord[secretRef] === 'string'
}

// 获取 provider 配置:TenantContext 是唯一来源,provider secret 只通过 Workers Secret 引用读取。
export function getProviderConfig(
  env: Env,
  tenant: TenantContext,
  provider: Provider,
): ProviderConfig | null {
  const policy = tenant.policy.socialProviders?.[provider]
  return policy ? providerConfigFromPolicy(env, policy) : null
}

// GitHub non-OIDC:调 /user + /user/emails 取 profile(01 章 3 GitHub fallback)。
async function fetchGitHubProfile(accessToken: string): Promise<ProviderProfile> {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'xid-server',
  }
  const userRes = await fetch('https://api.github.com/user', { headers })
  if (!userRes.ok) throw new AppError('internal_error')
  const user = (await userRes.json()) as Record<string, unknown>
  const idpUserId = String(user['id'])

  let email: string | null = (user['email'] as string | null) ?? null
  let emailVerified = false

  if (!email) {
    const emailsRes = await fetch('https://api.github.com/user/emails', { headers })
    if (emailsRes.ok) {
      const emails = (await emailsRes.json()) as Array<{
        email: string
        primary: boolean
        verified: boolean
      }>
      const primary = emails.find((e) => e.primary && e.verified)
      if (primary) {
        email = primary.email
        emailVerified = primary.verified
      }
    }
  } else {
    emailVerified = Boolean(user['email_verified'])
  }

  return {
    idpUserId,
    email,
    emailVerified,
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

async function verifyGithubEmuIdToken(opts: {
  env: Env
  idToken: string
  config: ProviderConfig
  expectedNonce: string
}): Promise<Record<string, unknown>> {
  const { env, idToken, config, expectedNonce } = opts
  if (!config.jwksUri) throw new AppError('invalid_credentials')
  const verifyKeys = await fetchProviderVerifyKeys(env, config.jwksUri)
  const verified = await verifyJwt(idToken, verifyKeys, {
    expectedAudience: config.clientId,
  })
  if (!verified.ok) throw new AppError('invalid_credentials')
  const claims = verified.value.payload as Record<string, unknown>
  if (claims['nonce'] !== expectedNonce) throw new AppError('invalid_credentials')
  const issuer = typeof claims['iss'] === 'string' ? claims['iss'] : ''
  if (!isGithubEmuIssuer(issuer, config)) throw new AppError('invalid_credentials')
  return claims
}

// code exchange(01 章 3 step 3):POST token_endpoint,返回 access/refresh/id token。
export async function exchangeCode(opts: {
  provider: Provider
  config: ProviderConfig
  redirectUri: string
  codeVerifier: string
  code: string
  allowNonPublic?: boolean
}): Promise<TokenResponse> {
  const { config, redirectUri, codeVerifier, code } = opts
  // token endpoint 是 worker 出网 POST(client_secret 随请求体),先过公网校验再发凭证。
  assertPublicProviderEndpoints(config, opts.allowNonPublic ?? false)
  const tokenParams = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: config.clientId,
  })
  if (config.clientSecret) tokenParams.set('client_secret', config.clientSecret)
  if (config.usesPkce) tokenParams.set('code_verifier', codeVerifier)

  const tokenRes = await fetch(config.tokenEndpoint, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: tokenParams,
  })
  if (!tokenRes.ok) throw new AppError('invalid_grant')
  const data = (await tokenRes.json()) as Record<string, unknown>
  return {
    accessToken: data['access_token'] as string,
    refreshToken: (data['refresh_token'] as string | undefined) ?? null,
    idToken: (data['id_token'] as string | undefined) ?? null,
  }
}

// 取 provider profile:GitHub 走 userinfo(non-OIDC);OIDC 走验签后的 id_token claims。
export async function resolveProfile(opts: {
  env: Env
  provider: Provider
  config: ProviderConfig
  tokens: TokenResponse
  nonce: string
}): Promise<ProviderProfile> {
  const { env, provider, config, tokens, nonce } = opts
  if (provider === 'github') return fetchGitHubProfile(tokens.accessToken)
  if (tokens.idToken) {
    const claims =
      provider === 'github_emu'
        ? await verifyGithubEmuIdToken({
            env,
            idToken: tokens.idToken,
            config,
            expectedNonce: nonce,
          })
        : await verifyOidcIdToken({
            env,
            idToken: tokens.idToken,
            config,
            expectedNonce: nonce,
          })
    return extractOidcProfile(claims, config.externalIdClaim)
  }
  throw new AppError('invalid_credentials')
}
