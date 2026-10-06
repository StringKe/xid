// /authorize 端点(03 章 10):执行 protocol evaluateAuthorize 状态机,wire session/consent/PAR。
// 无 session -> 暂存参数到 OAuthFlowDO + 302 /sign-in;有 session -> consent 检查 -> 生成 code 写 D1。
// consent 页只记录决定并回到这里续跑,code 只由 emitCode 签发。
// 铁律:client/redirect_uri 精确匹配;PKCE 绑定;tenant 从 c.get('tenant'),consent 走租户查询层。

import {
  buildIdTokenClaims,
  evaluateAuthorize,
  generateAuthorizationCode,
  hasScope,
  leftHalfHash,
  signClaims,
} from '@xid-kit/protocol'
import type { AuthorizeRequest, ClientRegistration } from '@xid-kit/protocol'
import { createTenantDb, schema } from '@xid-kit/db'
import { and, eq } from 'drizzle-orm'
import type { Result, XidError } from '@xid-kit/types'
import type { Context, Hono } from 'hono'
import * as v from 'valibot'
import type { SessionData, XidHonoEnv } from '../lib/types'
import { clientRequiresBba, clientRequiresFapi } from './client-policy'
import { findClient, loadActiveSigner, resolveAccessTtlSec } from './shared'
import type { ClientRow } from './shared'
import {
  isJwtResponseMode,
  resolveResponseMode,
  respondToRp,
  signAuthorizationResponseJwt,
} from './authorize-respond'
import { resolvePar } from './par'
import {
  consumeStashedAuthorizeRecord,
  peekStashedAuthorizeRecord,
  restoreStashedAuthorizeRecord,
  type ConsentDecision,
  type StashedAuthorizeRecord,
} from './pending-params'
import { resolveRequestObject } from './request-object'
import {
  authorizationDetailsResources,
  authorizationDetailsScopes,
  parseAuthorizationDetails,
} from './authorization-details'
import type { AuthorizationDetails } from '@xid-kit/types'
import {
  ACR_AAL2,
  normalizeIssuedAcr,
  sessionSatisfiesAal2,
  UNSUPPORTED_ACR_AAL3,
} from '../lib/auth-context'
import { clearStepUpCookie, readStepUpAuthContext } from '../lib/step-up'
import { ACTIVE_SESSION_STATUS, PENDING_MFA_SETUP_SESSION_STATUS } from '../lib/session'
import { AUTH_CODE_TTL_SEC } from '../lib/ttl'
import { requestsAcr } from './requested-acr'
import {
  localErrorPage,
  promptValues,
  redirectToStashedSignIn,
  stashAndRedirect,
  stripSatisfiedFreshAuthentication,
  withoutPrompts,
  type RawParams,
} from './authorize-interaction'
import {
  listActiveOrgIds,
  resolveAuthorizeRbacContext,
  type AuthorizeRbacContext,
} from './authorize-org-context'

const SUPPORTED_RESPONSE_TYPES = ['code', 'code id_token'] as const
const SUPPORTED_RESPONSE_MODES = [
  'query',
  'fragment',
  'form_post',
  'query.jwt',
  'fragment.jwt',
] as const
const CONSENT_DENIED_DESCRIPTION = 'The user denied the authorization request.'

// 白名单收口到 picklist(收窄出 literal union);拒绝路径的错误码仍由
// localErrorPage / evaluateAuthorize 决定,schema 只做支持性判断。
const responseTypeSchema = v.picklist(SUPPORTED_RESPONSE_TYPES)
const responseModeSchema = v.picklist(SUPPORTED_RESPONSE_MODES)

type ResolvedAuthorizationDetails = {
  details: readonly AuthorizationDetails[]
  resources: readonly string[]
  scopes: readonly string[]
}

// viaPar:本请求经 PAR 到达(续跑时取暂存记录,不能从参数推断,因为 request_uri 已被替换)。
// consentDecision:当前会话在 consent 页做出的决定,只由 POST /auth/consent 写入暂存记录。
type AuthorizeFlow = {
  viaPar: boolean
  consentDecision: ConsentDecision['decision'] | null
}

