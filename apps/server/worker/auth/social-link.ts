// 已登录用户在账户门户绑定社交账号(link 意图):state 里绑定当前 userId 与 sessionId,
// 回调只把外部身份关联到这个用户,不签发新会话、不切换账号,结果回到 /account/security。
// 外部账号已属于本租户其他用户时返回固定的 already_linked,本人账户不做任何改动。

import { createTenantDb, schema } from '@xid-kit/db'
import { and, eq, isNull } from 'drizzle-orm'
import type { Context } from 'hono'
import { AppError, isAppError } from '../lib/errors'
import { newFederatedFlowSecrets, storeFederatedFlow } from '../lib/federated-flow'
import { logWorkerWarning } from '../lib/safe-log'
import type { SessionData, TenantVar, XidHonoEnv } from '../lib/types'
import { bindUserIdentity } from '../lib/user-identity'
import { resolveSession } from '../me/shared'
import { isDevOrTestEnvironment } from '../test-harness/dev-gate'
import { assertSocialProviderAllowed, isHostedAuthPolicyError } from './hosted-policy'
import {
  assertPublicProviderEndpoints,
  encryptToken,
  getProviderConfig,
  hasProviderSecret,
} from './social-providers'
import type { Provider, ProviderProfile, TokenResponse } from './social-providers'

export const SOCIAL_LINK_RETURN_PATH = '/account/security'

export const SOCIAL_LINK_ERRORS = ['already_linked', 'cancelled', 'failed'] as const
export type SocialLinkError = (typeof SOCIAL_LINK_ERRORS)[number]

export type SocialLinkFlow = { linkUserId: string; linkSessionId: string }

function assertLinkableProvider(
  c: Context<XidHonoEnv>,
  tenant: TenantVar,
  provider: Provider,
): void {
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
    if (!isHostedAuthPolicyError(error)) throw error
    throw new AppError('invalid_request', { cause: error })
  }
}

// 与 social.ts 的登录 flow 同一前缀:回调统一由 /auth/:provider/callback 消费,按 link 字段分流。
const FLOW_PREFIX = 'state'

// 返回 provider 授权地址。
export async function startSocialLink(
  c: Context<XidHonoEnv>,
  input: { provider: Provider; session: SessionData },
): Promise<string> {
  const tenant = c.get('tenant')
  const config = getProviderConfig(c.env, tenant, input.provider)
  if (!config) throw new AppError('invalid_request')
  assertLinkableProvider(c, tenant, input.provider)
  assertPublicProviderEndpoints(config, isDevOrTestEnvironment(c.env))

  const { state, nonce, codeVerifier, codeChallenge } = await newFederatedFlowSecrets()
  const returnToOrigin = new URL(c.req.url).origin
  await storeFederatedFlow(c.env, {
    prefix: FLOW_PREFIX,
    state,
    payload: {
      tenantId: tenant.tenantId,
      provider: input.provider,
      codeVerifier,
      nonce,
      redirectAfterLogin: SOCIAL_LINK_RETURN_PATH,
      returnToOrigin,
      createdAt: Date.now(),
      skipDefaultMembership: true,
      linkUserId: input.session.userId,
      linkSessionId: input.session.sessionId,
    },
  })
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: `${returnToOrigin}/auth/${input.provider}/callback`,
    response_type: 'code',
    scope: config.scopes.join(' '),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    nonce,
  })
  if (input.provider === 'apple') params.set('response_mode', 'form_post')
  return `${config.authorizationEndpoint}?${params}`
}

export function redirectToSocialLinkResult(
  c: Context<XidHonoEnv>,
  input: { provider: Provider; error?: SocialLinkError },
): Response {
  const params = new URLSearchParams(
    input.error
      ? { connect_error: input.error, provider: input.provider }
      : { connected: input.provider },
  )
  c.header('Cache-Control', 'no-store')
  return c.redirect(`${SOCIAL_LINK_RETURN_PATH}?${params}`, 302)
}

async function linkIdentity(
  c: Context<XidHonoEnv>,
  input: {
    tenant: TenantVar
    provider: Provider
    userId: string
    profile: ProviderProfile
    tokens: TokenResponse
    scopes: string[]
  },
): Promise<SocialLinkError | null> {
  const db = createTenantDb(c.env.DB, input.tenant)
  const active = await db.userIdentities.findOne(
    and(
      eq(schema.userIdentities.provider, input.provider),
      eq(schema.userIdentities.providerUserId, input.profile.idpUserId),
      isNull(schema.userIdentities.revokedAt),
    ),
  )
  if (active && active.userId !== input.userId) return 'already_linked'
  const { linked } = await bindUserIdentity({
    db,
    tenantId: input.tenant.tenantId,
    userId: input.userId,
    identity: {
      identityType: 'oauth',
      provider: input.provider,
      providerUserId: input.profile.idpUserId,
      fields: {
        accessTokenCiphertext: Buffer.from(await encryptToken(c.env, input.tokens.accessToken)),
        refreshTokenCiphertext: input.tokens.refreshToken
          ? Buffer.from(await encryptToken(c.env, input.tokens.refreshToken))
          : null,
        scopes: input.scopes,
        profileRaw: input.profile.profileRaw,
      },
    },
  })
  if (linked) {
    await c.env.AUDIT_QUEUE.send({
      tenantId: input.tenant.tenantId,
      action: 'connection.linked',
      actorId: input.userId,
      ts: Date.now(),
      payload: { provider: input.provider, idpUserId: input.profile.idpUserId },
    })
  }
  return null
}

// 发起 link 的浏览器会话必须仍然有效且是同一个会话,防止回调被别人的浏览器接走。
export async function completeSocialLink(
  c: Context<XidHonoEnv>,
  input: {
    tenant: TenantVar
    provider: Provider
    flow: SocialLinkFlow
    exchange: () => Promise<{ tokens: TokenResponse; profile: ProviderProfile; scopes: string[] }>
  },
): Promise<Response> {
  const { tenant, provider, flow } = input
  try {
    const session = await resolveSession(c)
    if (session?.userId !== flow.linkUserId || session.sessionId !== flow.linkSessionId) {
      throw new AppError('invalid_request')
    }
    const { tokens, profile, scopes } = await input.exchange()
    const error = await linkIdentity(c, {
      tenant,
      provider,
      userId: flow.linkUserId,
      profile,
      tokens,
      scopes,
    })
    return redirectToSocialLinkResult(c, error ? { provider, error } : { provider })
  } catch (error) {
    if (!isAppError(error)) throw error
    logWorkerWarning('auth.social_link.rejected', {
      component: 'auth',
      operation: 'social_link_callback',
      outcome: error.code,
      status: error.httpStatus,
    })
    return redirectToSocialLinkResult(c, { provider, error: 'failed' })
  }
}
