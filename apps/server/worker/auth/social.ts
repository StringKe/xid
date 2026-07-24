// social.ts:Social OAuth 登录 handler(OAuth client/RP 端,见 01 章 3)。
// state/nonce/PKCE 存 OAuthFlowDO(OAUTH_STATE),强一致防重放,回调一次性消费。
// account linking 判断树:SocialConnection 已存在 -> 直接登录;已验证 email -> 自动合并;
//   未验证 email 且用户已存在 -> 拒绝自动合并;全新 -> 新建 user。
// provider token(access/refresh)落 DB 前用租户 KEK 信封加密(AES-256-GCM)。
// 枚举防护:不依 provider_user_id 存在与否返回不同响应。
// Apple:response_mode=form_post,首次持久化 email/name,私密转发邮箱原样存。
// GitHub non-OIDC:调 /user + /user/emails 取 idp_user_id + 已验证 email。
// provider 集成层(配置/验签/profile/code exchange/token 加密)见 social-providers.ts。

import { base64UrlEncode } from '@xid-kit/crypto'
import { createTenantDb, resolveTenantContextById, schema } from '@xid-kit/db'
import { and, eq, isNull } from 'drizzle-orm'
import { Hono } from 'hono'
import type { Context } from 'hono'
import * as v from 'valibot'
import { AppError } from '../lib/errors'
import type { TenantVar, XidHonoEnv } from '../lib/types'
import { issueSession } from '../lib/session'
import { validateQuery } from '../lib/validate'
import { SOCIAL_AUTH_CONTEXT } from '../lib/auth-context'
import { isDevOrTestEnvironment } from '../test-harness/dev-gate'
import { resolvePostAuthMfaGate } from '../lib/mfa-session'
import {
  assertPublicProviderEndpoints,
  computeCodeChallenge,
  encryptToken,
  exchangeCode,
  getProviderConfig,
  hasProviderSecret,
  resolveProfile,
} from './social-providers'
import type { Provider, ProviderProfile, TokenResponse } from './social-providers'
import { assertSocialProviderAllowed } from './hosted-policy'
import { auditPolicyDeniedError } from './hosted-audit'
import { loginHintCandidates, resolveEntryTenant, withTenant } from '../me-auth/instance-login'
import { ensureDefaultMembership, shouldSkipDefaultMembership } from '../me-auth/passwordless-users'
import { OAUTH_FLOW_STATE_TTL_MS } from '../lib/ttl'

const DEFAULT_AUTH_RETURN_PATH = '/console'

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
  invitationToken?: string
  intent?: string
  skipDefaultMembership?: boolean
}

// OAuthFlowDO stub(OAUTH_STATE binding,见 cloudflare-bindings rule)。
function oauthFlowStub(env: Env, state: string): DurableObjectStub {
  const ns = env.OAUTH_STATE
  return ns.get(ns.idFromName(`state:${state}`))
}

async function storeOAuthFlow(env: Env, state: string, payload: OAuthFlowPayload): Promise<void> {
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
  if (typeof value !== 'string') throw new AppError('server_error')
  return value
}

// DO 返回的 record 是 OAuth 流程的唯一真相源(codeVerifier / nonce / tenantId):形状不完整时
// 绝不能带着缺省值继续走完 code exchange,否则 PKCE 与 nonce 绑定被跳过。
function parseConsumedOAuthFlowBody(value: unknown): OAuthFlowPayload {
  const record = asObject(asObject(value)['record'])
  const createdAt = record['createdAt']
  const skipDefaultMembership = record['skipDefaultMembership']
  if (
    typeof createdAt !== 'number' ||
    (skipDefaultMembership !== undefined && typeof skipDefaultMembership !== 'boolean')
  ) {
    throw new AppError('server_error')
  }
  const invitationToken = optionalString(record, 'invitationToken')
  const intent = optionalString(record, 'intent')
  return {
    tenantId: requiredString(record, 'tenantId'),
    provider: requiredString(record, 'provider'),
    codeVerifier: requiredString(record, 'codeVerifier'),
    nonce: requiredString(record, 'nonce'),
    redirectAfterLogin: requiredString(record, 'redirectAfterLogin'),
    returnToOrigin: requiredString(record, 'returnToOrigin'),
    createdAt,
    ...(invitationToken === undefined ? {} : { invitationToken }),
    ...(intent === undefined ? {} : { intent }),
    ...(skipDefaultMembership === undefined ? {} : { skipDefaultMembership }),
  }
}