type AuthorizeInput = {
  req: AuthorizeRequest
  client: ClientRow
  effective: RawParams
  session: SessionData | null
  authorizationDetails: ResolvedAuthorizationDetails
  flow: AuthorizeFlow
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

// consent 页本次批准覆盖暂存请求的 scope 与 authorization_details;否则按持久化授权判断,
// authorization_details 不持久化,未经本次批准一律需要 consent。
async function consentAlreadyGranted(
  c: Context<XidHonoEnv>,
  input: {
    session: SessionData | null
    req: AuthorizeRequest
    authorizationDetails: ResolvedAuthorizationDetails
    flow: AuthorizeFlow
  },
): Promise<boolean> {
  if (!input.session) return false
  if (input.flow.consentDecision === 'approved') return true
  if (input.authorizationDetails.details.length > 0) return false
  return checkConsent(c, input.session.userId, input.req.clientId, input.req.scope)
}

function promptIncludesNone(req: AuthorizeRequest): boolean {
  return req.prompt?.split(' ').filter(Boolean).includes('none') ?? false
}

function validXidIntent(params: RawParams): boolean {
  const intent = params['xid_intent']
  return intent === undefined || intent === 'sign-up'
}

function requestedAal2(req: AuthorizeRequest): boolean {
  return requestsAcr({ acrValues: req.acrValues, claims: req.claims }, ACR_AAL2)
}

function requestedAal3(req: AuthorizeRequest): boolean {
  return requestsAcr({ acrValues: req.acrValues, claims: req.claims }, UNSUPPORTED_ACR_AAL3)
}

async function resolveAcrContext(
  c: Context<XidHonoEnv>,
  input: { req: AuthorizeRequest; effective: RawParams; session: SessionData; flow: AuthorizeFlow },
): Promise<
  { authTime: number; acr: string | null; amr: SessionData['amr']; clearStepUp: boolean } | Response
> {
  const sessionContext = {
    authTime: Math.floor(input.session.authenticatedAt.getTime() / 1000),
    acr: normalizeIssuedAcr(input.session.acr),
    amr: input.session.amr,
    clearStepUp: false,
  }

  if (!requestedAal2(input.req)) return sessionContext
  if (sessionSatisfiesAal2(input.session)) return sessionContext
  const stepUpContext = await readStepUpAuthContext(c, input.session)
  if (stepUpContext) return { ...stepUpContext, clearStepUp: true }
  if (promptIncludesNone(input.req)) {
    return emitRedirectError(c, {
      req: input.req,
      responseMode: input.effective['response_mode'],
      error: 'interaction_required',
      description: 'additional authentication required for requested acr',
    })
  }
  return stashAndRedirect(c, {
    params: input.effective,
    path: '/mfa',
    viaPar: input.flow.viaPar,
    selectAccount: false,
    stepUp: true,
  })
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
  if (isJwtResponseMode(mode)) {
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
    req: AuthorizeRequest
    responseMode?: string
    error: string
    description: string
    state?: string
  },
): Promise<Response> {
  const ctx = c.get('tenant')
  const mode = resolveResponseMode(input.responseMode, input.req.responseType)
  const out: RawParams = {
    error: input.error,
    error_description: input.description,
    iss: ctx.issuer,
  }
  const state = 'state' in input ? input.state : input.req.state
  if (state !== undefined) out['state'] = state
  if (isJwtResponseMode(mode)) {
    const signer = await loadActiveSigner(ctx, c.env.KEK)
    const response = await signAuthorizationResponseJwt({
      ctx,
      signer,
      clientId: input.req.clientId,
      params: out,
      now: Math.floor(Date.now() / 1000),
    })
    return respondToRp(c, { redirectUri: input.req.redirectUri, mode, params: { response } })
  }
  return respondToRp(c, { redirectUri: input.req.redirectUri, mode, params: out })
}

// FAPI / BBA profile 前置检查;不通过时返回本地错误页。
function checkClientProfile(
  c: Context<XidHonoEnv>,
  input: { client: ClientRow; effective: RawParams; viaPar: boolean },
): Promise<Response> | null {
  const { client, effective } = input
  const challenge = effective['code_challenge']
  const nonS256 =
    effective['code_challenge_method'] !== undefined &&
    effective['code_challenge_method'] !== 'S256'
  if (clientRequiresFapi(client)) {
    if (!challenge) {
      return localErrorPage(c, 'invalid_request', 'FAPI client requires PKCE code_challenge')
    }
    if (nonS256) return localErrorPage(c, 'invalid_request', 'FAPI client requires PKCE S256')
    if (!input.viaPar) {
      return localErrorPage(c, 'invalid_request', 'FAPI client requires PAR request_uri')
    }
  }
  if (clientRequiresBba(client)) {
    if (client.clientType !== 'public') {
      return localErrorPage(c, 'invalid_request', 'BBA profile requires a public client')
    }
    if (!challenge) {
      return localErrorPage(c, 'invalid_request', 'BBA client requires PKCE code_challenge')
    }
    if (nonS256) return localErrorPage(c, 'invalid_request', 'BBA client requires PKCE S256')
  }
  return null
}

// 主 handler:PAR 替换 -> 查 client -> evaluateAuthorize -> 按 directive 分发。
async function runAuthorize(
  c: Context<XidHonoEnv>,
  params: RawParams,
  options: AuthorizeFlow,
): Promise<Response> {
  const parResult = await resolvePar(c, params)
  if (!parResult.ok) {
    return localErrorPage(c, parResult.error, parResult.description, parResult.status)
  }
  const flow: AuthorizeFlow = {
    ...options,
    viaPar: options.viaPar || params['request_uri'] !== undefined,
  }
  const effective = parResult.params
  if (!responseModeSupported(effective)) {
    return localErrorPage(c, 'invalid_request', 'response_mode is not supported')
  }

  const client = await findClient(c, toAuthorizeRequest(effective).clientId)
  if (!client) return localErrorPage(c, 'invalid_request', 'unknown client_id')
  const profileError = checkClientProfile(c, { client, effective, viaPar: flow.viaPar })
  if (profileError) return profileError
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
  if (!validXidIntent(resolved)) {
    return localErrorPage(c, 'invalid_request', 'xid_intent is not supported')
  }
  if (resolved['xid_intent'] === 'sign-up' && promptValues(resolved).includes('none')) {
    return localErrorPage(c, 'invalid_request', 'xid_intent=sign-up requires user interaction')
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
  return evaluateWithSession(c, {
    req: resolvedReq,
    client,
    effective: resolved,
    session: c.get('session'),
    authorizationDetails: authorizationDetails.value,
    flow,
  })
}

async function evaluateWithSession(
  c: Context<XidHonoEnv>,
  input: AuthorizeInput,
): Promise<Response> {
  const { req, effective, session, flow } = input
  if (session?.status === ACTIVE_SESSION_STATUS && effective['xid_intent'] === 'sign-up') {
    return stashAndRedirect(c, {
      params: effective,
      path: '/sign-in',
      viaPar: flow.viaPar,
      selectAccount: false,
    })
  }
  // pending 会话(pending_mfa/pending_mfa_setup)不是完整认证:MFA 门控在登录链路和此处必须
  // 双重强制,否则持密码不过第二因子即可走完授权码流程。先 stash 续跑参数,重定向完成
  // MFA 挑战/绑定(session 升 active)后回 /authorize 续跑。prompt=none 不可弹交互,
  // 不拦截,按未认证走 login_required 回跳。
  if (session && session.status !== ACTIVE_SESSION_STATUS && !promptIncludesNone(req)) {
    return stashAndRedirect(c, {
      params: effective,
      path: session.status === PENDING_MFA_SETUP_SESSION_STATUS ? '/account/security' : '/mfa',
      viaPar: flow.viaPar,
      selectAccount: false,
      stepUp: false,
    })
  }
  const directive = evaluateAuthorize({
    req,
    client: toClientRegistration(input.client),
    session: {
      authenticated: session !== null && session.status === ACTIVE_SESSION_STATUS,
      authTime: session ? Math.floor(session.authenticatedAt.getTime() / 1000) : null,
    },
    consent: { scopeAlreadyGranted: await consentAlreadyGranted(c, input) },
    now: Math.floor(Date.now() / 1000),
  })
  return dispatchDirective(c, { ...input, directive })
}

// 续跑 consent 决定只对做出决定的同一会话有效;会话换了按未决定处理。
function consentDecisionFor(
  record: StashedAuthorizeRecord,
  session: SessionData,
): AuthorizeFlow['consentDecision'] {
  const decision = record.consentDecision
  if (!decision) return null
  if (decision.userId !== session.userId || decision.sessionId !== session.sessionId) return null
  return decision.decision
}

async function resumeAuthorize(
  c: Context<XidHonoEnv>,
  input: { authzRequestId: string; queryClientId: string | null },
): Promise<Response> {
  const tenantId = c.get('tenant').tenantId
  const session = c.get('session')
  if (!session) {
    const pending = await peekStashedAuthorizeRecord(c.env, tenantId, input.authzRequestId)
    if (!pending) {
      return localErrorPage(c, 'invalid_request', 'authorization request expired or not found')
    }
    return redirectToStashedSignIn(c, input.authzRequestId, pending)
  }
  const record = await consumeStashedAuthorizeRecord(c.env, tenantId, input.authzRequestId)
  if (!record) {
    return localErrorPage(c, 'invalid_request', 'authorization request expired or not found')
  }
  if (input.queryClientId && record.params['client_id'] !== input.queryClientId) {
    return localErrorPage(c, 'invalid_request', 'authorization request client mismatch')
  }
  let pending = record.params
  if (record.interactionStartedAt !== null) {
    if (session.authenticatedAt.getTime() < record.interactionStartedAt) {
      await restoreStashedAuthorizeRecord(c.env, tenantId, input.authzRequestId, record)
      return redirectToStashedSignIn(c, input.authzRequestId, record)
    }
    pending = stripSatisfiedFreshAuthentication(pending)
  }
  const consentDecision = consentDecisionFor(record, session)
  if (consentDecision === 'approved') pending = withoutPrompts(pending, ['consent'])
  return runAuthorize(c, pending, { viaPar: record.viaPar, consentDecision })
}

// 主 handler:恢复交互前暂存的 authorize 请求,或按当前 query 直接运行。
async function handleAuthorize(c: Context<XidHonoEnv>): Promise<Response> {
  const url = new URL(c.req.url)
  const authzRequestIds = url.searchParams.getAll('authz_request_id')
  const clientIds = url.searchParams.getAll('client_id')
  if (authzRequestIds.length > 1 || clientIds.length > 1) {
    return localErrorPage(c, 'invalid_request', 'duplicate authorization request parameter')
  }
  const authzRequestId = authzRequestIds[0] ?? null
  if (authzRequestId) {
    return resumeAuthorize(c, { authzRequestId, queryClientId: clientIds[0] ?? null })
  }

  const seen = new Set<string>()
  for (const key of url.searchParams.keys()) {
    if (seen.has(key)) {
      return localErrorPage(c, 'invalid_request', 'duplicate authorization request parameter')
    }
    seen.add(key)
  }
  const params = Object.fromEntries(url.searchParams) as RawParams
  return runAuthorize(c, params, { viaPar: false, consentDecision: null })
}

// directive 分发(local_error 渲染本地;其余按 10.2 处理)。
function dispatchDirective(
  c: Context<XidHonoEnv>,
  input: AuthorizeInput & { directive: ReturnType<typeof evaluateAuthorize> },
): Response | Promise<Response> {
  const { directive, req, effective, flow } = input
  if (
    requestedAal3(req) &&
    directive.kind !== 'local_error' &&
    directive.kind !== 'redirect_error'
  ) {
    return emitRedirectError(c, {
      req,
      responseMode: effective['response_mode'],
      error: 'interaction_required',
      description:
        'requested acr urn:xid:aal3 is not supported; maximum supported assurance is urn:xid:aal2',
    })
  }
  switch (directive.kind) {
    case 'local_error':
      return localErrorPage(c, directive.error.code, directive.error.message)
    case 'redirect_error':
      return emitRedirectError(c, {
        req,
        responseMode: effective['response_mode'],
        error: directive.error.code,
        description: directive.error.message,
        state: directive.state,
      })
    case 'need_login':
      return stashAndRedirect(c, {
        params: effective,
        path: '/sign-in',
        viaPar: flow.viaPar,
        selectAccount: directive.selectAccount,
        freshAuthentication: directive.freshAuthentication,
      })
    case 'need_consent':
    case 'emit_code':
      if (flow.consentDecision === 'denied') {
        return emitRedirectError(c, {
          req,
          responseMode: effective['response_mode'],
          error: 'access_denied',
          description: CONSENT_DENIED_DESCRIPTION,
        })
      }
      return directive.kind === 'need_consent'
        ? redirectOrConsent(c, input)
        : redirectOrEmitCode(c, input)
  }
}

function scopeRequiresOrganization(scope: string): boolean {
  return hasScope(scope, 'organization')
}

async function maybeRedirectToOrgSelection(
  c: Context<XidHonoEnv>,
  input: AuthorizeInput & { session: SessionData },
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
    viaPar: input.flow.viaPar,
    selectAccount: false,
  })
}

