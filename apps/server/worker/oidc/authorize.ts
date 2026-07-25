// /authorize 端点(03 章 10):执行 protocol evaluateAuthorize 状态机,wire session/consent/PAR。
// 无 session -> 暂存参数到 OAuthFlowDO + 302 /sign-in;有 session -> consent 检查 -> 生成 code 写 D1。
// 铁律:client/redirect_uri 精确匹配;PKCE 绑定;tenant 从 c.get('tenant'),consent 走租户查询层。

import {
  buildIdTokenClaims,
  evaluateAuthorize,
  generateAuthorizationCode,
  leftHalfHash,
  signClaims,
} from '@xid-kit/protocol'
import type { AuthorizeRequest, ClientRegistration } from '@xid-kit/protocol'
import { createTenantDb, schema } from '@xid-kit/db'
import { and, asc, eq, gt, inArray, isNull } from 'drizzle-orm'
import type { Result, XidError } from '@xid-kit/types'
import type { Context, Hono } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import * as v from 'valibot'
import type { SessionData, XidHonoEnv } from '../lib/types'
import { renderProtocolErrorPage } from '../lib/error-page'
import { clientRequiresBba, clientRequiresFapi } from './client-policy'
import { findClient, loadActiveSigner, resolveAccessTtlSec } from './shared'
import type { ClientRow } from './shared'
import { resolveResponseMode, respondToRp, signAuthorizationResponseJwt } from './authorize-respond'
import { resolvePar } from './par'
import { consumeStashedAuthorizeParams } from './pending-params'
import { resolveRequestObject } from './request-object'
import {
  authorizationDetailsResources,
  authorizationDetailsScopes,
  parseAuthorizationDetails,
} from './authorization-details'
import type { AuthorizationDetails } from '@xid-kit/types'
import { verifyStepUpToken } from '../auth/mfa'
import {
  ACR_AAL2,
  ACR_AAL3,
  addMfaToAuthContext,
  buildPasskeyMfaAuthContext,
  PASSWORD_AUTH_CONTEXT,
  sessionSatisfiesAal2,
  sessionSatisfiesAal3,
} from '../lib/auth-context'
import type { AuthContextData } from '../lib/auth-context'
import { ACTIVE_SESSION_STATUS, PENDING_MFA_SETUP_SESSION_STATUS } from '../lib/session'
import { AUTH_CODE_TTL_SEC, OAUTH_FLOW_STATE_TTL_MS } from '../lib/ttl'

const ACTIVE_ORG_LOOKUP_BATCH_SIZE = 100
const SUPPORTED_RESPONSE_TYPES = ['code', 'code id_token'] as const
const SUPPORTED_RESPONSE_MODES = [
  'query',
  'fragment',
  'form_post',
  'query.jwt',
  'fragment.jwt',
] as const
const STEP_UP_COOKIE_NAME = '__Host-xid.acr'

// 白名单收口到 picklist(收窄出 literal union);拒绝路径的错误码仍由
// localErrorPage / evaluateAuthorize 决定,schema 只做支持性判断。
const responseTypeSchema = v.picklist(SUPPORTED_RESPONSE_TYPES)
const responseModeSchema = v.picklist(SUPPORTED_RESPONSE_MODES)

type RawParams = Record<string, string>

type AuthorizeRbacContext = {
  activeOrgId: string | null
  projectGrantId: string | null
}

type ResolvedAuthorizationDetails = {
  details: readonly AuthorizationDetails[]
  resources: readonly string[]
  scopes: readonly string[]
}

function responseModeSupported(params: RawParams): boolean {
  const mode = params['response_mode']
  return mode === undefined || v.safeParse(responseModeSchema, mode).success
}

// 从 query 解析 AuthorizeRequest(protocol 入口参数,10.1)。
function toAuthorizeRequest(p: RawParams): AuthorizeRequest {
  const req: AuthorizeRequest = {
    responseType: p['response_type'] ?? '',
    clientId: p['client_id'] ?? '',
    redirectUri: p['redirect_uri'] ?? '',
    scope: p['scope'] ?? '',
  }
  assignOptionalStrings(req, p)
  const maxAge = p['max_age'] === undefined ? Number.NaN : Number.parseInt(p['max_age'], 10)
  if (Number.isFinite(maxAge)) req.maxAge = maxAge
  return req
}

