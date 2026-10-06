// oidc-rp.ts:作为 RP 对接企业上游 IdP(OIDC 联邦)。
// 流程:discovery -> authorize 重定向(PKCE + nonce + state) -> callback 换码(机密客户端带 client_secret)
// -> 验 id_token 签名 -> jit。state/nonce 存 OAuthFlowDO(10min 一次性消费)。
// 铁律:PKCE 强制 S256;nonce 防重放;tenant_id 从 TenantContext 取;浏览器错误回 /sign-in。

import { importJwkForVerify, verifyJwt } from '@xid-kit/crypto'
import type { PublicJwk, VerifyKeySet } from '@xid-kit/crypto'
import { createTenantDb, resolveTenantContextByApplicationClientId, schema } from '@xid-kit/db'
import { defaultLandingPathFor } from '@xid-kit/types'
import type { SigningAlg } from '@xid-kit/types'
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
import {
  STATE_INVALID,
  assertNoInvitationInFlow,
  consumeFederatedFlow,
  newFederatedFlowSecrets,
  optionalFlowBoolean,
  optionalFlowString,
  redirectToSignInWithError,
  requestHasRawInvitationInput,
  requiredFlowNumber,
  requiredFlowString,
  storeFederatedFlow,
  withSignInErrorRedirect,
} from '../lib/federated-flow'
import type { FederatedFlowRecord, SignInReturnContext } from '../lib/federated-flow'
import { jitProvision } from './jit'
import type { SsoAssertion } from './jit'
import { resolveSsoConnectionTenant, resolveSsoFlowTenant, withTenant } from './tenant'
import { enforceEnterpriseSsoPolicy } from './enterprise-policy'
import { decryptOidcClientSecret } from './oidc-client-secret'
import { shouldSkipDefaultMembership } from '../me-auth/passwordless-users'
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
  intent?: string
  skipDefaultMembership?: boolean
}

const FLOW_PREFIX = 'sso-oidc'

function parseFlow(record: FederatedFlowRecord): OidcRpFlowPayload {
  const applicationClientId = optionalFlowString(record, 'applicationClientId')
  const intent = optionalFlowString(record, 'intent')
  const skipDefaultMembership = optionalFlowBoolean(record, 'skipDefaultMembership')
  const flow: OidcRpFlowPayload = {
    tenantId: requiredFlowString(record, 'tenantId'),
    connectionId: requiredFlowString(record, 'connectionId'),
    codeVerifier: requiredFlowString(record, 'codeVerifier'),
    nonce: requiredFlowString(record, 'nonce'),
    redirectAfterLogin: requiredFlowString(record, 'redirectAfterLogin'),
    returnToOrigin: requiredFlowString(record, 'returnToOrigin'),
    createdAt: requiredFlowNumber(record, 'createdAt'),
    ...(applicationClientId === undefined ? {} : { applicationClientId }),
    ...(intent === undefined ? {} : { intent }),
    ...(skipDefaultMembership === undefined ? {} : { skipDefaultMembership }),
  }
  assertNoInvitationInFlow(record, flow.redirectAfterLogin)
  return flow
}

async function consumeFlow(env: Env, state: string): Promise<OidcRpFlowPayload | null> {
  const record = await consumeFederatedFlow(env, { prefix: FLOW_PREFIX, state })
  return record ? parseFlow(record) : null
}

function flowReturnContext(flow: OidcRpFlowPayload | null): SignInReturnContext {
  if (!flow) return {}
  return {
    continuePath: flow.redirectAfterLogin,
    applicationClientId: flow.applicationClientId ?? null,
    intent: flow.intent ?? null,
  }
}

