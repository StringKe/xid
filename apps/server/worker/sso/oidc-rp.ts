// oidc-rp.ts:作为 RP 对接企业上游 IdP(OIDC 联邦)。
// 流程:discovery -> authorize 重定向(PKCE + nonce + state) -> callback 验 id_token 签名 -> jit。
// state/nonce 存 OAuthFlowDO(OAUTH_STATE,10min 一次性消费,强一致防重放)。
// id_token 签名用 provider JWKS 验证(从 oidcDiscoveryUrl 拉取 JWKS endpoint)。
// 铁律:
//   - PKCE 强制 S256(见 oidc-oauth rule)。
//   - nonce 防 CSRF;state 一次性消费(DO 串行)。
//   - redirect_uri 精确匹配,白名单验证(见 oidc-oauth rule)。
//   - tenant_id 从 TenantContext 取,不信任 body。
//   - 路由模块 export 注册函数。

import { base64UrlEncode, importJwkForVerify, verifyJwt } from '@xid-kit/crypto'
import { createTenantDb, resolveTenantContextByApplicationClientId, schema } from '@xid-kit/db'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { Context } from 'hono'
import * as v from 'valibot'
import { AppError } from '../lib/errors'
import { createPersistedId } from '../lib/persisted-id'
import { issueSession } from '../lib/session'
import { SSO_AUTH_CONTEXT } from '../lib/auth-context'
import { resolvePostAuthMfaGate } from '../lib/mfa-session'
import type { XidHonoEnv } from '../lib/types'
import { jitProvision } from './jit'
import type { SsoAssertion } from './jit'
import { resolveSsoConnectionTenant, resolveSsoFlowTenant, withTenant } from './tenant'
import { enforceEnterpriseSsoPolicy } from './enterprise-policy'
import { shouldSkipDefaultMembership } from '../me-auth/passwordless-users'
import { OAUTH_FLOW_STATE_TTL_MS } from '../lib/ttl'
import { isLoopbackHttpUrl, isPublicHttpsUrl } from '../lib/validate'
import { readBoundedJson } from './bounded-json'
import { isDevOrTestEnvironment } from '../test-harness/dev-gate'
import {
  isAuthorizeContinuation,
  normalizeLocalContinuePath,
  resolveApplicationAuthorizeContinuation,
} from '../../shared/hosted-auth-continuation'
import { isApplicationSignUpIntent } from '../../shared/hosted-auth-intent'

// OAuthFlowDO 中存储的 OIDC RP 流程状态。
type OidcRpFlowPayload = {
  tenantId: string
  connectionId: string
  codeVerifier: string
  nonce: string
  redirectAfterLogin: string
  returnToOrigin: string
  createdAt: number
  applicationClientId?: string
  invitationToken?: string
  skipDefaultMembership?: boolean
}

type NewOidcRpFlowPayload = Omit<OidcRpFlowPayload, 'invitationToken'>

const DEFAULT_AUTH_RETURN_PATH = '/console'
const INVITATION_PATH = '/accept-invitation'

function isInvitationContinuePath(value: string | null | undefined): boolean {
  if (!value) return false
  try {
    const parsed = new URL(value, 'https://xid.invalid')
    return parsed.pathname === INVITATION_PATH || parsed.pathname === `${INVITATION_PATH}/`
  } catch {
    return false
  }
}

function requestHasRawInvitationInput(
  c: Context<XidHonoEnv>,
  continuationParameters: readonly string[],
): boolean {
  const query = new URL(c.req.url).searchParams
  if (query.has('invitation_token') || query.has('invitationToken')) return true
  return continuationParameters.some((name) =>
    query.getAll(name).some((value) => isInvitationContinuePath(value)),
  )
}

// PKCE code_verifier 字节数(43 字节 base64url = 256bit entropy)。
const CODE_VERIFIER_BYTES = 43

