// Social OAuth(RP):state/nonce/PKCE 存 OAuthFlowDO 一次性消费;linking 见 social-linking.ts。
// 浏览器顶层导航端点:预期失败与 provider 取消都回 /sign-in?error=<不透明码>。

import {
  createTenantDb,
  resolveTenantContextByApplicationClientId,
  resolveTenantContextById,
} from '@xid-kit/db'
import { defaultLandingPathFor } from '@xid-kit/types'
import { Hono } from 'hono'
import type { Context } from 'hono'
import * as v from 'valibot'
import { AppError } from '../lib/errors'
import { createPersistedId } from '../lib/persisted-id'
import type { TenantVar, XidHonoEnv } from '../lib/types'
import { issueSession } from '../lib/session'
import { validateQuery } from '../lib/validate'
import { SOCIAL_AUTH_CONTEXT } from '../lib/auth-context'
import { isDevOrTestEnvironment } from '../test-harness/dev-gate'
import { resolvePostAuthMfaGate } from '../lib/mfa-session'
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
import {
  assertPublicProviderEndpoints,
  exchangeCode,
  getProviderConfig,
  hasProviderSecret,
} from './social-providers'
import type { Provider, ProviderProfile, TokenResponse } from './social-providers'
import { resolveProfile } from './social-profile'
import { assertSocialProviderAllowed } from './hosted-policy'
import { auditPolicyDeniedError } from './hosted-audit'
import {
  isInstanceEntryContext,
  loginHintCandidates,
  resolveEntryTenant,
  withTenant,
} from '../me-auth/instance-login'
import { requestIp, verifyTurnstile } from '../me-auth/shared'
import { shouldSkipDefaultMembership } from '../me-auth/passwordless-users'
import { resolveHostedAuthFlow } from '../../shared/hosted-auth-continuation'
import { linkOrCreateUser } from './social-linking'

// callback 输入形状:code/state/error 均为可选字符串(Apple form_post 的 File 值视为缺失,见 readCallbackParams)。
const callbackParamsSchema = v.object({
  code: v.optional(v.string()),
  state: v.optional(v.string()),
  error: v.optional(v.string()),
})

// :provider param 只做形状收窄(非空 + 限长),不用 picklist 限内置表:
// 自定义 provider key 是合法特性(social-providers.ts Provider=string),未配置由 getProviderConfig 判 400。
const providerParamSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(128))

function parseProviderParam(c: Context<XidHonoEnv>): Provider {
  const result = v.safeParse(providerParamSchema, c.req.param('provider'))
  if (!result.success) throw new AppError('invalid_request')
  return result.output
}

type OAuthFlowPayload = {
  tenantId: string
  provider: Provider
  codeVerifier: string
  nonce: string
  redirectAfterLogin: string
  returnToOrigin: string
  createdAt: number
  intent?: string
  applicationClientId?: string
  skipDefaultMembership?: boolean
}

const FLOW_PREFIX = 'state'

function parseOAuthFlow(record: FederatedFlowRecord): OAuthFlowPayload {
  const intent = optionalFlowString(record, 'intent')
  const applicationClientId = optionalFlowString(record, 'applicationClientId')
  const skipDefaultMembership = optionalFlowBoolean(record, 'skipDefaultMembership')
  const flow: OAuthFlowPayload = {
    tenantId: requiredFlowString(record, 'tenantId'),
    provider: requiredFlowString(record, 'provider'),
    codeVerifier: requiredFlowString(record, 'codeVerifier'),
    nonce: requiredFlowString(record, 'nonce'),
    redirectAfterLogin: requiredFlowString(record, 'redirectAfterLogin'),
    returnToOrigin: requiredFlowString(record, 'returnToOrigin'),
    createdAt: requiredFlowNumber(record, 'createdAt'),
    ...(intent === undefined ? {} : { intent }),
    ...(applicationClientId === undefined ? {} : { applicationClientId }),
    ...(skipDefaultMembership === undefined ? {} : { skipDefaultMembership }),
  }
  assertNoInvitationInFlow(record, flow.redirectAfterLogin)
  return flow
}