// 把 query 可选字符串字段写入 AuthorizeRequest(仅在存在时写,降低主函数复杂度)。
function assignOptionalStrings(req: AuthorizeRequest, p: RawParams): void {
  const mapping: [keyof AuthorizeRequest, string][] = [
    ['state', 'state'],
    ['nonce', 'nonce'],
    ['codeChallenge', 'code_challenge'],
    ['codeChallengeMethod', 'code_challenge_method'],
    ['prompt', 'prompt'],
    ['acrValues', 'acr_values'],
    ['claims', 'claims'],
  ]
  for (const [field, key] of mapping) {
    const value = p[key]
    if (value !== undefined) (req as Record<string, unknown>)[field] = value
  }
}

function toClientRegistration(row: ClientRow): ClientRegistration {
  return {
    clientId: row.clientId,
    active: row.status === 'active',
    isPublic: row.clientType === 'public',
    firstParty: row.firstParty,
    redirectUris: row.redirectUris,
    allowedResponseTypes: row.allowedResponseTypes.filter(
      (rt): rt is (typeof SUPPORTED_RESPONSE_TYPES)[number] =>
        v.safeParse(responseTypeSchema, rt).success,
    ),
    allowedScopes: row.allowedScopes,
  }
}

// 查 consent:请求 scope 是否 ⊆ 已持久化授权集(10.5)。
async function checkConsent(
  c: Context<XidHonoEnv>,
  userId: string,
  clientId: string,
  scope: string,
): Promise<boolean> {
  const ctx = c.get('tenant')
  const db = createTenantDb(c.env.DB, ctx)
  const row = await db.oauthConsents.findOne(
    and(eq(schema.oauthConsents.userId, userId), eq(schema.oauthConsents.clientId, clientId)),
  )
  if (!row) return false
  const granted = new Set(row.grantedScopes)
  return scope
    .split(' ')
    .filter(Boolean)
    .every((s) => granted.has(s))
}

function authzFail(
  code: XidError['code'],
  message: string,
  httpStatus = 400,
): Result<never, XidError> {
  return { ok: false, error: { code, message, httpStatus } }
}

async function loadActiveOrg(
  c: Context<XidHonoEnv>,
  session: SessionData,
): Promise<Result<{ id: string; slug: string } | null, XidError>> {
  if (!session.activeOrgId) return { ok: true, value: null }
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const org = await db.organizations.findOne(
    and(
      eq(schema.organizations.id, session.activeOrgId),
      eq(schema.organizations.status, 'active'),
    ),
  )
  if (!org) return authzFail('access_denied', 'active organization revoked or not found', 403)
  const membership = await db.memberships.findOne(
    and(
      eq(schema.memberships.userId, session.userId),
      eq(schema.memberships.orgId, org.id),
      eq(schema.memberships.status, 'active'),
    ),
  )
  if (!membership)
    return authzFail('access_denied', 'active organization revoked or not found', 403)
  return { ok: true, value: { id: org.id, slug: org.slug } }
}

async function resolveAuthorizeRbacContext(
  c: Context<XidHonoEnv>,
  input: { client: ClientRow; session: SessionData },
): Promise<Result<AuthorizeRbacContext, XidError>> {
  const active = await loadActiveOrg(c, input.session)
  if (!active.ok) return active
  if (!active.value) {
    if (input.client.requireOrgContext) {
      return authzFail('access_denied', 'organization context required', 403)
    }
    return { ok: true, value: { activeOrgId: null, projectGrantId: null } }
  }
  if (!input.client.projectId) {
    return { ok: true, value: { activeOrgId: active.value.id, projectGrantId: null } }
  }

  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const project = await db.projects.findOne(eq(schema.projects.id, input.client.projectId))
  if (!project) return authzFail('unauthorized_client', 'application project not found')
  if (project.orgId === active.value.id) {
    return { ok: true, value: { activeOrgId: active.value.id, projectGrantId: null } }
  }

  const grant = await db.projectGrants.findOne(
    and(
      eq(schema.projectGrants.grantedProjectId, project.id),
      eq(schema.projectGrants.grantedToOrgId, active.value.id),
      eq(schema.projectGrants.status, 'active'),
    ),
  )
  if (!grant) return authzFail('access_denied', 'project grant revoked or not found', 403)
  const userGrant = await db.userGrants.findOne(
    and(
      eq(schema.userGrants.userId, input.session.userId),
      eq(schema.userGrants.projectId, project.id),
      eq(schema.userGrants.grantedViaGrantId, grant.id),
      isNull(schema.userGrants.revokedAt),
    ),
  )
  if (!userGrant) return authzFail('access_denied', 'user not authorized via grant', 403)
  return { ok: true, value: { activeOrgId: active.value.id, projectGrantId: grant.id } }
}