// OAuthFlowDO stub(OAUTH_STATE binding,见 cloudflare-bindings rule)。
function oauthFlowStub(env: Env, state: string): DurableObjectStub {
  const ns = env.OAUTH_STATE
  return ns.get(ns.idFromName(`sso-oidc:${state}`))
}

async function storeFlow(env: Env, state: string, payload: NewOidcRpFlowPayload): Promise<void> {
  const stub = oauthFlowStub(env, state)
  const res = await stub.fetch('https://oauth-flow/store', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state, ...payload, ttlMs: OAUTH_FLOW_STATE_TTL_MS }),
  })
  if (res.status !== 201) throw new AppError('internal_error')
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') throw new AppError('server_error')
  return value as Record<string, unknown>
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value.length === 0) throw new AppError('server_error')
  return value
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0) throw new AppError('server_error')
  return value
}

// DO 返回的 record 持 codeVerifier / nonce / connectionId:形状不完整时不能带缺省值继续换码,
// 否则 PKCE 与 nonce 绑定被跳过,connection 归属也无从校验。
function parseConsumedFlowBody(value: unknown): OidcRpFlowPayload {
  const record = asObject(asObject(value)['record'])
  const createdAt = record['createdAt']
  const skipDefaultMembership = record['skipDefaultMembership']
  const applicationClientId = optionalString(record, 'applicationClientId')
  const camelInvitationToken = optionalString(record, 'invitationToken')
  const snakeInvitationToken = optionalString(record, 'invitation_token')
  const invitationToken = camelInvitationToken ?? snakeInvitationToken
  if (
    typeof createdAt !== 'number' ||
    (skipDefaultMembership !== undefined && typeof skipDefaultMembership !== 'boolean')
  ) {
    throw new AppError('server_error')
  }
  return {
    tenantId: requiredString(record, 'tenantId'),
    connectionId: requiredString(record, 'connectionId'),
    codeVerifier: requiredString(record, 'codeVerifier'),
    nonce: requiredString(record, 'nonce'),
    redirectAfterLogin: requiredString(record, 'redirectAfterLogin'),
    returnToOrigin: requiredString(record, 'returnToOrigin'),
    createdAt,
    ...(applicationClientId === undefined ? {} : { applicationClientId }),
    ...(invitationToken === undefined ? {} : { invitationToken }),
    ...(skipDefaultMembership === undefined ? {} : { skipDefaultMembership }),
  }
}

// fail closed:只有 DO 明确回 404(state 不存在)/ 410(已过期)才是"state 无效"的正常语义,
// 其余状态码与坏 body 都是协调层故障 -- 静默当作 state 无效会让一次性消费语义失效,
// CSRF 防护与 code 重放防护同时失守,必须拒绝整个请求。
async function consumeFlow(env: Env, state: string): Promise<OidcRpFlowPayload | null> {
  const stub = oauthFlowStub(env, state)
  const res = await stub.fetch('https://oauth-flow/consume', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state }),
  })
  if (res.status === 404 || res.status === 410) return null
  if (res.status !== 200) throw new AppError('server_error')
  let body: unknown
  try {
    body = await res.json()
  } catch (error) {
    throw new AppError('server_error', { cause: error })
  }
  return parseConsumedFlowBody(body)
}

function assertOidcRpFlowPayload(flow: OidcRpFlowPayload): asserts flow is OidcRpFlowPayload {
  if (
    typeof flow.tenantId !== 'string' ||
    flow.tenantId.length === 0 ||
    typeof flow.connectionId !== 'string' ||
    flow.connectionId.length === 0 ||
    typeof flow.codeVerifier !== 'string' ||
    flow.codeVerifier.length === 0 ||
    typeof flow.nonce !== 'string' ||
    flow.nonce.length === 0 ||
    typeof flow.redirectAfterLogin !== 'string' ||
    flow.redirectAfterLogin.length === 0 ||
    typeof flow.returnToOrigin !== 'string' ||
    flow.returnToOrigin.length === 0
  ) {
    throw new AppError('invalid_request', { longMessage: 'state_invalid' })
  }
}

