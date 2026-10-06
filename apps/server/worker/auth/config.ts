import type { Hono } from 'hono'
import { resolveInstanceLoginCandidates, resolveTenantContextById } from '@xid-kit/db'
import { defaultLandingPathFor, type DefaultLandingPath, type OrgBranding } from '@xid-kit/types'
import { isHostedAuthIntent, isProductSignUpIntent } from '../../shared/hosted-auth-intent'
import type { XidHonoEnv } from '../lib/types'
import { AppError } from '../lib/errors'
import {
  ambiguousHostedAuthConfig,
  publicHostedAuthConfig,
  type PublicHostedAuthConfig,
} from './hosted-policy'
import { smsDeliveryReady, whatsappDeliveryReady } from './delivery-channels'
import {
  isInstanceEntryContext,
  loginHintCandidates,
  resolveEntryTenant,
} from '../me-auth/instance-login'
import { hasProviderSecret } from './social-providers'
import { publicTurnstileSiteKey } from '../me-auth/shared'
import {
  createGuestEntryCapability,
  isRootGuestOnboardingTenant,
} from '../me-auth/guest-entry-capability'

type HostedEntryFlow = {
  intent: string | null
  invitationToken: string | null
  authzRequestId: string | null
  applicationClientId: string | null
  organizationId?: string
}

function permitsRootGuestOnboarding(flow: HostedEntryFlow): boolean {
  return (
    (flow.intent === null || flow.intent === 'sign-up') &&
    flow.invitationToken === null &&
    flow.authzRequestId === null &&
    flow.applicationClientId === null &&
    flow.organizationId === undefined
  )
}

// 邀请只走 Email claim;社交与企业 SSO 入口不接受邀请 capability,邀请流程中不展示(01 章 3)。
function withoutFederatedEntry(config: PublicHostedAuthConfig): PublicHostedAuthConfig {
  return {
    ...config,
    methods: {
      ...config.methods,
      enterpriseSso: { ...config.methods.enterpriseSso, enabled: false, allowLogin: false },
    },
    socialProviders: [],
  }
}

async function withRuntimeCapabilities(input: {
  config: PublicHostedAuthConfig
  env: Env
  requestUrl: string
  currentTenant: XidHonoEnv['Variables']['tenant']
  resolvedTenant: XidHonoEnv['Variables']['tenant']
  flow: HostedEntryFlow
}): Promise<
  PublicHostedAuthConfig & { defaultLandingPath: DefaultLandingPath; branding: OrgBranding | null }
> {
  const { config, env, requestUrl, currentTenant, resolvedTenant, flow } = input
  const guestAllowed =
    config.resolution.status === 'ready' &&
    permitsRootGuestOnboarding(flow) &&
    currentTenant.tenantId === resolvedTenant.tenantId &&
    isRootGuestOnboardingTenant(currentTenant) &&
    isRootGuestOnboardingTenant(resolvedTenant) &&
    !config.forceSso &&
    (config.allowUserCreation || config.allowExistingUserLogin)
  const guest = guestAllowed
    ? {
        capabilityToken: await createGuestEntryCapability({
          env,
          tenantId: resolvedTenant.tenantId,
          origin: new URL(requestUrl).origin,
        }),
      }
    : null
  return {
    ...(flow.invitationToken === null ? config : withoutFederatedEntry(config)),
    turnstileSiteKey: publicTurnstileSiteKey(env),
    guest,
    defaultLandingPath: defaultLandingPathFor(currentTenant),
    branding: brandingFor(resolvedTenant),
  }
}

// 实例根入口尚未确定组织,只展示默认品牌,不能把任意组织的品牌放到根入口。
function brandingFor(tenant: XidHonoEnv['Variables']['tenant']): OrgBranding | null {
  const resolution = tenant.resolution
  if (resolution?.kind === 'instance_entry' || resolution?.unresolvedRoot) return null
  return tenant.policy?.branding ?? null
}

export function registerHostedAuthConfigRoutes(app: Hono<XidHonoEnv>): void {
  app.get('/auth/config', async (c) => {
    c.header('Cache-Control', 'no-store')
    const currentTenant = c.get('tenant')
    const loginHint = c.req.query('login_hint')?.trim()
    const organizationId = c.req.query('organization_id')?.trim()
    const rawIntent = c.req.query('intent')?.trim()
    const intent = rawIntent ? rawIntent : null
    if (intent !== null && !isHostedAuthIntent(intent)) throw new AppError('invalid_request')
    const applicationClientId = c.req.query('client_id')?.trim() || null
    const invitationToken =
      c.req.query('invitation_token')?.trim() ?? c.req.query('invitationToken')?.trim() ?? null
    const authzRequestId = c.req.query('authz_request_id')?.trim() || null
    const flow = {
      intent,
      invitationToken,
      authzRequestId,
      applicationClientId,
      organizationId,
    }
    const rootSelfServiceSignUp = isProductSignUpIntent(intent) && !invitationToken
    if (
      organizationId &&
      isInstanceEntryContext(currentTenant) &&
      !rootSelfServiceSignUp &&
      !invitationToken &&
      !applicationClientId
    ) {
      const result = await resolveTenantContextById(c.req.raw, c.env, organizationId)
      if (result.ok) {
        return c.json(
          await withRuntimeCapabilities({
            config: publicHostedAuthConfig(
              result.value.tenant,
              (policy, provider) => hasProviderSecret(c.env, policy, provider),
              (method) =>
                (method !== 'whatsappOtp' || whatsappDeliveryReady(result.value.tenant, c.env)) &&
                (method !== 'smsOtp' || smsDeliveryReady(result.value.tenant, c.env)),
            ),
            env: c.env,
            requestUrl: c.req.url,
            currentTenant,
            resolvedTenant: result.value.tenant,
            flow,
          }),
        )
      }
    }
    if (
      loginHint &&
      currentTenant.resolution?.unresolvedRoot &&
      !rootSelfServiceSignUp &&
      !invitationToken &&
      !applicationClientId
    ) {
      const result = await resolveInstanceLoginCandidates(
        c.req.raw,
        c.env,
        loginHintCandidates(loginHint),
      )
      if (result.ok && result.value.status === 'ambiguous') {
        return c.json(
          await withRuntimeCapabilities({
            config: ambiguousHostedAuthConfig({
              matchedBy: result.value.matchedBy,
              matches: result.value.matches,
            }),
            env: c.env,
            requestUrl: c.req.url,
            currentTenant,
            resolvedTenant: currentTenant,
            flow,
          }),
        )
      }
    }
    const tenant =
      loginHint || rootSelfServiceSignUp || invitationToken || applicationClientId
        ? await resolveEntryTenant(
            c,
            loginHint ? loginHintCandidates(loginHint) : [],
            organizationId,
            { intent, invitationToken, applicationClientId },
          )
        : c.get('tenant')
    return c.json(
      await withRuntimeCapabilities({
        config: publicHostedAuthConfig(
          tenant,
          (policy, provider) => hasProviderSecret(c.env, policy, provider),
          (method) =>
            (method !== 'whatsappOtp' || whatsappDeliveryReady(tenant, c.env)) &&
            (method !== 'smsOtp' || smsDeliveryReady(tenant, c.env)),
        ),
        env: c.env,
        requestUrl: c.req.url,
        currentTenant,
        resolvedTenant: tenant,
        flow,
      }),
    )
  })
}