// 本地错误页(client_id/redirect_uri 不可信,不可重定向,10.2/10.7):
// 渲染品牌化 HTML 而不是 JSON(浏览器直接打开的页面必须是可读页面)。
function localErrorPage(
  c: Context<XidHonoEnv>,
  error: string,
  description: string,
  httpStatus = 400,
): Promise<Response> {
  return renderProtocolErrorPage(c, { status: httpStatus, error, description })
}

// 暂存原始 authorize 参数到 OAuthFlowDO(key=authz_request_id),302 到 /sign-in 或 /consent。
// stepUp 仅 /mfa 路径有效:true=acr step-up(不升级 session);pending_mfa 续跑必须传 false,
// 否则 MFA 验证只发 step-up token、session 仍 pending,回 /authorize 会再次重定向形成循环。
async function stashAndRedirect(
  c: Context<XidHonoEnv>,
  input: {
    params: RawParams
    path: '/sign-in' | '/consent' | '/mfa' | '/select-organization' | '/account/security'
    selectAccount: boolean
    stepUp?: boolean
  },
): Promise<Response> {
  const ctx = c.get('tenant')
  const authzRequestId = crypto.randomUUID()
  const ns = c.env.OAUTH_STATE
  const stub = ns.get(ns.idFromName(`authz:${ctx.tenantId}:${authzRequestId}`))
  const storeRes = await stub.fetch('https://oauth-flow-do/store', {
    method: 'POST',
    body: JSON.stringify({
      state: authzRequestId,
      pendingParams: input.params,
      ttlMs: OAUTH_FLOW_STATE_TTL_MS,
    }),
  })
  // 暂存失败仍跳登录页,用户认证完回 /authorize 时读不到参数,只会撞上"请求已过期";
  // 更糟的是 stash 的参数携带 PKCE / acr 要求,静默丢弃等于降级。此处必须拒绝。
  if (storeRes.status !== 201) {
    return localErrorPage(c, 'server_error', 'authorization request storage unavailable', 500)
  }
  const url = new URL(`${ctx.issuer}${input.path}`)
  url.searchParams.set('authz_request_id', authzRequestId)
  if (
    input.path === '/mfa' ||
    input.path === '/select-organization' ||
    input.path === '/account/security'
  ) {
    url.searchParams.set('redirect_to', `/authorize?authz_request_id=${authzRequestId}`)
  }
  if (input.path === '/account/security') {
    url.searchParams.set('setup', 'mfa')
  }
  if (input.path === '/mfa') {
    if (input.stepUp) url.searchParams.set('step_up', '1')
    const method = input.params['method']
    if (method) url.searchParams.set('method', method)
    const requireAal3 = input.params['require_aal3']
    if (requireAal3) url.searchParams.set('require_aal3', requireAal3)
  }
  if (input.selectAccount) url.searchParams.set('select_account', '1')
  const loginHint = input.params['login_hint']
  if (loginHint) url.searchParams.set('login_hint', loginHint)
  return c.redirect(url.toString(), 302)
}

function parseRequestedAcrs(req: AuthorizeRequest): Set<string> {
  const requested = new Set<string>()
  for (const value of req.acrValues?.split(' ').filter(Boolean) ?? []) requested.add(value)
  if (req.claims === undefined) return requested
  try {
    const parsed = JSON.parse(req.claims) as unknown
    if (!isRecord(parsed)) return requested
    const idToken = parsed['id_token']
    if (!isRecord(idToken)) return requested
    const acr = idToken['acr']
    if (!isRecord(acr)) return requested
    const value = acr['value']
    if (typeof value === 'string') requested.add(value)
    const values = acr['values']
    if (Array.isArray(values)) {
      for (const entry of values) {
        if (typeof entry === 'string') requested.add(entry)
      }
    }
  } catch {
    return requested
  }
  return requested
}

function promptIncludesNone(req: AuthorizeRequest): boolean {
  return req.prompt?.split(' ').filter(Boolean).includes('none') ?? false
}

function requestedAal2(req: AuthorizeRequest): boolean {
  return parseRequestedAcrs(req).has(ACR_AAL2)
}