// PKCE code_challenge(S256)。
async function computeCodeChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return base64UrlEncode(new Uint8Array(digest))
}

// OIDC Discovery 响应(最小所需字段)。
type OidcDiscovery = {
  authorization_endpoint: string
  token_endpoint: string
  jwks_uri: string
  issuer: string
}

const OIDC_UPSTREAM_TIMEOUT_MS = 5_000
const OIDC_DISCOVERY_MAX_BYTES = 64 * 1024
const OIDC_TOKEN_MAX_BYTES = 64 * 1024
const OIDC_JWKS_MAX_BYTES = 512 * 1024

const oidcDiscoverySchema = v.object({
  authorization_endpoint: v.pipe(v.string(), v.url()),
  token_endpoint: v.pipe(v.string(), v.url()),
  jwks_uri: v.pipe(v.string(), v.url()),
  issuer: v.pipe(v.string(), v.url()),
})

const oidcTokenResponseSchema = v.object({
  id_token: v.pipe(v.string(), v.minLength(1)),
  access_token: v.pipe(v.string(), v.minLength(1)),
  token_type: v.pipe(v.string(), v.minLength(1)),
  expires_in: v.optional(v.number()),
})

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
async function fetchDiscovery(
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

async function fetchProviderJwks(
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
async function buildProviderKeySet(
  jwks: JwksResponse,
): Promise<import('@xid-kit/crypto').VerifyKeySet> {
  const keys: { kid: string; alg: import('@xid-kit/types').SigningAlg; publicKey: CryptoKey }[] = []
  for (const jwk of jwks.keys) {
    if (jwk.use && jwk.use !== 'sig') continue
    const kid = jwk.kid ?? 'default'
    const alg = (jwk.alg ?? 'RS256') as import('@xid-kit/types').SigningAlg
    try {
      const publicKey = await importJwkForVerify({
        ...jwk,
        kid,
        use: 'sig',
        alg,
      } as import('@xid-kit/crypto').PublicJwk)
      keys.push({ kid, alg, publicKey })
    } catch {
      // 跳过无法导入的 key(算法不支持),继续处理其余 key。
    }
  }
  if (keys.length === 0)
    throw new AppError('internal_error', { longMessage: 'No usable keys in provider JWKS' })
  return { keys }
}

// 从 OIDC id_token claims 中提取 SsoAssertion。
function claimsToAssertion(
  claims: Record<string, unknown>,
  connectionId: string,
  orgId: string,
): SsoAssertion {
  const idpId = typeof claims['sub'] === 'string' ? claims['sub'] : ''
  const email = typeof claims['email'] === 'string' ? claims['email'] : null
  const emailVerified = claims['email_verified'] === true
  const firstName = typeof claims['given_name'] === 'string' ? claims['given_name'] : null
  const lastName = typeof claims['family_name'] === 'string' ? claims['family_name'] : null

  // groups claim(Microsoft Entra / Okta 可选,见 04 章 6)。
  let groups: string[] = []
  const gc = claims['groups']
  if (Array.isArray(gc)) {
    groups = gc.filter((g): g is string => typeof g === 'string')
  }

  return {
    idpId,
    connectionId,
    orgId,
    email,
    emailVerified,
    firstName,
    lastName,
    groups,
    customAttributes: {},
  }
}

// callback URL(保持和 authorize redirect_uri 一致)。
function callbackUrl(origin: string, connectionId: string): string {
  return `${origin}/sso/oidc/${connectionId}/callback`
}

// POST /sso/oidc/:connectionId/authorize -- 发起 OIDC 授权跳转。
async function handleAuthorize(c: Context<XidHonoEnv>): Promise<Response> {
  if (requestHasRawInvitationInput(c, ['redirect_uri', 'continue'])) {
    throw new AppError('invalid_request')
  }
  const connectionId = c.req.param('connectionId')
  if (!connectionId) throw new AppError('invalid_request', { longMessage: 'connectionId required' })
  const tenant = await resolveSsoConnectionTenant(c, connectionId)

  return withTenant(c, tenant, async () => {
    await enforceEnterpriseSsoPolicy({ c, action: 'login', email: null })

    const db = createTenantDb(c.env.DB, tenant)
    const connection = await db.ssoConnections.findOne(eq(schema.ssoConnections.id, connectionId))
    if (!connection || connection.status !== 'active') {
      throw new AppError('connection_not_found')
    }
    if (connection.protocol !== 'oidc') {
      throw new AppError('invalid_request', { longMessage: 'Connection is not OIDC' })
    }
    if (!connection.oidcDiscoveryUrl || !connection.oidcClientId) {
      throw new AppError('internal_error', { longMessage: 'OIDC connection misconfigured' })
    }

    const discovery = await fetchDiscovery(
      connection.oidcDiscoveryUrl,
      isDevOrTestEnvironment(c.env),
    )

    // 生成 state(>= 32 字节)、nonce、PKCE code_verifier。
    const state = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)))
    const nonce = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)))
    const codeVerifier = base64UrlEncode(
      crypto.getRandomValues(new Uint8Array(CODE_VERIFIER_BYTES)),
    )
    const codeChallenge = await computeCodeChallenge(codeVerifier)

    const redirectAfterLogin =
      c.req.query('redirect_uri') ?? c.req.query('continue') ?? DEFAULT_AUTH_RETURN_PATH
    const applicationClientId = c.req.query('client_id')?.trim() || null
    const applicationContinuation = applicationClientId
      ? resolveApplicationAuthorizeContinuation(redirectAfterLogin, applicationClientId)
      : null
    if (
      (applicationClientId && !applicationContinuation) ||
      (!applicationClientId && isAuthorizeContinuation(redirectAfterLogin))
    ) {
      throw new AppError('invalid_request')
    }
    if (applicationClientId) {
      const applicationTenant = await resolveTenantContextByApplicationClientId(
        c.req.raw,
        c.env,
        applicationClientId,
      )
      if (!applicationTenant.ok || applicationTenant.value.tenantId !== tenant.tenantId) {
        throw new AppError('cross_tenant_access_denied')
      }
    }
    const returnToOrigin = new URL(c.req.url).origin
    const intent = c.req.query('intent') ?? null
    if (isApplicationSignUpIntent(intent) && !applicationClientId) {
      throw new AppError('invalid_request')
    }
    const skipDefaultMembership = shouldSkipDefaultMembership({
      redirectAfterLogin,
      intent,
    })

    await storeFlow(c.env, state, {
      tenantId: tenant.tenantId,
      connectionId,
      codeVerifier,
      nonce,
      redirectAfterLogin,
      returnToOrigin,
      createdAt: Date.now(),
      applicationClientId: applicationClientId ?? undefined,
      skipDefaultMembership,
    })

    const params = new URLSearchParams({
      client_id: connection.oidcClientId,
      redirect_uri: callbackUrl(returnToOrigin, connectionId),
      response_type: 'code',
      scope: 'openid profile email',
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    })

    return c.redirect(`${discovery.authorization_endpoint}?${params}`)
  })
}

