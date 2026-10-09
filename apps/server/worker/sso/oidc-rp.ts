// oidc-rp.ts:作为 RP 对接企业上游 IdP(OIDC 联邦)。
// 流程:discovery -> authorize 重定向(PKCE + nonce + state) -> callback 换码(机密客户端带 client_secret)
// -> 验 id_token 签名 -> jit。state/nonce 存 OAuthFlowDO(10min 一次性消费)。
// 铁律:PKCE 强制 S256;nonce 防重放;tenant_id 从 TenantContext 取;浏览器错误回 /sign-in。
// 上游调用见 oidc-upstream.ts,id_token 校验与 claims 映射见 oidc-id-token.ts。

import { createTenantDb, resolveTenantContextByApplicationClientId, schema } from '@xid-kit/db'
import { defaultLandingPathFor } from '@xid-kit/types'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { Context } from 'hono'
import * as v from 'valibot'
import { AppError } from '../lib/errors'
import type { XidHonoEnv } from '../lib/types'
import {
  STATE_INVALID,
  newFederatedFlowSecrets,
  redirectToSignInWithError,
  requestHasRawInvitationInput,
  storeFederatedFlow,
  withSignInErrorRedirect,
} from '../lib/federated-flow'
import { jitProvision } from './jit'
import {
  OIDC_RP_FLOW_PREFIX,
  consumeOidcRpFlow,
  finalizeOidcRpSession,
  flowReturnContext,
} from './oidc-rp-flow'
import type { OidcRpFlowPayload } from './oidc-rp-flow'
import { resolveSsoConnectionTenant, resolveSsoFlowTenant, withTenant } from './tenant'
import { enforceEnterpriseSsoPolicy } from './enterprise-policy'
import { decryptOidcClientSecret } from './oidc-client-secret'
import { shouldSkipDefaultMembership } from '../me-auth/passwordless-users'
import { isDevOrTestEnvironment } from '../test-harness/dev-gate'
import {
  isAuthorizeContinuation,
  resolveApplicationAuthorizeContinuation,
} from '../../shared/hosted-auth-continuation'
import { isApplicationSignUpIntent } from '../../shared/hosted-auth-intent'
import {
  buildProviderKeySet,
  exchangeCode,
  fetchDiscovery,
  fetchProviderJwks,
} from './oidc-upstream'
import { claimsToAssertion, verifyIdToken } from './oidc-id-token'

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
      prefix: OIDC_RP_FLOW_PREFIX,
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

// OIDC callback query(RFC6749 4.1.2):成功带 code+state,失败带 error。
const callbackQuerySchema = v.object({
  code: v.pipe(v.string(), v.minLength(1)),
  state: v.pipe(v.string(), v.minLength(1)),
})

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
  return finalizeOidcRpSession({
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
    const flow = state ? await consumeOidcRpFlow(c.env, state) : null
    const error = upstreamError === 'access_denied' ? 'cancelled' : 'sign_in_failed'
    return redirectToSignInWithError(c, error, flowReturnContext(flow))
  }
  const query = v.safeParse(callbackQuerySchema, {
    code: c.req.query('code'),
    state: c.req.query('state'),
  })
  if (!query.success) throw new AppError('invalid_request', { longMessage: STATE_INVALID })

  const flow = await consumeOidcRpFlow(c.env, query.output.state)
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
