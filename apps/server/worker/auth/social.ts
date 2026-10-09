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
import { SOCIAL_AUTH_CONTEXT } from '../lib/auth-context'
import { isDevOrTestEnvironment } from '../test-harness/dev-gate'
import { resolvePostAuthMfaGate } from '../lib/mfa-session'
import {
  STATE_INVALID,
  redirectToSignInWithError,
  withSignInErrorRedirect,
} from '../lib/federated-flow'
import type { SignInReturnContext } from '../lib/federated-flow'
import { withTenant } from '../me-auth/instance-login'
import { resolveHostedAuthFlow } from '../../shared/hosted-auth-continuation'
import { auditPolicyDeniedError } from './hosted-audit'
import { assertProviderLoginAllowed, handleSocialAuthorize } from './social-authorize'
import { readCallbackParams } from './social-callback-params'
import type { CallbackParams } from './social-callback-params'
import { consumeOAuthFlow, flowReturnContext } from './social-flow'
import type { OAuthFlowPayload } from './social-flow'
import { completeSocialLink, redirectToSocialLinkResult } from './social-link'
import { linkOrCreateUser } from './social-linking'
import { resolveProfile } from './social-profile'
import { exchangeCode, getProviderConfig } from './social-providers'
import type { Provider, ProviderProfile, TokenResponse } from './social-providers'

// :provider param 只做形状收窄(非空 + 限长),不用 picklist 限内置表:
// 自定义 provider key 是合法特性(social-providers.ts Provider=string),未配置由 getProviderConfig 判 400。
const providerParamSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(128))

function parseProviderParam(c: Context<XidHonoEnv>): Provider {
  const result = v.safeParse(providerParamSchema, c.req.param('provider'))
  if (!result.success) throw new AppError('invalid_request')
  return result.output
}

function requestReturnContext(c: Context<XidHonoEnv>): SignInReturnContext {
  return {
    continuePath: c.req.query('continue') ?? null,
    applicationClientId: c.req.query('client_id')?.trim() || null,
    intent: c.req.query('intent') ?? null,
  }
}

const social = new Hono<XidHonoEnv>()

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

social.get('/:provider/authorize', async (c) => {
  return withSignInErrorRedirect(c, {
    operation: 'social_authorize',
    context: () => requestReturnContext(c),
    run: () => handleSocialAuthorize(c, parseProviderParam(c)),
  })
})

// provider 回传 error(用户取消等):一次性消费 state 以恢复原 continue,再回登录页。
// 上游 error 字符串只决定 cancelled / sign_in_failed,原文不回显。
async function handleProviderError(
  c: Context<XidHonoEnv>,
  input: { provider: Provider; params: CallbackParams },
): Promise<Response> {
  const { provider, params } = input
  const flow = params.state ? await consumeOAuthFlow(c.env, params.state) : null
  if (flow?.link && flow.provider === provider) {
    return redirectToSocialLinkResult(c, {
      provider,
      error: params.error === 'access_denied' ? 'cancelled' : 'failed',
    })
  }
  const error = params.error === 'access_denied' ? 'cancelled' : 'sign_in_failed'
  return redirectToSignInWithError(
    c,
    error,
    flowReturnContext(flow?.provider === provider ? flow : null),
  )
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

async function signInLinkedUser(input: {
  c: Context<XidHonoEnv>
  tenant: TenantVar
  provider: Provider
  flow: OAuthFlowPayload
  code: string
}): Promise<Response> {
  const { c, tenant, provider, flow } = input
  const { tokens, profile, scopes } = await exchangeAndResolveProfile(input)
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
}

// GET + POST /auth/{provider}/callback -- OAuth 回调处理(Apple 用 POST form_post)
async function handleCallback(
  c: Context<XidHonoEnv>,
  provider: Provider,
  onFlow: (flow: OAuthFlowPayload) => void,
): Promise<Response> {
  const params = await readCallbackParams(c)
  if (params.error) return handleProviderError(c, { provider, params })
  const { code, state } = params
  if (!state || !code) throw new AppError('invalid_request', { longMessage: STATE_INVALID })

  const flow = await consumeOAuthFlow(c.env, state)
  if (!flow || flow.provider !== provider) {
    throw new AppError('invalid_request', { longMessage: STATE_INVALID })
  }
  onFlow(flow)
  const tenant = await socialCallbackTenant(c, flow)
  if (flow.tenantId !== tenant.tenantId) throw new AppError('cross_tenant_access_denied')

  const link = flow.link
  if (link) {
    return withTenant(c, tenant, () =>
      completeSocialLink(c, {
        tenant,
        provider,
        flow: link,
        exchange: () => exchangeAndResolveProfile({ c, tenant, provider, flow, code }),
      }),
    )
  }
  return withTenant(c, tenant, () => signInLinkedUser({ c, tenant, provider, flow, code }))
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