// fail closed:只有 DO 明确回 404(state 不存在)/ 410(已过期)才是"state 无效"的正常语义,
// 其余状态码与坏 body 都是协调层故障 -- 当成 state 无效放行下去会让 state/nonce 一次性消费
// 语义失效(CSRF 防护 + code 重放防护同时失守),必须拒绝整个请求。
async function consumeOAuthFlow(env: Env, state: string): Promise<OAuthFlowPayload | null> {
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
  return parseConsumedOAuthFlowBody(body)
}

function assertOAuthFlowPayload(
  flow: OAuthFlowPayload,
  provider: Provider,
): asserts flow is OAuthFlowPayload {
  if (
    flow.provider !== provider ||
    typeof flow.tenantId !== 'string' ||
    flow.tenantId.length === 0 ||
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

// redirectAfterLogin 白名单校验:精确匹配 client 注册的 redirectUris,不匹配回退默认(防 open redirect)。
// 导出供单测覆盖 open redirect 阻断行为(Fix 4)。
export function resolveRedirect(
  requested: string,
  config: { redirectUris?: string[] },
  fallback: string,
): string {
  const allow = config.redirectUris ?? []
  return allow.includes(requested) ? requested : fallback
}

function redirectUrl(value: string, origin: string): string {
  return new URL(value, origin).toString()
}

const social = new Hono<XidHonoEnv>()

async function socialAuthorizeTenant(c: Context<XidHonoEnv>): Promise<TenantVar> {
  const current = c.get('tenant')
  if (!current.resolution?.unresolvedRoot) return current

  const organizationId = c.req.query('organization_id')?.trim()
  if (organizationId) {
    const result = await resolveTenantContextById(c.req.raw, c.env, organizationId)
    if (!result.ok) throw new AppError('invalid_request')
    return result.value.tenant
  }

  const loginHint = c.req.query('login_hint')?.trim()
  if (!loginHint) return current
  return resolveEntryTenant(c, loginHintCandidates(loginHint))
}

async function socialCallbackTenant(c: Context<XidHonoEnv>, tenantId: string): Promise<TenantVar> {
  const current = c.get('tenant')
  if (!current.resolution?.unresolvedRoot) return current
  const result = await resolveTenantContextById(c.req.raw, c.env, tenantId)
  if (!result.ok) throw new AppError('cross_tenant_access_denied')
  return result.value.tenant
}

// GET /auth/{provider}/authorize -- 发起 OAuth 授权跳转
async function handleAuthorize(c: Context<XidHonoEnv>, provider: Provider): Promise<Response> {
  const tenant = await socialAuthorizeTenant(c)

  const config = getProviderConfig(c.env, tenant, provider)
  if (!config)
    throw new AppError('invalid_request', { longMessage: `Provider ${provider} not configured` })
  try {
    assertSocialProviderAllowed({
      tenant,
      provider,
      action: 'login',
      email: null,
      emailVerified: true,
      hasSecret: (policy) => hasProviderSecret(c.env, policy),
    })
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

  // 生成 state(>= 32 字节),nonce,PKCE code_verifier(01 章 3 发起授权)。
  const state = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)))
  const nonce = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)))
  const codeVerifier = base64UrlEncode(crypto.getRandomValues(new Uint8Array(43)))
  const codeChallenge = await computeCodeChallenge(codeVerifier)

  const redirectAfterLogin =
    c.req.query('redirect_uri') ?? c.req.query('continue') ?? DEFAULT_AUTH_RETURN_PATH
  const returnToOrigin = new URL(c.req.url).origin
  const invitationToken = c.req.query('invitation_token') ?? c.req.query('invitationToken') ?? null
  const intent = c.req.query('intent') ?? null
  const skipDefaultMembership = shouldSkipDefaultMembership({
    redirectAfterLogin,
    invitationToken,
    intent,
  })

  // state 存 OAuthFlowDO(10min,一次性消费)。
  await storeOAuthFlow(c.env, state, {
    tenantId: tenant.tenantId,
    provider,
    codeVerifier,
    nonce,
    redirectAfterLogin,
    returnToOrigin,
    createdAt: Date.now(),
    invitationToken: invitationToken ?? undefined,
    intent: intent ?? undefined,
    skipDefaultMembership,
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
  return handleAuthorize(c, parseProviderParam(c))
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

// account linking 共享上下文(避免各 helper 参数超 4)。
type LinkContext = {
  c: Context<XidHonoEnv>
  tenant: TenantVar
  db: ReturnType<typeof createTenantDb>
  provider: Provider
  scopes: string[]
  tokens: TokenResponse
  profile: ProviderProfile
  skipDefaultMembership?: boolean
}

// 加密 access/refresh token 字段(落 D1 前 AES-256-GCM 信封加密)。
async function buildTokenCiphertexts(
  env: Env,
  tokens: TokenResponse,
): Promise<{ accessTokenCiphertext: Buffer; refreshTokenCiphertext?: Buffer }> {
  const acc = Buffer.from(await encryptToken(env, tokens.accessToken))
  if (!tokens.refreshToken) return { accessTokenCiphertext: acc }
  return {
    accessTokenCiphertext: acc,
    refreshTokenCiphertext: Buffer.from(await encryptToken(env, tokens.refreshToken)),
  }
}

async function maybeUpdateExternalId(ctx: LinkContext, userId: string): Promise<void> {
  const externalId = ctx.profile.externalId
  if (!externalId) return
  const user = await ctx.db.users.findOne(eq(schema.users.id, userId))
  if (!user || user.externalId) return
  try {
    await ctx.db.users.update({ externalId }, eq(schema.users.id, userId))
  } catch {
    // uniqueness guard:ignore if another user already owns external_id
  }
}

// 为已存在 user 新建/刷新 SocialConnection,记 connection.linked 审计。
async function upsertIdentity(
  ctx: LinkContext,
  userId: string,
  existingId: string | null,
): Promise<void> {
  const { c, tenant, db, provider, scopes, tokens, profile } = ctx
  const ciphertexts = await buildTokenCiphertexts(c.env, tokens)
  if (existingId) {
    await db.userIdentities.update(
      { ...ciphertexts, lastUsedAt: new Date(), profileRaw: profile.profileRaw },
      eq(schema.userIdentities.id, existingId),
    )
    return
  }
  await db.userIdentities.insert({
    id: crypto.randomUUID(),
    tenantId: tenant.tenantId,
    userId,
    identityType: 'oauth',
    provider,
    providerUserId: profile.idpUserId,
    ...ciphertexts,
    scopes,
    profileRaw: profile.profileRaw,
    lastUsedAt: new Date(),
  })
  await c.env.AUDIT_QUEUE.send({
    tenantId: tenant.tenantId,
    action: 'connection.linked',
    actorId: userId,
    ts: Date.now(),
    payload: { provider, idpUserId: profile.idpUserId },
  })
}

// account linking 判断树(01 章 3 四分支),返回登录 userId。
async function linkOrCreateUser(ctx: LinkContext): Promise<string> {
  const { db, provider, profile } = ctx
  const { idpUserId, email, emailVerified } = profile

  // 分支 A:SocialConnection 已存在 -> 直接登录,刷新 token。
  const existingIdentity = await db.userIdentities.findOne(
    and(
      eq(schema.userIdentities.provider, provider),
      eq(schema.userIdentities.providerUserId, idpUserId),
      isNull(schema.userIdentities.revokedAt),
    ),
  )
  if (existingIdentity) {
    try {
      assertSocialProviderAllowed({
        tenant: ctx.tenant,
        provider,
        action: 'login',
        email,
        emailVerified,
        hasSecret: (policy) => hasProviderSecret(ctx.c.env, policy),
      })
    } catch (error) {
      throw await auditPolicyDeniedError(ctx.c, error, {
        tenant: ctx.tenant,
        method: 'social',
        action: 'login',
        provider,
        identifier: { type: 'email', value: email },
      })
    }
    await upsertIdentity(ctx, existingIdentity.userId, existingIdentity.id)
    await maybeUpdateExternalId(ctx, existingIdentity.userId)
    return existingIdentity.userId
  }

  // 分支 B/C:按 email 命中现有 user。
  if (email) {
    const emailRow = await db.userEmails.findOne(eq(schema.userEmails.email, email))
    if (emailRow && emailVerified) {
      try {
        assertSocialProviderAllowed({
          tenant: ctx.tenant,
          provider,
          action: 'login',
          email,
          emailVerified,
          hasSecret: (policy) => hasProviderSecret(ctx.c.env, policy),
        })
      } catch (error) {
        throw await auditPolicyDeniedError(ctx.c, error, {
          tenant: ctx.tenant,
          method: 'social',
          action: 'login',
          provider,
          identifier: { type: 'email', value: email },
        })
      }
      await upsertIdentity(ctx, emailRow.userId, null) // 自动合并(已验证 email)。
      await maybeUpdateExternalId(ctx, emailRow.userId)
      return emailRow.userId
    }
    if (emailRow) {
      // 分支 C:email 未验证且 user 存在 -> 拒绝自动合并(防社工)。
      throw new AppError('invalid_credentials')
    }
  }

  // 分支 D:全新 user。
  try {
    assertSocialProviderAllowed({
      tenant: ctx.tenant,
      provider,
      action: 'user_creation',
      email,
      emailVerified,
      hasSecret: (policy) => hasProviderSecret(ctx.c.env, policy),
    })
  } catch (error) {
    throw await auditPolicyDeniedError(ctx.c, error, {
      tenant: ctx.tenant,
      method: 'social',
      action: 'user_creation',
      provider,
      identifier: { type: 'email', value: email },
    })
  }
  return createNewUser(ctx)
}

// GET + POST /auth/{provider}/callback -- OAuth 回调处理(Apple 用 POST form_post)
async function handleCallback(c: Context<XidHonoEnv>, provider: Provider): Promise<Response> {
  let tenant = c.get('tenant')
  const { code, state, error } = await readCallbackParams(c)

  // provider 返回 error(如 access_denied):渲染取消页,不作为枚举信号。
  if (error) {
    return Response.redirect(`${tenant.issuer}/auth/cancelled?error=${encodeURIComponent(error)}`)
  }
  if (!state || !code) throw new AppError('invalid_request')

  // 取并一次性消费 OAuthFlowDO 中的 state + 跨租户校验(01 章 3 step 2)。
  const flow = await consumeOAuthFlow(c.env, state)
  if (!flow) throw new AppError('invalid_request', { longMessage: 'state_invalid' })
  assertOAuthFlowPayload(flow, provider)
  tenant = await socialCallbackTenant(c, flow.tenantId)
  if (flow.tenantId !== tenant.tenantId) throw new AppError('cross_tenant_access_denied')

  return withTenant(c, tenant, async () => {
    const config = getProviderConfig(c.env, tenant, provider)
    if (!config) throw new AppError('invalid_request')
    try {
      assertSocialProviderAllowed({
        tenant,
        provider,
        action: 'login',
        email: null,
        emailVerified: true,
        hasSecret: (policy) => hasProviderSecret(c.env, policy),
      })
    } catch (policyError) {
      throw await auditPolicyDeniedError(c, policyError, {
        tenant,
        method: 'social',
        action: 'login',
        provider,
      })
    }

    // code exchange / JWKS 拉取是出网调用:provider 端点非法(内网/明文)时抛 policy 错误记审计,
    // 其余 AppError(invalid_grant / invalid_credentials)原样上抛,行为不变。
    let tokens: TokenResponse
    let profile: ProviderProfile
    try {
      tokens = await exchangeCode({
        provider,
        config,
        redirectUri: `${flow.returnToOrigin}/auth/${provider}/callback`,
        codeVerifier: flow.codeVerifier,
        code,
        allowNonPublic: isDevOrTestEnvironment(c.env),
      })
      profile = await resolveProfile({
        env: c.env,
        provider,
        config,
        tokens,
        nonce: flow.nonce,
      })
    } catch (error) {
      throw await auditPolicyDeniedError(c, error, {
        tenant,
        method: 'social',
        action: 'login',
        provider,
      })
    }

    const db = createTenantDb(c.env.DB, tenant)
    const userId = await linkOrCreateUser({
      c,
      tenant,
      db,
      provider,
      scopes: config.scopes,
      tokens,
      profile,
      skipDefaultMembership: flow.skipDefaultMembership ?? false,
    })

    const now = new Date()
    const location = resolveRedirect(flow.redirectAfterLogin, config, DEFAULT_AUTH_RETURN_PATH)
    const mfaGate = await resolvePostAuthMfaGate(c, tenant, { userId, returnPath: location })
    await issueSession(c, {
      sessionId: crypto.randomUUID(),
      userId,
      ...(mfaGate.sessionStatus ? { status: mfaGate.sessionStatus } : {}),
      authContext: SOCIAL_AUTH_CONTEXT,
      authenticatedAt: now,
      rememberMe: true,
      ip: c.req.header('cf-connecting-ip') ?? null,
      userAgent: c.req.header('user-agent') ?? null,
    })

    // open redirect 防护:redirectAfterLogin 必须精确匹配 client 注册白名单,否则回退默认。
    // session 走 cookie(issueSession 已设),绝不在 URL 携带 session_id。
    const target = mfaGate.redirectUrl ?? location
    return c.redirect(redirectUrl(target, flow.returnToOrigin), 302)
  })
}

// 新建 user + 主邮箱 + SocialConnection(分支 D),记 user.created + connection.linked 审计。
async function createNewUser(ctx: LinkContext): Promise<string> {
  const { c, tenant, db, provider, profile } = ctx
  const userId = crypto.randomUUID()
  const nameParts = (profile.name ?? '').split(' ')

  await db.users.insert({
    id: userId,
    tenantId: tenant.tenantId,
    firstName: nameParts[0] ?? null,
    lastName: nameParts.slice(1).join(' ') || null,
    displayName: profile.name ?? null,
    externalId: profile.externalId ?? null,
    status: 'active',
  })

  if (profile.email) {
    const emailId = crypto.randomUUID()
    await db.userEmails.insert({
      id: emailId,
      tenantId: tenant.tenantId,
      userId,
      email: profile.email,
      verified: profile.emailVerified,
      verificationStatus: profile.emailVerified ? 'verified' : 'unverified',
      isPrimary: true,
      ...(profile.emailVerified ? { verifiedAt: new Date() } : {}),
    })
    await db.users.update({ primaryEmailId: emailId }, eq(schema.users.id, userId))
  }
  await ensureDefaultMembership({
    db,
    tenantId: tenant.tenantId,
    userId,
    skip: ctx.skipDefaultMembership ?? false,
  })

  await upsertIdentity(ctx, userId, null)
  await c.env.AUDIT_QUEUE.send({
    tenantId: tenant.tenantId,
    action: 'user.created',
    actorId: userId,
    ts: Date.now(),
    payload: { provider, idpUserId: profile.idpUserId },
  })
  return userId
}

social.get('/:provider/callback', async (c) => {
  return handleCallback(c, parseProviderParam(c))
})

social.post('/:provider/callback', async (c) => {
  return handleCallback(c, parseProviderParam(c))
})

export function registerSocialRoutes(app: Hono<XidHonoEnv>): void {
  app.route('/auth', social)
}