// OIDC Discovery 响应(最小所需字段)。
type OidcDiscovery = v.InferOutput<typeof oidcDiscoverySchema>

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
async function buildProviderKeySet(jwks: JwksResponse): Promise<VerifyKeySet> {
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

// 从 OIDC id_token claims 中提取 SsoAssertion。
function claimsToAssertion(
  claims: Record<string, unknown>,
  connectionId: string,
  orgId: string,
): SsoAssertion {
  const gc = claims['groups']
  return {
    idpId: typeof claims['sub'] === 'string' ? claims['sub'] : '',
    connectionId,
    orgId,
    email: typeof claims['email'] === 'string' ? claims['email'] : null,
    emailVerified: claims['email_verified'] === true,
    firstName: typeof claims['given_name'] === 'string' ? claims['given_name'] : null,
    lastName: typeof claims['family_name'] === 'string' ? claims['family_name'] : null,
    // groups claim(Microsoft Entra / Okta 可选,见 04 章 6)。
    groups: Array.isArray(gc) ? gc.filter((g): g is string => typeof g === 'string') : [],
    customAttributes: {},
  }
}

// callback URL(保持和 authorize redirect_uri 一致)。
function callbackUrl(origin: string, connectionId: string): string {
  return `${origin}/sso/oidc/${connectionId}/callback`
}

async function loadActiveOidcConnection(
  c: Context<XidHonoEnv>,
  connectionId: string,
): Promise<typeof schema.ssoConnections.$inferSelect> {
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const connection = await db.ssoConnections.findOne(eq(schema.ssoConnections.id, connectionId))
  if (!connection || connection.status !== 'active') throw new AppError('connection_not_found')
  if (connection.protocol !== 'oidc') {
    throw new AppError('invalid_request', { longMessage: 'Connection is not OIDC' })
  }
  if (!connection.oidcDiscoveryUrl || !connection.oidcClientId) {
    throw new AppError('internal_error', { longMessage: 'OIDC connection misconfigured' })
  }
  return connection
}

async function assertApplicationTenant(
  c: Context<XidHonoEnv>,
  applicationClientId: string,
  tenantId: string,
): Promise<void> {
  const applicationTenant = await resolveTenantContextByApplicationClientId(
    c.req.raw,
    c.env,
    applicationClientId,
  )
  if (!applicationTenant.ok || applicationTenant.value.tenantId !== tenantId) {
    throw new AppError('cross_tenant_access_denied')
  }
}

// GET /sso/oidc/:connectionId/authorize -- 发起 OIDC 授权跳转。
async function handleAuthorize(c: Context<XidHonoEnv>): Promise<Response> {
  if (requestHasRawInvitationInput(c, ['redirect_uri', 'continue'])) {
    throw new AppError('invalid_request')
  }
  const connectionId = c.req.param('connectionId')
  if (!connectionId) throw new AppError('invalid_request', { longMessage: 'connectionId required' })
  const tenant = await resolveSsoConnectionTenant(c, connectionId)

  return withTenant(c, tenant, async () => {
    await enforceEnterpriseSsoPolicy({ c, action: 'login', email: null })
    const connection = await loadActiveOidcConnection(c, connectionId)
    const discovery = await fetchDiscovery(
      connection.oidcDiscoveryUrl!,
      isDevOrTestEnvironment(c.env),
    )

    const redirectAfterLogin =
      c.req.query('redirect_uri') ??
      c.req.query('continue') ??
      defaultLandingPathFor(c.get('tenant'))
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
    if (applicationClientId) await assertApplicationTenant(c, applicationClientId, tenant.tenantId)
    const intent = c.req.query('intent') ?? null
    if (isApplicationSignUpIntent(intent) && !applicationClientId) {
      throw new AppError('invalid_request')
    }

    const { state, nonce, codeVerifier, codeChallenge } = await newFederatedFlowSecrets()
    const returnToOrigin = new URL(c.req.url).origin
    await storeFederatedFlow(c.env, {
      prefix: FLOW_PREFIX,
      state,
      payload: {
        tenantId: tenant.tenantId,
        connectionId,
        codeVerifier,
        nonce,
        redirectAfterLogin,
        returnToOrigin,
        createdAt: Date.now(),
        applicationClientId: applicationClientId ?? undefined,
        intent: intent ?? undefined,
        skipDefaultMembership: shouldSkipDefaultMembership({ redirectAfterLogin, intent }),
      },
    })

    const params = new URLSearchParams({
      client_id: connection.oidcClientId!,
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
async function exchangeCode(p: ExchangeCodeParams): Promise<TokenResponse> {
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

// OIDC callback query(RFC6749 4.1.2):成功带 code+state,失败带 error。
const callbackQuerySchema = v.object({
  code: v.pipe(v.string(), v.minLength(1)),
  state: v.pipe(v.string(), v.minLength(1)),
})

type VerifyIdTokenParams = {
  idToken: string
  keySet: VerifyKeySet
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

type FinalizeSessionParams = {
  c: Context<XidHonoEnv>
  userId: string
  orgId: string | null
  flow: OidcRpFlowPayload
}

async function finalizeSession(p: FinalizeSessionParams): Promise<Response> {
  const { c, flow } = p
  const applicationContinuation = flow.applicationClientId
    ? resolveApplicationAuthorizeContinuation(flow.redirectAfterLogin, flow.applicationClientId)
    : null
  if (
    (flow.applicationClientId && !applicationContinuation) ||
    (!flow.applicationClientId && isAuthorizeContinuation(flow.redirectAfterLogin))
  ) {
    throw new AppError('invalid_request')
  }
  const safeLocalRedirect =
    applicationContinuation ??
    normalizeLocalContinuePath(flow.redirectAfterLogin) ??
    defaultLandingPathFor(c.get('tenant'))
  const mfaGate = await resolvePostAuthMfaGate(c, c.get('tenant'), {
    userId: p.userId,
    returnPath: safeLocalRedirect,
    sessionAmr: SSO_AUTH_CONTEXT.amr,
  })
  await issueSession(c, {
    sessionId: createPersistedId('session'),
    userId: p.userId,
    activeOrgId: p.orgId,
    ...(mfaGate.sessionStatus ? { status: mfaGate.sessionStatus } : {}),
    authContext: SSO_AUTH_CONTEXT,
    authenticatedAt: new Date(),
    rememberMe: true,
    ip: c.req.header('cf-connecting-ip') ?? null,
    userAgent: c.req.header('user-agent') ?? null,
  })
  return c.redirect(`${flow.returnToOrigin}${mfaGate.redirectUrl ?? safeLocalRedirect}`, 302)
}

async function completeCallback(
  c: Context<XidHonoEnv>,
  input: { connectionId: string; code: string; flow: OidcRpFlowPayload },
): Promise<Response> {
  const { connectionId, code, flow } = input
  const connection = await loadActiveOidcConnection(c, connectionId)
  await enforceEnterpriseSsoPolicy({ c, action: 'login', email: null })

  const permitsLoopbackHttp = isDevOrTestEnvironment(c.env)
  const discovery = await fetchDiscovery(connection.oidcDiscoveryUrl!, permitsLoopbackHttp)
  const keySet = await buildProviderKeySet(
    await fetchProviderJwks(discovery.jwks_uri, permitsLoopbackHttp),
  )
  const clientSecret = connection.oidcClientSecretCiphertext
    ? await decryptOidcClientSecret(c.env, connection.oidcClientSecretCiphertext)
    : null
  const tokens = await exchangeCode({
    discovery,
    clientId: connection.oidcClientId!,
    clientSecret,
    code,
    codeVerifier: flow.codeVerifier,
    redirectUri: callbackUrl(flow.returnToOrigin, connectionId),
    permitsLoopbackHttp,
  })
  const claims = await verifyIdToken({
    idToken: tokens.id_token,
    keySet,
    expectedIssuer: discovery.issuer,
    expectedAudience: connection.oidcClientId!,
    expectedNonce: flow.nonce,
  })
  const skipDefaultMembership = flow.skipDefaultMembership ?? false
  const { userId } = await jitProvision(
    c,
    claimsToAssertion(claims, connectionId, connection.orgId),
    { skipDefaultMembership },
  )
  return finalizeSession({
    c,
    userId,
    orgId: skipDefaultMembership ? null : connection.orgId,
    flow,
  })
}

// GET /sso/oidc/:connectionId/callback -- OIDC callback 处理。
async function handleCallback(
  c: Context<XidHonoEnv>,
  onFlow: (flow: OidcRpFlowPayload) => void,
): Promise<Response> {
  const connectionId = c.req.param('connectionId')
  if (!connectionId) throw new AppError('invalid_request', { longMessage: 'connectionId required' })

  // 上游拒绝(用户取消等):一次性消费 state 恢复原 continue;上游 error 原文不回显。
  const upstreamError = c.req.query('error')
  if (upstreamError) {
    const state = c.req.query('state')
    const flow = state ? await consumeFlow(c.env, state) : null
    const error = upstreamError === 'access_denied' ? 'cancelled' : 'sign_in_failed'
    return redirectToSignInWithError(c, error, flowReturnContext(flow))
  }
  const query = v.safeParse(callbackQuerySchema, {
    code: c.req.query('code'),
    state: c.req.query('state'),
  })
  if (!query.success) throw new AppError('invalid_request', { longMessage: STATE_INVALID })

  const flow = await consumeFlow(c.env, query.output.state)
  if (!flow) throw new AppError('invalid_request', { longMessage: STATE_INVALID })
  onFlow(flow)
  const tenant = await resolveSsoFlowTenant(c, flow.tenantId)
  if (flow.tenantId !== tenant.tenantId) throw new AppError('cross_tenant_access_denied')
  if (flow.connectionId !== connectionId) {
    throw new AppError('invalid_request', { longMessage: 'connection_mismatch' })
  }
  if (flow.applicationClientId) {
    await assertApplicationTenant(c, flow.applicationClientId, flow.tenantId)
  }
  return withTenant(c, tenant, () =>
    completeCallback(c, { connectionId, code: query.output.code, flow }),
  )
}

const oidcRp = new Hono<XidHonoEnv>()

oidcRp.get('/:connectionId/authorize', (c) =>
  withSignInErrorRedirect(c, {
    operation: 'sso_oidc_authorize',
    context: () => ({
      continuePath: c.req.query('continue') ?? null,
      applicationClientId: c.req.query('client_id')?.trim() || null,
      intent: c.req.query('intent') ?? null,
    }),
    run: () => handleAuthorize(c),
  }),
)

oidcRp.get('/:connectionId/callback', (c) => {
  let consumedFlow: OidcRpFlowPayload | null = null
  return withSignInErrorRedirect(c, {
    operation: 'sso_oidc_callback',
    context: () => flowReturnContext(consumedFlow),
    run: () =>
      handleCallback(c, (flow) => {
        consumedFlow = flow
      }),
  })
})

export function registerOidcRpRoutes(app: Hono<XidHonoEnv>): void {
  app.route('/sso/oidc', oidcRp)
}