async function consumeOAuthFlow(env: Env, state: string): Promise<OAuthFlowPayload | null> {
  const record = await consumeFederatedFlow(env, { prefix: FLOW_PREFIX, state })
  return record ? parseOAuthFlow(record) : null
}

function flowReturnContext(flow: OAuthFlowPayload | null): SignInReturnContext {
  if (!flow) return {}
  return {
    continuePath: flow.redirectAfterLogin,
    applicationClientId: flow.applicationClientId ?? null,
    intent: flow.intent ?? null,
  }
}

function requestReturnContext(c: Context<XidHonoEnv>): SignInReturnContext {
  return {
    continuePath: c.req.query('continue') ?? null,
    applicationClientId: c.req.query('client_id')?.trim() || null,
    intent: c.req.query('intent') ?? null,
  }
}

const social = new Hono<XidHonoEnv>()

async function socialAuthorizeTenant(c: Context<XidHonoEnv>): Promise<TenantVar> {
  const current = c.get('tenant')
  const organizationId = c.req.query('organization_id')?.trim()
  const loginHint = c.req.query('login_hint')?.trim()
  const intent = c.req.query('intent') ?? null
  const applicationClientId = c.req.query('client_id') ?? null
  if (!isInstanceEntryContext(current) && !applicationClientId?.trim()) {
    return current
  }
  if (!loginHint && !organizationId && !intent && !applicationClientId) {
    return current
  }
  return resolveEntryTenant(c, loginHint ? loginHintCandidates(loginHint) : [], organizationId, {
    intent,
    applicationClientId,
  })
}

async function socialCallbackTenant(
  c: Context<XidHonoEnv>,
  flow: OAuthFlowPayload,
): Promise<TenantVar> {
  if (flow.applicationClientId) {
    const applicationTenant = await resolveTenantContextByApplicationClientId(
      c.req.raw,
      c.env,
      flow.applicationClientId,
    )
    if (!applicationTenant.ok || applicationTenant.value.tenantId !== flow.tenantId) {
      throw new AppError('cross_tenant_access_denied')
    }
    return applicationTenant.value
  }
  const current = c.get('tenant')
  if (current.tenantId === flow.tenantId) return current
  const result = await resolveTenantContextById(c.req.raw, c.env, flow.tenantId)
  if (!result.ok || result.value.tenant.tenantId !== flow.tenantId) {
    throw new AppError('cross_tenant_access_denied')
  }
  return result.value.tenant
}

async function assertProviderLoginAllowed(
  c: Context<XidHonoEnv>,
  tenant: TenantVar,
  provider: Provider,
): Promise<void> {
  try {
    assertSocialProviderAllowed({
      tenant,
      provider,
      action: 'login',
      email: null,
      emailVerified: true,
      hasSecret: (policy, providerName) => hasProviderSecret(c.env, policy, providerName),
    })
  } catch (error) {
    throw await auditPolicyDeniedError(c, error, {
      tenant,
      method: 'social',
      action: 'login',
      provider,
    })
  }
}

