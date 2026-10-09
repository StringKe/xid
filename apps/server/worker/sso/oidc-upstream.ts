// 企业 OIDC RP 的上游调用:discovery、JWKS、token endpoint 换码。
// 只接受公网 HTTPS(dev/test 允许 loopback HTTP fixture),响应体有大小上限,超时 5s。

import { importJwkForVerify } from '@xid-kit/crypto'
import type { PublicJwk, VerifyKeySet } from '@xid-kit/crypto'
import type { SigningAlg } from '@xid-kit/types'
import * as v from 'valibot'
import { AppError } from '../lib/errors'
import { isLoopbackHttpUrl, isPublicHttpsUrl } from '../lib/validate'
import { readBoundedJson } from './bounded-json'

// OIDC Discovery 响应(最小所需字段)。
export type OidcDiscovery = v.InferOutput<typeof oidcDiscoverySchema>

const OIDC_UPSTREAM_TIMEOUT_MS = 5_000
const OIDC_DISCOVERY_MAX_BYTES = 64 * 1024
const OIDC_TOKEN_MAX_BYTES = 64 * 1024
const OIDC_JWKS_MAX_BYTES = 512 * 1024

const oidcDiscoverySchema = v.object({
  authorization_endpoint: v.pipe(v.string(), v.url()),
  token_endpoint: v.pipe(v.string(), v.url()),
  jwks_uri: v.pipe(v.string(), v.url()),
  issuer: v.pipe(v.string(), v.url()),
  token_endpoint_auth_methods_supported: v.optional(v.array(v.string())),
})

const oidcTokenResponseSchema = v.object({
  id_token: v.pipe(v.string(), v.minLength(1)),
  access_token: v.pipe(v.string(), v.minLength(1)),
  token_type: v.pipe(v.string(), v.minLength(1)),
  expires_in: v.optional(v.number()),
})

const oidcTokenErrorSchema = v.object({ error: v.pipe(v.string(), v.maxLength(64)) })

const oidcJwksSchema = v.object({
  keys: v.pipe(v.array(v.record(v.string(), v.unknown())), v.minLength(1), v.maxLength(64)),
})

async function fetchOidcJson(
  url: string,
  init: RequestInit,
  maxBytes: number,
  failure: string,
): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(url, {
      ...init,
      redirect: 'manual',
      signal: AbortSignal.timeout(OIDC_UPSTREAM_TIMEOUT_MS),
    })
  } catch (cause) {
    throw new AppError('internal_error', { cause, longMessage: failure })
  }
  if (!response.ok) throw new AppError('internal_error', { longMessage: failure })
  try {
    return await readBoundedJson(response, maxBytes)
  } catch (cause) {
    throw new AppError('internal_error', { cause, longMessage: failure })
  }
}

function isTrustedUpstreamUrl(value: string, permitsLoopbackHttp: boolean): boolean {
  return isPublicHttpsUrl(value) || (permitsLoopbackHttp && isLoopbackHttpUrl(value))
}

function assertDiscoveryTrust(
  discoveryUrl: string,
  discovery: OidcDiscovery,
  permitsLoopbackHttp: boolean,
): void {
  const configured = new URL(discoveryUrl)
  const issuer = new URL(discovery.issuer)
  if (
    configured.username ||
    configured.password ||
    issuer.username ||
    issuer.password ||
    issuer.search ||
    issuer.hash ||
    configured.origin !== issuer.origin ||
    !isTrustedUpstreamUrl(discovery.issuer, permitsLoopbackHttp)
  ) {
    throw new AppError('internal_error', { longMessage: 'OIDC discovery trust mismatch' })
  }
  for (const endpoint of [
    discovery.authorization_endpoint,
    discovery.token_endpoint,
    discovery.jwks_uri,
  ]) {
    const parsed = new URL(endpoint)
    if (
      parsed.username ||
      parsed.password ||
      parsed.origin !== issuer.origin ||
      !isTrustedUpstreamUrl(endpoint, permitsLoopbackHttp)
    ) {
      throw new AppError('internal_error', { longMessage: 'OIDC discovery endpoint untrusted' })
    }
  }
}

// 拉取 provider OIDC Discovery 文档。
export async function fetchDiscovery(
  discoveryUrl: string,
  permitsLoopbackHttp: boolean,
): Promise<OidcDiscovery> {
  if (!isTrustedUpstreamUrl(discoveryUrl, permitsLoopbackHttp)) {
    throw new AppError('internal_error', { longMessage: 'OIDC discovery URL is not public HTTPS' })
  }
  const fetchInit =
    permitsLoopbackHttp && isLoopbackHttpUrl(discoveryUrl)
      ? {}
      : ({ cf: { cacheEverything: true, cacheTtl: 3600 } } as RequestInit)
  const payload = await fetchOidcJson(
    discoveryUrl,
    fetchInit,
    OIDC_DISCOVERY_MAX_BYTES,
    'Failed to fetch OIDC discovery',
  )
  const parsed = v.safeParse(oidcDiscoverySchema, payload)
  if (!parsed.success) {
    throw new AppError('internal_error', { longMessage: 'OIDC discovery response invalid' })
  }
  assertDiscoveryTrust(discoveryUrl, parsed.output, permitsLoopbackHttp)
  return parsed.output
}

// 拉取 provider JWKS(用于验证 id_token 签名)。
type JwksResponse = { keys: (JsonWebKey & { kid?: string; alg?: string; use?: string })[] }