// OIDC token endpoint code exchange 结果。
type TokenResponse = {
  id_token: string
  access_token: string
  token_type: string
  expires_in?: number
}

// exchangeCode 参数包(绕过 max-params=4)。
type ExchangeCodeParams = {
  tokenEndpoint: string
  clientId: string
  code: string
  codeVerifier: string
  redirectUri: string
  permitsLoopbackHttp: boolean
}

// 用 authorization_code + PKCE code_verifier 换 token(见 oidc-oauth rule code exchange)。
async function exchangeCode(p: ExchangeCodeParams): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: p.clientId,
    code: p.code,
    code_verifier: p.codeVerifier,
    redirect_uri: p.redirectUri,
  })
  if (!isTrustedUpstreamUrl(p.tokenEndpoint, p.permitsLoopbackHttp)) {
    throw new AppError('invalid_grant', { longMessage: 'Token endpoint is not public HTTPS' })
  }
  let res: Response
  try {
    res = await fetch(p.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      redirect: 'manual',
      signal: AbortSignal.timeout(OIDC_UPSTREAM_TIMEOUT_MS),
    })
  } catch (cause) {
    throw new AppError('invalid_grant', { cause, longMessage: 'Token exchange failed' })
  }
  if (!res.ok) throw new AppError('invalid_grant', { longMessage: 'Token exchange failed' })
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

