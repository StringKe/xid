// GET /auth/{provider}/authorize:解析目标租户、校验 provider 策略、存一次性 flow 并 302 到 provider。

import { defaultLandingPathFor } from '@xid-kit/types'
import type { Context } from 'hono'
import { AppError } from '../lib/errors'
import {
  newFederatedFlowSecrets,
  requestHasRawInvitationInput,
  storeFederatedFlow,
} from '../lib/federated-flow'
import type { TenantVar, XidHonoEnv } from '../lib/types'
import {
  isInstanceEntryContext,
  loginHintCandidates,
  resolveEntryTenant,
} from '../me-auth/instance-login'
import { shouldSkipDefaultMembership } from '../me-auth/passwordless-users'
import { requestIp, verifyTurnstile } from '../me-auth/shared'
import { isDevOrTestEnvironment } from '../test-harness/dev-gate'
import { resolveHostedAuthFlow } from '../../shared/hosted-auth-continuation'
import { auditPolicyDeniedError } from './hosted-audit'
import { SOCIAL_FLOW_PREFIX } from './social-flow'
import { assertSocialProviderAllowed } from './social-policy'
import {
  assertPublicProviderEndpoints,
  getProviderConfig,
  hasProviderSecret,
} from './social-providers'
import type { Provider } from './social-providers'

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

export async function assertProviderLoginAllowed(
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

export async function handleSocialAuthorize(
  c: Context<XidHonoEnv>,
  provider: Provider,
): Promise<Response> {
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
    prefix: SOCIAL_FLOW_PREFIX,
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