async function resolveRedirectableRbac(
  c: Context<XidHonoEnv>,
  input: AuthorizeInput & { session: SessionData },
): Promise<AuthorizeRbacContext | Response> {
  const rbac = await resolveAuthorizeRbacContext(c, {
    client: input.client,
    session: input.session,
  })
  if (rbac.ok) return rbac.value
  return emitRedirectError(c, {
    req: input.req,
    responseMode: input.effective['response_mode'],
    error: rbac.error.code,
    description: rbac.error.message,
  })
}

// 选组织、RBAC、acr 在 consent 前后两次执行:consent 前保证不会对注定失败的请求弹 consent,
// 续跑后由 emitCode 前再执行一次,取当时的会话与授权状态。
async function prepareAuthorizedSession(
  c: Context<XidHonoEnv>,
  input: AuthorizeInput,
): Promise<
  | Response
  | {
      session: SessionData
      rbac: AuthorizeRbacContext
      acr: Exclude<Awaited<ReturnType<typeof resolveAcrContext>>, Response>
    }
> {
  if (!input.session) {
    return localErrorPage(c, 'server_error', 'session lost before authorization completion')
  }
  const withSession = { ...input, session: input.session }
  const orgSelection = await maybeRedirectToOrgSelection(c, withSession)
  if (orgSelection) return orgSelection
  const rbac = await resolveRedirectableRbac(c, withSession)
  if (rbac instanceof Response) return rbac
  const acr = await resolveAcrContext(c, withSession)
  if (acr instanceof Response) return acr
  return { session: withSession.session, rbac, acr }
}

async function redirectOrConsent(c: Context<XidHonoEnv>, input: AuthorizeInput): Promise<Response> {
  const prepared = await prepareAuthorizedSession(c, input)
  if (prepared instanceof Response) return prepared
  return stashAndRedirect(c, {
    params: input.effective,
    path: '/consent',
    viaPar: input.flow.viaPar,
    selectAccount: false,
  })
}

async function redirectOrEmitCode(
  c: Context<XidHonoEnv>,
  input: AuthorizeInput,
): Promise<Response> {
  const prepared = await prepareAuthorizedSession(c, input)
  if (prepared instanceof Response) return prepared
  if (prepared.acr.clearStepUp) clearStepUpCookie(c)
  return emitCode(c, {
    req: input.req,
    client: input.client,
    userId: prepared.session.userId,
    sessionId: prepared.session.sessionId,
    session: prepared.acr,
    params: input.effective,
    rbac: prepared.rbac,
    authorizationDetails: input.authorizationDetails,
  })
}

// 注册 /authorize 路由(wire 阶段统一挂载)。
export function registerAuthorizeRoutes(app: Hono<XidHonoEnv>): void {
  app.get('/authorize', handleAuthorize)
}