// OIDC callback query(RFC6749 4.1.2):成功带 code+state,失败带 error。形状失败保持
// invalid_request(OAuth 协议错误格式),不走 validation_failed 422,故用 safeParse 自映射。
const callbackQuerySchema = v.object({
  code: v.pipe(v.string(), v.minLength(1)),
  state: v.pipe(v.string(), v.minLength(1)),
})

// 解析并校验 callback 的 code/state/error 参数。error 优先于形状校验(上游拒绝语义是 access_denied)。
function parseCallbackQuery(c: Context<XidHonoEnv>): { code: string; state: string } {
  const error = c.req.query('error') ?? null
  if (error) throw new AppError('access_denied', { longMessage: error })
  const result = v.safeParse(callbackQuerySchema, {
    code: c.req.query('code'),
    state: c.req.query('state'),
  })
  if (!result.success) throw new AppError('invalid_request')
  return result.output
}

// verifyIdToken 参数包(绕过 max-params=4)。
type VerifyIdTokenParams = {
  idToken: string
  keySet: import('@xid-kit/crypto').VerifyKeySet
  expectedIssuer: string
  expectedAudience: string
  expectedNonce: string
}

// 验证 id_token 并返回 claims(签名 + nonce + sub)。
async function verifyIdToken(p: VerifyIdTokenParams): Promise<Record<string, unknown>> {
  const result = await verifyJwt(p.idToken, p.keySet, {
    expectedIssuer: p.expectedIssuer,
    expectedAudience: p.expectedAudience,
  })
  if (!result.ok) {
    throw new AppError('signature_invalid', {
      longMessage: `id_token verification failed: ${result.error.reason}`,
    })
  }
  const claims = result.value.payload as Record<string, unknown>
  if (claims['nonce'] !== p.expectedNonce) {
    throw new AppError('signature_invalid', { longMessage: 'nonce_mismatch' })
  }
  if (typeof claims['sub'] !== 'string' || !claims['sub']) {
    throw new AppError('malformed_request', { longMessage: 'id_token missing sub' })
  }
  return claims
}

// 完成 session 签发并重定向。
type FinalizeSessionParams = {
  c: Context<XidHonoEnv>
  userId: string
  orgId: string | null
  redirectAfterLogin: string
  returnToOrigin: string
  applicationClientId?: string
}

async function finalizeSession(p: FinalizeSessionParams): Promise<Response> {
  const now = new Date()
  const applicationContinuation = p.applicationClientId
    ? resolveApplicationAuthorizeContinuation(p.redirectAfterLogin, p.applicationClientId)
    : null
  if (
    (p.applicationClientId && !applicationContinuation) ||
    (!p.applicationClientId && isAuthorizeContinuation(p.redirectAfterLogin))
  ) {
    throw new AppError('invalid_request')
  }
  const safeLocalRedirect =
    applicationContinuation ??
    normalizeLocalContinuePath(p.redirectAfterLogin) ??
    DEFAULT_AUTH_RETURN_PATH
  const mfaGate = await resolvePostAuthMfaGate(p.c, p.c.get('tenant'), {
    userId: p.userId,
    returnPath: safeLocalRedirect,
  })
  await issueSession(p.c, {
    sessionId: createPersistedId('session'),
    userId: p.userId,
    activeOrgId: p.orgId,
    ...(mfaGate.sessionStatus ? { status: mfaGate.sessionStatus } : {}),
    authContext: SSO_AUTH_CONTEXT,
    authenticatedAt: now,
    rememberMe: true,
    ip: p.c.req.header('cf-connecting-ip') ?? null,
    userAgent: p.c.req.header('user-agent') ?? null,
  })
  const safeRedirect = `${p.returnToOrigin}${mfaGate.redirectUrl ?? safeLocalRedirect}`
  return p.c.redirect(safeRedirect, 302)
}

