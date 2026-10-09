// social-providers.ts:Social OAuth 的 provider 集成层。
// 职责:provider 配置与保存期校验、Workers Secret 引用、端点 SSRF 校验、provider token 信封加密、
//   code exchange。profile 解析见 social-profile.ts,路由见 social.ts,account linking 见 social-linking.ts。

import { envelopeEncrypt } from '@xid-kit/crypto'
import type { SocialProviderPolicy, TenantContext } from '@xid-kit/types'
import * as v from 'valibot'
import { AppError } from '../lib/errors'
import { isPublicHttpsUrl } from '../lib/validate'
import { readBoundedJson } from '../sso/bounded-json'
import { HostedAuthPolicyError } from './hosted-policy-core'

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

// provider 配置:token endpoint、client_id、client_secret 等,来自 TenantContext 的 socialProviders 策略。
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
}

export type TokenResponse = {
  accessToken: string
  refreshToken: string | null
  idToken: string | null
}

// Entra 多租户 issuer 模板:iss 随登录用户所在 Entra 租户变化,验签后用 tid 代入再精确比较。
export const MICROSOFT_TENANT_ISSUER_PLACEHOLDER = '{tenantid}'

export const GITHUB_EMU_ISSUER_BOUNDARIES = ['https://token.actions.githubusercontent.com'] as const

export const BUILT_IN_SOCIAL_PROVIDER_SECRET_BINDINGS = {
  google: 'GOOGLE_CLIENT_SECRET',
  github: 'GITHUB_CLIENT_SECRET',
  microsoft: 'MICROSOFT_CLIENT_SECRET',
  apple: 'APPLE_CLIENT_SECRET',
  github_emu: 'GITHUB_EMU_CLIENT_SECRET',
} as const

export const SOCIAL_PROVIDER_TIMEOUT_MS = 5_000
const TOKEN_RESPONSE_MAX_BYTES = 64 * 1024

const CUSTOM_SOCIAL_SECRET_BINDING = /^SOCIAL_[A-Z0-9_]+_CLIENT_SECRET$/
const PROVIDER_KEY = /^[a-z0-9_-]+$/

function operatorSocialProviderBindings(env: Env): Readonly<Record<string, string>> {
  const raw = env.SOCIAL_PROVIDER_SECRET_BINDINGS
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, string] =>
          PROVIDER_KEY.test(entry[0]) &&
          typeof entry[1] === 'string' &&
          CUSTOM_SOCIAL_SECRET_BINDING.test(entry[1]),
      ),
    )
  } catch {
    return {}
  }
}

// Secret binding names are deployment-controlled. Tenant policy can select a provider but cannot
// turn an arbitrary Env key into a credential oracle.
export function socialProviderSecretBinding(env: Env, provider: string): string | undefined {
  const builtIn =
    BUILT_IN_SOCIAL_PROVIDER_SECRET_BINDINGS[
      provider as keyof typeof BUILT_IN_SOCIAL_PROVIDER_SECRET_BINDINGS
    ]
  return builtIn ?? operatorSocialProviderBindings(env)[provider]
}

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

function providerConfigFromPolicy(
  env: Env,
  provider: string,
  policy: SocialProviderPolicy,
): ProviderConfig {
  const secretRef = socialProviderSecretBinding(env, provider)
  const envRecord = env as unknown as Record<string, unknown>
  const secretValue = secretRef ? envRecord[secretRef] : undefined
  if (!secretRef || typeof secretValue !== 'string') throw new AppError('invalid_request')
  return {
    authorizationEndpoint: policy.authorizationEndpoint,
    tokenEndpoint: policy.tokenEndpoint,
    clientId: policy.clientId,
    clientSecret: secretValue,
    userInfoEndpoint: policy.userInfoEndpoint,
    scopes: [...policy.scopes],
    usesPkce: policy.usesPkce,
    issuer: policy.issuer,
    jwksUri: policy.jwksUri,
    externalIdClaim: policy.externalIdClaim,
  }
}

export type SocialProviderConfigField =
  | 'authorizationEndpoint'
  | 'tokenEndpoint'
  | 'userInfoEndpoint'
  | 'issuer'
  | 'jwksUri'

// 保存期校验:一个启用的 provider 必须有可用的 profile 来源(GitHub REST、id_token 验签或 userinfo),
// 且不得保存会被精确匹配的占位串;唯一允许的占位是 Microsoft issuer 的 {tenantid}。
export function socialProviderConfigIssue(
  provider: string,
  policy: SocialProviderPolicy,
): SocialProviderConfigField | null {
  const fields: readonly SocialProviderConfigField[] = [
    'authorizationEndpoint',
    'tokenEndpoint',
    'userInfoEndpoint',
    'jwksUri',
  ]
  for (const field of fields) {
    if (policy[field]?.includes('{')) return field
  }
  const issuer = policy.issuer ?? ''
  const issuerWithoutTemplate =
    provider === 'microsoft' ? issuer.replace(MICROSOFT_TENANT_ISSUER_PLACEHOLDER, '') : issuer
  if (issuerWithoutTemplate.includes('{')) return 'issuer'
  if (!policy.enabled || provider === 'github') return null
  const hasIssuer = issuer !== ''
  const hasJwks = (policy.jwksUri ?? '') !== ''
  if (hasIssuer !== hasJwks) return hasIssuer ? 'jwksUri' : 'issuer'
  if (!hasIssuer && (policy.userInfoEndpoint ?? '') === '') return 'issuer'
  return null
}

export function hasProviderSecret(
  env: Env,
  _policy: SocialProviderPolicy,
  provider: string,
): boolean {
  const secretRef = socialProviderSecretBinding(env, provider)
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
  return policy ? providerConfigFromPolicy(env, provider, policy) : null
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
    signal: AbortSignal.timeout(SOCIAL_PROVIDER_TIMEOUT_MS),
  })
  if (!tokenRes.ok) throw new AppError('invalid_grant')
  return parseTokenResponse(tokenRes)
}

const tokenResponseSchema = v.looseObject({
  access_token: v.pipe(v.string(), v.minLength(1)),
  refresh_token: v.nullish(v.string()),
  id_token: v.nullish(v.string()),
  error: v.nullish(v.never()),
})

// GitHub 等 provider 在 200 响应里返回 { error },缺 access_token 或带 error 都按 code 无效处理。
async function parseTokenResponse(response: Response): Promise<TokenResponse> {
  let payload: unknown
  try {
    payload = await readBoundedJson(response, TOKEN_RESPONSE_MAX_BYTES)
  } catch (cause) {
    throw new AppError('invalid_grant', { cause })
  }
  const parsed = v.safeParse(tokenResponseSchema, payload)
  if (!parsed.success) throw new AppError('invalid_grant')
  return {
    accessToken: parsed.output.access_token,
    refreshToken: parsed.output.refresh_token || null,
    idToken: parsed.output.id_token || null,
  }
}