// GET /auth/{provider}/authorize -- 发起 OAuth 授权跳转
async function handleAuthorize(c: Context<XidHonoEnv>, provider: Provider): Promise<Response> {
  if (requestHasRawInvitationInput(c, ['redirect_uri', 'continue'])) {
    throw new AppError('invalid_request')
  }
  await verifyTurnstile(c.req.query('turnstile'), c.env, requestIp(c))
  const tenant = await socialAuthorizeTenant(c)

  const config = getProviderConfig(c.env, tenant, provider)
  if (!config) throw new AppError('invalid_request', { longMessage: 'provider_not_configured' })
  await assertProviderLoginAllowed(c, tenant, provider)
  try {
    // authorizationEndpoint 进 302 Location,必须 https + 公网(SSRF/open redirect 防护)。
    assertPublicProviderEndpoints(config, isDevOrTestEnvironment(c.env))
  } catch (error) {
    throw await auditPolicyDeniedError(c, error, {
      tenant,
      method: 'social',
      action: 'login',
      provider,
    })
  }

  const defaultLandingPath = defaultLandingPathFor(c.get('tenant'))
  const flowResolution = resolveHostedAuthFlow({
    intent: c.req.query('intent') ?? null,
    continuePath: c.req.query('redirect_uri') ?? c.req.query('continue') ?? defaultLandingPath,
    applicationClientId: c.req.query('client_id')?.trim() || null,
    defaultContinuePath: defaultLandingPath,
  })
  if (!flowResolution) throw new AppError('invalid_request')
  const skipDefaultMembership = shouldSkipDefaultMembership({
    redirectAfterLogin: flowResolution.continuePath,
    intent: flowResolution.intent,
  })

  const { state, nonce, codeVerifier, codeChallenge } = await newFederatedFlowSecrets()
  const returnToOrigin = new URL(c.req.url).origin
  await storeFederatedFlow(c.env, {
    prefix: FLOW_PREFIX,
    state,
    payload: {
      tenantId: tenant.tenantId,
      provider,
      codeVerifier,
      nonce,
      redirectAfterLogin: flowResolution.continuePath,
      returnToOrigin,
      createdAt: Date.now(),
      intent: flowResolution.intent ?? undefined,
      applicationClientId: flowResolution.applicationClientId ?? undefined,
      skipDefaultMembership,
    },
  })

  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: `${returnToOrigin}/auth/${provider}/callback`,
    response_type: 'code',
    scope: config.scopes.join(' '),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    nonce,
  })
  if (provider === 'apple') params.set('response_mode', 'form_post')

  return c.redirect(`${config.authorizationEndpoint}?${params}`)
}

social.get('/:provider/authorize', async (c) => {
  return withSignInErrorRedirect(c, {
    operation: 'social_authorize',
    context: () => requestReturnContext(c),
    run: () => handleAuthorize(c, parseProviderParam(c)),
  })
})

type CallbackParams = { code: string | null; state: string | null; error: string | null }

function toCallbackParams(input: Record<string, string | undefined>): CallbackParams {
  const params = validateQuery(callbackParamsSchema, input)
  return { code: params.code ?? null, state: params.state ?? null, error: params.error ?? null }
}

// Apple 用 form_post(POST body),多数 provider 用 GET query。统一取 code/state/error。
// FormData 值可能是 File(非字符串),形状守卫时视为缺失。
async function readCallbackParams(c: Context<XidHonoEnv>): Promise<CallbackParams> {
  if (c.req.method === 'POST') {
    const form = await c.req.formData()
    const raw: Record<string, string | undefined> = {}
    for (const key of ['code', 'state', 'error'] as const) {
      const value = form.get(key)
      if (typeof value === 'string') raw[key] = value
    }
    return toCallbackParams(raw)
  }
  return toCallbackParams({
    code: c.req.query('code'),
    state: c.req.query('state'),
    error: c.req.query('error'),
  })
}

// provider 回传 error(用户取消等):一次性消费 state 以恢复原 continue,再回登录页。
// 上游 error 字符串只决定 cancelled / sign_in_failed,原文不回显。
async function handleProviderError(
  c: Context<XidHonoEnv>,
  params: CallbackParams,
): Promise<Response> {
  const flow = params.state ? await consumeOAuthFlow(c.env, params.state) : null
  const error = params.error === 'access_denied' ? 'cancelled' : 'sign_in_failed'
  return redirectToSignInWithError(c, error, flowReturnContext(flow))
}

