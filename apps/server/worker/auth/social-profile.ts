// social-profile.ts:Social provider 的 profile 解析(01 章 3)。
// GitHub REST profile、OIDC id_token 验签(provider JWKS 见 social-jwks.ts)、非 OIDC provider 的 userinfo。

import { AppError } from '../lib/errors'
import { readBoundedJson } from '../sso/bounded-json'
import { verifyWithProviderJwks } from './social-jwks'
import {
  MICROSOFT_TENANT_ISSUER_PLACEHOLDER,
  SOCIAL_PROVIDER_TIMEOUT_MS,
  isGithubEmuIssuer,
} from './social-providers'
import type { Provider, ProviderConfig, ProviderProfile, TokenResponse } from './social-providers'

const ENTRA_TENANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const USERINFO_MAX_BYTES = 64 * 1024
const GITHUB_USER_ENDPOINT = 'https://api.github.com/user'

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
  const verified = await verifyWithProviderJwks({
    env,
    jwksUri: config.jwksUri,
    idToken,
    audience: config.clientId,
  })
  const claims = verified.payload as Record<string, unknown>
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

function primaryVerifiedGitHubEmail(value: unknown): string | null {
  if (!Array.isArray(value)) throw new AppError('internal_error')
  for (const candidate of value) {
    if (
      candidate &&
      typeof candidate === 'object' &&
      (candidate as Record<string, unknown>)['primary'] === true &&
      (candidate as Record<string, unknown>)['verified'] === true
    ) {
      const email = (candidate as Record<string, unknown>)['email']
      if (typeof email === 'string' && email.trim().length > 0) return email
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
    email: primaryEmail,
    emailVerified: primaryEmail !== null,
    name: (user['name'] as string | null) ?? null,
    profileRaw: user,
  }
}

// Microsoft 不发 email_verified,email 声明可由租户管理员随意设置。只有 xms_edov 可选声明为 true
// (邮箱域名属于用户所在 Entra 租户且已验证)才算可信。
function oidcEmailVerified(provider: Provider, claims: Record<string, unknown>): boolean {
  if (provider === 'microsoft') return claims['xms_edov'] === true
  const raw = claims['email_verified']
  return raw === true || raw === 'true' || raw === 1
}

// 标准 OIDC id_token claims 提取(Google/Microsoft/Apple)。
function extractOidcProfile(
  provider: Provider,
  claims: Record<string, unknown>,
  externalIdClaim?: string,
): ProviderProfile {
  const externalIdKey = externalIdClaim ?? 'external_id'
  const externalId = readClaimString(claims, externalIdKey) ?? readClaimString(claims, 'sub')

  return {
    idpUserId: String(claims['sub']),
    email: readClaimString(claims, 'email'),
    emailVerified: oidcEmailVerified(provider, claims),
    name: readClaimString(claims, 'name'),
    givenName: readClaimString(claims, 'given_name'),
    familyName: readClaimString(claims, 'family_name'),
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
    givenName: readClaimString(claims, 'given_name'),
    familyName: readClaimString(claims, 'family_name'),
    externalId: readClaimString(claims, externalIdKey) ?? sub,
    profileRaw: claims,
  }
}

// 与其他登录方式一致:trim + 小写后再比较和存储,空串视为没有 email。
function normalizeProfileEmail(profile: ProviderProfile): ProviderProfile {
  const email = profile.email?.trim().toLowerCase() || null
  return { ...profile, email, emailVerified: email !== null && profile.emailVerified }
}

async function resolveRawProfile(opts: {
  env: Env
  provider: Provider
  config: ProviderConfig
  tokens: TokenResponse
  nonce: string
}): Promise<ProviderProfile> {
  const { env, provider, config, tokens, nonce } = opts
  if (provider === 'github') return fetchGitHubProfile(tokens.accessToken, config)
  if (!tokens.idToken) {
    if (config.issuer || config.jwksUri || provider === 'github_emu') {
      throw new AppError('invalid_credentials')
    }
    return fetchUserInfoProfile(tokens.accessToken, config)
  }
  const claims = await verifyOidcIdToken({
    env,
    provider,
    idToken: tokens.idToken,
    config,
    expectedNonce: nonce,
  })
  return extractOidcProfile(provider, claims, config.externalIdClaim)
}

// 取 provider profile:GitHub 走 REST profile;OIDC provider 必须返回 id_token 并验签;
// 只有未配置 issuer / JWKS 的非 OIDC provider 走 userinfo,避免 OIDC 配置被降级跳过 nonce 绑定。
export async function resolveProfile(opts: {
  env: Env
  provider: Provider
  config: ProviderConfig
  tokens: TokenResponse
  nonce: string
}): Promise<ProviderProfile> {
  return normalizeProfileEmail(await resolveRawProfile(opts))
}