function requestedAal3(req: AuthorizeRequest): boolean {
  return parseRequestedAcrs(req).has(ACR_AAL3)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readStepUpAuthContext(
  c: Context<XidHonoEnv>,
  session: SessionData,
  requestedAal3: boolean,
): Promise<{ authTime: number; acr: string; amr: SessionData['amr'] } | null> {
  const token = getCookie(c, STEP_UP_COOKIE_NAME)
  if (!token) return null
  const verified = await verifyStepUpToken(token, c.env.PEPPER)
  if (!verified.ok) return null
  if (verified.payload.sub !== session.userId || verified.payload.sid !== session.sessionId) {
    return null
  }
  const base: AuthContextData = {
    acr: session.acr ?? PASSWORD_AUTH_CONTEXT.acr,
    amr: session.amr ?? PASSWORD_AUTH_CONTEXT.amr,
    aal: session.aal === 1 || session.aal === 2 || session.aal === 3 ? session.aal : 1,
  }
  const tenant = c.get('tenant')
  const attestationMode = tenant.policy.hostedAuth?.attestationMode ?? 'none'
  const upgraded =
    verified.payload.method === 'passkey' && requestedAal3 && verified.payload.passkeyAssurance
      ? buildPasskeyMfaAuthContext(base, {
          ...verified.payload.passkeyAssurance,
          requireEnterpriseAttestation: attestationMode === 'direct',
        })
      : addMfaToAuthContext(base, verified.payload.method)
  return { authTime: verified.payload.iat, acr: upgraded.acr, amr: upgraded.amr }
}

function clearStepUpCookie(c: Context<XidHonoEnv>): void {
  setCookie(c, STEP_UP_COOKIE_NAME, '', {
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'Lax',
    maxAge: 0,
  })
}

async function resolveAcrContext(
  c: Context<XidHonoEnv>,
  input: { req: AuthorizeRequest; effective: RawParams; session: SessionData },
): Promise<
  { authTime: number; acr: string | null; amr: SessionData['amr']; clearStepUp: boolean } | Response
> {
  const sessionContext = {
    authTime: Math.floor(input.session.authenticatedAt.getTime() / 1000),
    acr: input.session.acr,
    amr: input.session.amr,
    clearStepUp: false,
  }
  const wantsAal3 = requestedAal3(input.req)

  if (wantsAal3) {
    if (sessionSatisfiesAal3(input.session)) return sessionContext
    const stepUpContext = await readStepUpAuthContext(c, input.session, true)
    if (stepUpContext?.acr === ACR_AAL3) return { ...stepUpContext, clearStepUp: true }
    if (stepUpContext?.acr === ACR_AAL2) {
      const token = getCookie(c, STEP_UP_COOKIE_NAME)
      if (token) {
        const verified = await verifyStepUpToken(token, c.env.PEPPER)
        if (
          verified.ok &&
          verified.payload.method === 'passkey' &&
          verified.payload.passkeyAssurance
        ) {
          return { ...stepUpContext, clearStepUp: true }
        }
      }
    }
    if (promptIncludesNone(input.req)) {
      return emitRedirectError(c, {
        redirectUri: input.req.redirectUri,
        responseType: input.req.responseType,
        responseMode: input.effective['response_mode'],
        clientId: input.req.clientId,
        error: 'interaction_required',
        description: 'additional authentication required for requested acr',
        state: input.req.state,
      })
    }
    const mfaParams = new URLSearchParams(input.effective as Record<string, string>)
    mfaParams.set('method', 'passkey')
    mfaParams.set('require_aal3', '1')
    mfaParams.set('step_up', '1')
    return stashAndRedirect(c, {
      params: Object.fromEntries(mfaParams.entries()),
      path: '/mfa',
      selectAccount: false,
      stepUp: true,
    })
  }

  if (!requestedAal2(input.req)) return sessionContext
  if (sessionSatisfiesAal2(input.session)) return sessionContext
  const stepUpContext = await readStepUpAuthContext(c, input.session, false)
  if (stepUpContext) return { ...stepUpContext, clearStepUp: true }
  if (promptIncludesNone(input.req)) {
    return emitRedirectError(c, {
      redirectUri: input.req.redirectUri,
      responseType: input.req.responseType,
      responseMode: input.effective['response_mode'],
      clientId: input.req.clientId,
      error: 'interaction_required',
      description: 'additional authentication required for requested acr',
      state: input.req.state,
    })
  }
  return stashAndRedirect(c, {
    params: input.effective,
    path: '/mfa',
    selectAccount: false,
    stepUp: true,
  })
}

async function consumeStashedAuthorize(
  c: Context<XidHonoEnv>,
  authzRequestId: string,
): Promise<RawParams | null> {
  const ctx = c.get('tenant')
  return consumeStashedAuthorizeParams(c.env, ctx.tenantId, authzRequestId)
}

function redirectToStashedSignIn(c: Context<XidHonoEnv>, authzRequestId: string): Response {
  const ctx = c.get('tenant')
  const url = new URL(`${ctx.issuer}/sign-in`)
  url.searchParams.set('authz_request_id', authzRequestId)
  return c.redirect(url.toString(), 302)
}

// emit_code:生成 ac_ code,写 D1 AuthorizationCode(一次性,60s),按 response_mode 回跳。
async function emitCode(
  c: Context<XidHonoEnv>,
  input: {
    req: AuthorizeRequest
    client: ClientRow
    userId: string
    sessionId: string
    session: Pick<SessionData, 'acr' | 'amr'> & { authTime: number }
    params: RawParams
    rbac: AuthorizeRbacContext
    authorizationDetails: ResolvedAuthorizationDetails
  },
): Promise<Response> {
  const ctx = c.get('tenant')
  const now = Math.floor(Date.now() / 1000)
  const generated = generateAuthorizationCode(now, AUTH_CODE_TTL_SEC)
  const db = createTenantDb(c.env.DB, ctx)
  await db.authorizationCodes.insert({
    code: generated.code,
    tenantId: ctx.tenantId,
    clientId: input.req.clientId,
    userId: input.userId,
    sessionId: input.sessionId,
    redirectUri: input.req.redirectUri,
    scope: input.req.scope,
    nonce: input.req.nonce ?? null,
    codeChallenge: input.req.codeChallenge ?? null,
    codeChallengeMethod: input.req.codeChallengeMethod ?? null,
    dpopJkt: input.params['dpop_jkt'] ?? null,
    authTime: new Date(input.session.authTime * 1000),
    acr: input.session.acr,
    amr: input.session.amr ? [...input.session.amr] : null,
    resource: boundResources(input.params, input.authorizationDetails.resources),
    authorizationDetails:
      input.authorizationDetails.details.length > 0
        ? [...input.authorizationDetails.details]
        : null,
    activeOrgId: input.rbac.activeOrgId,
    projectGrantId: input.rbac.projectGrantId,
    consumedAt: null,
    expiresAt: new Date(generated.expiresAt * 1000),
  })
  const mode = resolveResponseMode(input.params['response_mode'], input.req.responseType)
  const out: RawParams = { code: generated.code, iss: ctx.issuer }
  if (input.req.responseType === 'code id_token') {
    out['id_token'] = await issueHybridIdToken(c, {
      code: generated.code,
      req: input.req,
      client: input.client,
      userId: input.userId,
      sessionId: input.sessionId,
      session: input.session,
      now,
    })
  }
  if (input.req.state !== undefined) out['state'] = input.req.state
  if (mode === 'query.jwt' || mode === 'fragment.jwt') {
    const signer = await loadActiveSigner(ctx, c.env.KEK)
    const response = await signAuthorizationResponseJwt({
      ctx,
      signer,
      clientId: input.req.clientId,
      params: out,
      now,
    })
    return respondToRp(c, { redirectUri: input.req.redirectUri, mode, params: { response } })
  }
  return respondToRp(c, { redirectUri: input.req.redirectUri, mode, params: out })
}

async function issueHybridIdToken(
  c: Context<XidHonoEnv>,
  input: {
    code: string
    req: AuthorizeRequest
    client: ClientRow
    userId: string
    sessionId: string
    session: Pick<SessionData, 'acr' | 'amr'> & { authTime: number }
    now: number
  },
): Promise<string> {
  const ctx = c.get('tenant')
  const signer = await loadActiveSigner(ctx, c.env.KEK)
  const cHash = await leftHalfHash(input.code)
  const claims = buildIdTokenClaims({
    ctx,
    subject: { userId: input.userId },
    clientId: input.req.clientId,
    authContext: {
      ...(input.req.nonce !== undefined ? { nonce: input.req.nonce } : {}),
      authTime: input.session.authTime,
      ...(input.session.acr ? { acr: input.session.acr } : {}),
      ...(input.session.amr ? { amr: input.session.amr } : {}),
      sid: input.sessionId,
    },
    scope: input.req.scope,
    now: input.now,
    ttlSec: resolveAccessTtlSec(ctx, input.client.accessTokenTtlSec),
    cHash,
  })
  return signClaims(ctx, signer.privateKey, claims)
}

async function resolveAuthorizationDetails(
  c: Context<XidHonoEnv>,
  params: RawParams,
): Promise<Result<ResolvedAuthorizationDetails, XidError>> {
  const parsed = await parseAuthorizationDetails(c, params['authorization_details'])
  if (!parsed.ok) return parsed
  return {
    ok: true,
    value: {
      details: parsed.value,
      resources: authorizationDetailsResources(parsed.value),
      scopes: authorizationDetailsScopes(parsed.value),
    },
  }
}

function mergeAuthorizationDetailsScopes(scope: string, detailsScopes: readonly string[]): string {
  const merged = new Set(scope.split(' ').filter(Boolean))
  for (const item of detailsScopes) merged.add(item)
  return [...merged].join(' ')
}

function boundResources(params: RawParams, detailResources: readonly string[]): string[] | null {
  const resources = new Set<string>()
  const requestedResource = params['resource']
  if (requestedResource) resources.add(requestedResource)
  for (const resource of detailResources) resources.add(resource)
  return resources.size === 0 ? null : [...resources]
}

// 错误回跳(redirect_error,10.7):error 作为参数,带回 state。
async function emitRedirectError(
  c: Context<XidHonoEnv>,
  input: {
    redirectUri: string
    responseType: string
    responseMode?: string
    clientId: string
    error: string
    description: string
    state?: string
  },
): Promise<Response> {
  const ctx = c.get('tenant')
  const mode = resolveResponseMode(input.responseMode, input.responseType)
  const out: RawParams = {
    error: input.error,
    error_description: input.description,
    iss: ctx.issuer,
  }
  if (input.state !== undefined) out['state'] = input.state
  if (mode === 'query.jwt' || mode === 'fragment.jwt') {
    const signer = await loadActiveSigner(ctx, c.env.KEK)
    const response = await signAuthorizationResponseJwt({
      ctx,
      signer,
      clientId: input.clientId,
      params: out,
      now: Math.floor(Date.now() / 1000),
    })
    return respondToRp(c, { redirectUri: input.redirectUri, mode, params: { response } })
  }
  return respondToRp(c, { redirectUri: input.redirectUri, mode, params: out })
}

// 主 handler:PAR 替换 -> 查 client -> evaluateAuthorize -> 按 directive 分发。
async function runAuthorize(c: Context<XidHonoEnv>, params: RawParams): Promise<Response> {
  const parResult = await resolvePar(c, params)
  if (!parResult.ok) {
    return localErrorPage(c, parResult.error, parResult.description, parResult.status)
  }
  const effective = parResult.params
  if (!responseModeSupported(effective)) {
    return localErrorPage(c, 'invalid_request', 'response_mode is not supported')
  }

  const req = toAuthorizeRequest(effective)
  const client = await findClient(c, req.clientId)
  if (!client) return localErrorPage(c, 'invalid_request', 'unknown client_id')
  if (clientRequiresFapi(client) && !effective['code_challenge']) {
    return localErrorPage(c, 'invalid_request', 'FAPI client requires PKCE code_challenge')
  }
  if (
    clientRequiresFapi(client) &&
    effective['code_challenge_method'] &&
    effective['code_challenge_method'] !== 'S256'
  ) {
    return localErrorPage(c, 'invalid_request', 'FAPI client requires PKCE S256')
  }
  if (clientRequiresFapi(client) && !params['request_uri']) {
    return localErrorPage(c, 'invalid_request', 'FAPI client requires PAR request_uri')
  }
  if (clientRequiresBba(client) && client.clientType !== 'public') {
    return localErrorPage(c, 'invalid_request', 'BBA profile requires a public client')
  }
  if (clientRequiresBba(client) && !effective['code_challenge']) {
    return localErrorPage(c, 'invalid_request', 'BBA client requires PKCE code_challenge')
  }
  if (
    clientRequiresBba(client) &&
    effective['code_challenge_method'] &&
    effective['code_challenge_method'] !== 'S256'
  ) {
    return localErrorPage(c, 'invalid_request', 'BBA client requires PKCE S256')
  }
  const requestObject = await resolveRequestObject({
    c,
    params: effective,
    client,
    now: Math.floor(Date.now() / 1000),
  })
  if (!requestObject.ok) {
    return localErrorPage(c, requestObject.error, requestObject.description)
  }
  const resolved = requestObject.params
  if (!responseModeSupported(resolved)) {
    return localErrorPage(c, 'invalid_request', 'response_mode is not supported')
  }
  const authorizationDetails = await resolveAuthorizationDetails(c, resolved)
  if (!authorizationDetails.ok) {
    return localErrorPage(c, authorizationDetails.error.code, authorizationDetails.error.message)
  }
  const resolvedReq = toAuthorizeRequest(resolved)
  const requestedScope = mergeAuthorizationDetailsScopes(
    resolvedReq.scope,
    authorizationDetails.value.scopes,
  )
  resolvedReq.scope = requestedScope
  resolved['scope'] = requestedScope
  const registration = toClientRegistration(client)

  const session = c.get('session')
  // pending 会话(pending_mfa/pending_mfa_setup)不是完整认证:MFA 门控在登录链路和此处必须
  // 双重强制,否则持密码不过第二因子即可走完授权码流程。先 stash 续跑参数,重定向完成
  // MFA 挑战/绑定(session 升 active)后回 /authorize 续跑。prompt=none 不可弹交互,
  // 不拦截,按未认证走 login_required 回跳。
  if (session && session.status !== ACTIVE_SESSION_STATUS && !promptIncludesNone(resolvedReq)) {
    return stashAndRedirect(c, {
      params: resolved,
      path: session.status === PENDING_MFA_SETUP_SESSION_STATUS ? '/account/security' : '/mfa',
      selectAccount: false,
      stepUp: false,
    })
  }
  const sessionState = {
    authenticated: session !== null && session.status === ACTIVE_SESSION_STATUS,
    authTime: session ? Math.floor(session.authenticatedAt.getTime() / 1000) : null,
  }
  const consentGranted = session
    ? authorizationDetails.value.details.length === 0 &&
      (await checkConsent(c, session.userId, resolvedReq.clientId, resolvedReq.scope))
    : false

  const directive = evaluateAuthorize({
    req: resolvedReq,
    client: registration,
    session: sessionState,
    consent: { scopeAlreadyGranted: consentGranted },
    now: Math.floor(Date.now() / 1000),
  })

  return dispatchDirective(c, {
    directive,
    req: resolvedReq,
    client,
    effective: resolved,
    session,
    authorizationDetails: authorizationDetails.value,
  })
}

// 主 handler:恢复登录前暂存的 authorize 请求,或按当前 query 直接运行。
async function handleAuthorize(c: Context<XidHonoEnv>): Promise<Response> {
  const url = new URL(c.req.url)
  const authzRequestId = url.searchParams.get('authz_request_id')
  if (authzRequestId) {
    if (!c.get('session')) return redirectToStashedSignIn(c, authzRequestId)
    const pending = await consumeStashedAuthorize(c, authzRequestId)
    if (!pending) {
      return localErrorPage(c, 'invalid_request', 'authorization request expired or not found')
    }
    return runAuthorize(c, pending)
  }

  const params = Object.fromEntries(url.searchParams) as RawParams
  return runAuthorize(c, params)
}

// directive 分发(local_error 渲染本地;其余按 10.2 处理)。
function dispatchDirective(
  c: Context<XidHonoEnv>,
  input: {
    directive: ReturnType<typeof evaluateAuthorize>
    req: AuthorizeRequest
    client: ClientRow
    effective: RawParams
    session: SessionData | null
    authorizationDetails: ResolvedAuthorizationDetails
  },
): Response | Promise<Response> {
  const { directive, req, client, effective, session, authorizationDetails } = input
  switch (directive.kind) {
    case 'local_error':
      return localErrorPage(c, directive.error.code, directive.error.message)
    case 'redirect_error':
      return emitRedirectError(c, {
        redirectUri: req.redirectUri,
        responseType: req.responseType,
        responseMode: effective['response_mode'],
        clientId: req.clientId,
        error: directive.error.code,
        description: directive.error.message,
        state: directive.state,
      })
    case 'need_login':
      return stashAndRedirect(c, {
        params: effective,
        path: '/sign-in',
        selectAccount: directive.selectAccount,
      })
    case 'need_consent':
      return redirectOrConsent(c, { req, client, effective, session, authorizationDetails })
    case 'emit_code':
      return redirectOrEmitCode(c, { req, client, effective, session, authorizationDetails })
  }
}

function scopeRequiresOrganization(scope: string): boolean {
  return scope.split(/\s+/).filter(Boolean).includes('organization')
}

async function listActiveOrgIds(c: Context<XidHonoEnv>, userId: string): Promise<string[]> {
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const membershipFilter = and(
    eq(schema.memberships.userId, userId),
    eq(schema.memberships.status, 'active'),
  )
  const activeOrgIds: string[] = []
  let cursor: string | null = null

  while (activeOrgIds.length < 2) {
    const rows = await db.memberships.findMany(
      cursor ? and(membershipFilter, gt(schema.memberships.id, cursor)) : membershipFilter,
      { orderBy: asc(schema.memberships.id), limit: ACTIVE_ORG_LOOKUP_BATCH_SIZE },
    )
    if (rows.length === 0) break

    const orgIds = [...new Set(rows.map((row) => row.orgId))]
    const organizations = await db.organizations.findMany(
      and(
        inArray(schema.organizations.id, orgIds),
        eq(schema.organizations.status, 'active'),
        isNull(schema.organizations.deletedAt),
      ),
      { limit: orgIds.length },
    )
    const activeIds = new Set(organizations.map((organization) => organization.id))
    for (const row of rows) {
      if (!activeIds.has(row.orgId) || activeOrgIds.includes(row.orgId)) continue
      activeOrgIds.push(row.orgId)
      if (activeOrgIds.length === 2) break
    }

    if (rows.length < ACTIVE_ORG_LOOKUP_BATCH_SIZE) break
    const last = rows[rows.length - 1]
    if (!last || last.id === cursor) break
    cursor = last.id
  }

  return activeOrgIds
}

async function maybeRedirectToOrgSelection(
  c: Context<XidHonoEnv>,
  input: {
    req: AuthorizeRequest
    client: ClientRow
    effective: RawParams
    session: SessionData
  },
): Promise<Response | null> {
  if (input.session.activeOrgId) return null
  const needsOrgContext =
    Boolean(input.client.requireOrgContext) || scopeRequiresOrganization(input.req.scope)
  if (!needsOrgContext) return null
  const activeOrgIds = await listActiveOrgIds(c, input.session.userId)
  if (activeOrgIds.length === 1) {
    const soleOrgId = activeOrgIds[0]
    if (!soleOrgId) return null
    const db = createTenantDb(c.env.DB, c.get('tenant'))
    await db.sessions.update(
      { activeOrgId: soleOrgId },
      eq(schema.sessions.id, input.session.sessionId),
    )
    input.session.activeOrgId = soleOrgId
    c.set('session', { ...input.session, activeOrgId: soleOrgId })
    return null
  }
  if (activeOrgIds.length <= 1) return null
  return stashAndRedirect(c, {
    params: input.effective,
    path: '/select-organization',
    selectAccount: false,
  })
}

async function resolveRedirectableRbac(
  c: Context<XidHonoEnv>,
  input: {
    req: AuthorizeRequest
    client: ClientRow
    effective: RawParams
    session: SessionData | null
  },
): Promise<AuthorizeRbacContext | Response> {
  if (!input.session) {
    return localErrorPage(c, 'server_error', 'session lost before authorization completion')
  }
  const rbac = await resolveAuthorizeRbacContext(c, {
    client: input.client,
    session: input.session,
  })
  if (rbac.ok) return rbac.value
  return emitRedirectError(c, {
    redirectUri: input.req.redirectUri,
    responseType: input.req.responseType,
    responseMode: input.effective['response_mode'],
    clientId: input.req.clientId,
    error: rbac.error.code,
    description: rbac.error.message,
    state: input.req.state,
  })
}

async function redirectOrConsent(
  c: Context<XidHonoEnv>,
  input: {
    req: AuthorizeRequest
    client: ClientRow
    effective: RawParams
    session: SessionData | null
    authorizationDetails: ResolvedAuthorizationDetails
  },
): Promise<Response> {
  if (!input.session) {
    return localErrorPage(c, 'server_error', 'session lost before consent completion')
  }
  const orgSelection = await maybeRedirectToOrgSelection(c, {
    req: input.req,
    client: input.client,
    effective: input.effective,
    session: input.session,
  })
  if (orgSelection) return orgSelection
  const rbac = await resolveRedirectableRbac(c, input)
  if (rbac instanceof Response) return rbac
  const acrContext = await resolveAcrContext(c, {
    req: input.req,
    effective: input.effective,
    session: input.session,
  })
  if (acrContext instanceof Response) return acrContext
  return stashAndRedirect(c, { params: input.effective, path: '/consent', selectAccount: false })
}

async function redirectOrEmitCode(
  c: Context<XidHonoEnv>,
  input: {
    req: AuthorizeRequest
    client: ClientRow
    effective: RawParams
    session: SessionData | null
    authorizationDetails: ResolvedAuthorizationDetails
  },
): Promise<Response> {
  if (!input.session) {
    return localErrorPage(c, 'server_error', 'session lost before code emission')
  }
  const orgSelection = await maybeRedirectToOrgSelection(c, {
    req: input.req,
    client: input.client,
    effective: input.effective,
    session: input.session,
  })
  if (orgSelection) return orgSelection
  const rbac = await resolveRedirectableRbac(c, input)
  if (rbac instanceof Response) return rbac
  const acrContext = await resolveAcrContext(c, {
    req: input.req,
    effective: input.effective,
    session: input.session,
  })
  if (acrContext instanceof Response) return acrContext
  if (acrContext.clearStepUp) clearStepUpCookie(c)
  const response = await emitCode(c, {
    req: input.req,
    client: input.client,
    userId: input.session.userId,
    sessionId: input.session.sessionId,
    session: acrContext,
    params: input.effective,
    rbac,
    authorizationDetails: input.authorizationDetails,
  })
  return response
}

// 注册 /authorize 路由(wire 阶段统一挂载)。
export function registerAuthorizeRoutes(app: Hono<XidHonoEnv>): void {
  app.get('/authorize', handleAuthorize)
}