async function exchangeAndResolveProfile(input: {
  c: Context<XidHonoEnv>
  tenant: TenantVar
  provider: Provider
  flow: OAuthFlowPayload
  code: string
}): Promise<{ tokens: TokenResponse; profile: ProviderProfile; scopes: string[] }> {
  const { c, tenant, provider, flow, code } = input
  const config = getProviderConfig(c.env, tenant, provider)
  if (!config) throw new AppError('invalid_request')
  await assertProviderLoginAllowed(c, tenant, provider)
  try {
    const tokens = await exchangeCode({
      provider,
      config,
      redirectUri: `${flow.returnToOrigin}/auth/${provider}/callback`,
      codeVerifier: flow.codeVerifier,
      code,
      allowNonPublic: isDevOrTestEnvironment(c.env),
    })
    const profile = await resolveProfile({
      env: c.env,
      provider,
      config,
      tokens,
      nonce: flow.nonce,
    })
    return { tokens, profile, scopes: config.scopes }
  } catch (error) {
    throw await auditPolicyDeniedError(c, error, {
      tenant,
      method: 'social',
      action: 'login',
      provider,
    })
  }
}

// GET + POST /auth/{provider}/callback -- OAuth 回调处理(Apple 用 POST form_post)
async function handleCallback(
  c: Context<XidHonoEnv>,
  provider: Provider,
  onFlow: (flow: OAuthFlowPayload) => void,
): Promise<Response> {
  const params = await readCallbackParams(c)
  if (params.error) return handleProviderError(c, params)
  const { code, state } = params
  if (!state || !code) throw new AppError('invalid_request', { longMessage: STATE_INVALID })

  const flow = await consumeOAuthFlow(c.env, state)
  if (!flow || flow.provider !== provider) {
    throw new AppError('invalid_request', { longMessage: STATE_INVALID })
  }
  onFlow(flow)
  const tenant = await socialCallbackTenant(c, flow)
  if (flow.tenantId !== tenant.tenantId) throw new AppError('cross_tenant_access_denied')

  return withTenant(c, tenant, async () => {
    const { tokens, profile, scopes } = await exchangeAndResolveProfile({
      c,
      tenant,
      provider,
      flow,
      code,
    })
    const db = createTenantDb(c.env.DB, tenant)
    const userId = await linkOrCreateUser({
      c,
      tenant,
      db,
      provider,
      scopes,
      tokens,
      profile,
      skipDefaultMembership: flow.skipDefaultMembership ?? false,
    })

    const flowResolution = resolveHostedAuthFlow({
      intent: flow.intent,
      continuePath: flow.redirectAfterLogin,
      applicationClientId: flow.applicationClientId,
      defaultContinuePath: defaultLandingPathFor(tenant),
    })
    if (
      !flowResolution ||
      flowResolution.continuePath !== flow.redirectAfterLogin ||
      flowResolution.applicationClientId !== (flow.applicationClientId ?? null)
    ) {
      throw new AppError('invalid_request')
    }
    const location = flowResolution.continuePath
    const mfaGate = await resolvePostAuthMfaGate(c, tenant, {
      userId,
      returnPath: location,
      sessionAmr: SOCIAL_AUTH_CONTEXT.amr,
    })
    await issueSession(c, {
      sessionId: createPersistedId('session'),
      userId,
      ...(mfaGate.sessionStatus ? { status: mfaGate.sessionStatus } : {}),
      authContext: SOCIAL_AUTH_CONTEXT,
      authenticatedAt: new Date(),
      rememberMe: true,
      ip: c.req.header('cf-connecting-ip') ?? null,
      userAgent: c.req.header('user-agent') ?? null,
    })

    // session 走 cookie(issueSession 已设),绝不在 URL 携带 session_id。
    const target = mfaGate.redirectUrl ?? location
    return c.redirect(new URL(target, flow.returnToOrigin).toString(), 302)
  })
}

async function callbackRoute(c: Context<XidHonoEnv>): Promise<Response> {
  let consumedFlow: OAuthFlowPayload | null = null
  return withSignInErrorRedirect(c, {
    operation: 'social_callback',
    context: () => flowReturnContext(consumedFlow),
    run: () =>
      handleCallback(c, parseProviderParam(c), (flow) => {
        consumedFlow = flow
      }),
  })
}

social.get('/:provider/callback', callbackRoute)
social.post('/:provider/callback', callbackRoute)

export function registerSocialRoutes(app: Hono<XidHonoEnv>): void {
  app.route('/auth', social)
}