// GET /sso/oidc/:connectionId/callback -- OIDC callback 处理。
async function handleCallback(c: Context<XidHonoEnv>): Promise<Response> {
  const connectionId = c.req.param('connectionId')
  if (!connectionId) throw new AppError('invalid_request', { longMessage: 'connectionId required' })
  const { code, state } = parseCallbackQuery(c)

  const flow = await consumeFlow(c.env, state)
  if (!flow) throw new AppError('invalid_request', { longMessage: 'state_invalid' })
  assertOidcRpFlowPayload(flow)
  if (flow.invitationToken !== undefined || isInvitationContinuePath(flow.redirectAfterLogin)) {
    throw new AppError('invalid_request')
  }
  const tenant = await resolveSsoFlowTenant(c, flow.tenantId)
  if (flow.tenantId !== tenant.tenantId) throw new AppError('cross_tenant_access_denied')
  if (flow.connectionId !== connectionId) {
    throw new AppError('invalid_request', { longMessage: 'connection_mismatch' })
  }
  if (flow.applicationClientId) {
    const applicationTenant = await resolveTenantContextByApplicationClientId(
      c.req.raw,
      c.env,
      flow.applicationClientId,
    )
    if (!applicationTenant.ok || applicationTenant.value.tenantId !== flow.tenantId) {
      throw new AppError('cross_tenant_access_denied')
    }
  }

  return withTenant(c, tenant, async () => {
    const db = createTenantDb(c.env.DB, tenant)
    const connection = await db.ssoConnections.findOne(eq(schema.ssoConnections.id, connectionId))
    if (!connection || connection.status !== 'active') throw new AppError('connection_not_found')
    if (!connection.oidcDiscoveryUrl || !connection.oidcClientId) {
      throw new AppError('internal_error', { longMessage: 'OIDC connection misconfigured' })
    }
    await enforceEnterpriseSsoPolicy({ c, action: 'login', email: null })

    const permitsLoopbackHttp = isDevOrTestEnvironment(c.env)
    const discovery = await fetchDiscovery(connection.oidcDiscoveryUrl, permitsLoopbackHttp)
    const keySet = await buildProviderKeySet(
      await fetchProviderJwks(discovery.jwks_uri, permitsLoopbackHttp),
    )
    const tokens = await exchangeCode({
      tokenEndpoint: discovery.token_endpoint,
      clientId: connection.oidcClientId,
      code,
      codeVerifier: flow.codeVerifier,
      redirectUri: callbackUrl(flow.returnToOrigin, connectionId),
      permitsLoopbackHttp,
    })
    const claims = await verifyIdToken({
      idToken: tokens.id_token,
      keySet,
      expectedIssuer: discovery.issuer,
      expectedAudience: connection.oidcClientId,
      expectedNonce: flow.nonce,
    })
    const assertion = claimsToAssertion(claims, connectionId, connection.orgId)
    const skipDefaultMembership = flow.skipDefaultMembership ?? false
    const { userId } = await jitProvision(c, assertion, { skipDefaultMembership })
    return finalizeSession({
      c,
      userId,
      orgId: skipDefaultMembership ? null : connection.orgId,
      redirectAfterLogin: flow.redirectAfterLogin,
      returnToOrigin: flow.returnToOrigin,
      ...(flow.applicationClientId ? { applicationClientId: flow.applicationClientId } : {}),
    })
  })
}

const oidcRp = new Hono<XidHonoEnv>()
oidcRp.get('/:connectionId/authorize', handleAuthorize)
oidcRp.get('/:connectionId/callback', handleCallback)

export function registerOidcRpRoutes(app: Hono<XidHonoEnv>): void {
  app.route('/sso/oidc', oidcRp)
}