export async function fetchProviderJwks(
  jwksUri: string,
  permitsLoopbackHttp: boolean,
): Promise<JwksResponse> {
  if (!isTrustedUpstreamUrl(jwksUri, permitsLoopbackHttp)) {
    throw new AppError('internal_error', { longMessage: 'Provider JWKS URL is not public HTTPS' })
  }
  const fetchInit =
    permitsLoopbackHttp && isLoopbackHttpUrl(jwksUri)
      ? {}
      : ({ cf: { cacheEverything: true, cacheTtl: 3600 } } as RequestInit)
  const payload = await fetchOidcJson(
    jwksUri,
    fetchInit,
    OIDC_JWKS_MAX_BYTES,
    'Failed to fetch provider JWKS',
  )
  const parsed = v.safeParse(oidcJwksSchema, payload)
  if (!parsed.success || parsed.output.keys.some((key) => typeof key['kty'] !== 'string')) {
    throw new AppError('internal_error', { longMessage: 'Provider JWKS response invalid' })
  }
  return parsed.output as JwksResponse
}

// 从 provider JWKS 构建 VerifyKeySet(按 kid 索引)。
export async function buildProviderKeySet(jwks: JwksResponse): Promise<VerifyKeySet> {
  const keys: { kid: string; alg: SigningAlg; publicKey: CryptoKey }[] = []
  for (const jwk of jwks.keys) {
    if (jwk.use && jwk.use !== 'sig') continue
    const kid = jwk.kid ?? 'default'
    const alg = (jwk.alg ?? 'RS256') as SigningAlg
    try {
      const publicKey = await importJwkForVerify({ ...jwk, kid, use: 'sig', alg } as PublicJwk)
      keys.push({ kid, alg, publicKey })
    } catch {
      // 跳过无法导入的 key(算法不支持),继续处理其余 key。
    }
  }
  if (keys.length === 0)
    throw new AppError('internal_error', { longMessage: 'No usable keys in provider JWKS' })
  return { keys }
}

type TokenResponse = v.InferOutput<typeof oidcTokenResponseSchema>

type ExchangeCodeParams = {
  discovery: OidcDiscovery
  clientId: string
  clientSecret: string | null
  code: string
  codeVerifier: string
  redirectUri: string
  permitsLoopbackHttp: boolean
}

// RFC 6749 2.3.1:Basic 认证前先对 client_id / secret 做 form-urlencode。
function basicCredentials(clientId: string, clientSecret: string): string {
  const encode = (value: string): string => encodeURIComponent(value).replace(/%20/g, '+')
  return `Basic ${btoa(`${encode(clientId)}:${encode(clientSecret)}`)}`
}

// 机密客户端按 discovery 的 token_endpoint_auth_methods_supported 选 Basic(缺省)或 post;
// 未配置 secret 时是纯 PKCE public client。PKCE code_verifier 始终发送。
function tokenRequest(p: ExchangeCodeParams): { headers: Record<string, string>; body: string } {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: p.clientId,
    code: p.code,
    code_verifier: p.codeVerifier,
    redirect_uri: p.redirectUri,
  })
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  }
  if (p.clientSecret) {
    const methods = p.discovery.token_endpoint_auth_methods_supported
    const usesPost =
      methods !== undefined &&
      !methods.includes('client_secret_basic') &&
      methods.includes('client_secret_post')
    if (usesPost) body.set('client_secret', p.clientSecret)
    else headers['Authorization'] = basicCredentials(p.clientId, p.clientSecret)
  }
  return { headers, body: body.toString() }
}

async function readTokenError(res: Response): Promise<string> {
  try {
    const parsed = v.safeParse(
      oidcTokenErrorSchema,
      await readBoundedJson(res, OIDC_TOKEN_MAX_BYTES),
    )
    return parsed.success ? parsed.output.error : 'unknown'
  } catch {
    return 'unreadable'
  }
}

// 用 authorization_code + PKCE code_verifier 换 token(见 oidc-oauth rule code exchange)。
export async function exchangeCode(p: ExchangeCodeParams): Promise<TokenResponse> {
  const tokenEndpoint = p.discovery.token_endpoint
  if (!isTrustedUpstreamUrl(tokenEndpoint, p.permitsLoopbackHttp)) {
    throw new AppError('invalid_grant', { longMessage: 'Token endpoint is not public HTTPS' })
  }
  const request = tokenRequest(p)
  let res: Response
  try {
    res = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
      redirect: 'manual',
      signal: AbortSignal.timeout(OIDC_UPSTREAM_TIMEOUT_MS),
    })
  } catch (cause) {
    throw new AppError('invalid_grant', { cause, longMessage: 'Token exchange failed' })
  }
  if (!res.ok) {
    const upstreamError = await readTokenError(res)
    throw new AppError('invalid_grant', {
      longMessage: 'Token exchange failed',
      logReason: res.status === 401 ? 'token_endpoint_client_rejected' : 'token_endpoint_rejected',
      cause: new Error(`token endpoint ${res.status} ${upstreamError}`),
    })
  }
  let payload: unknown
  try {
    payload = await readBoundedJson(res, OIDC_TOKEN_MAX_BYTES)
  } catch (cause) {
    throw new AppError('invalid_grant', { cause, longMessage: 'Token response invalid' })
  }
  const parsed = v.safeParse(oidcTokenResponseSchema, payload)
  if (!parsed.success) {
    throw new AppError('invalid_grant', { longMessage: 'Token response invalid' })
  }
  return parsed.output
}
