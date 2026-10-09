import type { SocialProviderPolicy, TenantContext } from '@xid-kit/types'
import {
  assertEmailAllowed,
  deny,
  denyInvalidRequest,
  emailDomain,
  hostedAuthPolicy,
} from './hosted-policy-core'

export type SocialProviderCredentialResolver = (
  policy: SocialProviderPolicy,
  provider: string,
) => boolean

export function hasSocialProviderCredentials(
  policy: SocialProviderPolicy,
  provider: string,
  hasSecret: SocialProviderCredentialResolver,
): boolean {
  const profileReady =
    provider === 'github' ||
    (typeof policy.issuer === 'string' &&
      policy.issuer !== '' &&
      typeof policy.jwksUri === 'string' &&
      policy.jwksUri !== '') ||
    (typeof policy.userInfoEndpoint === 'string' && policy.userInfoEndpoint !== '')
  return (
    policy.enabled &&
    policy.clientId !== '' &&
    policy.authorizationEndpoint !== '' &&
    policy.tokenEndpoint !== '' &&
    profileReady &&
    hasSecret(policy, provider)
  )
}

export function assertSocialProviderAllowed(input: {
  tenant: TenantContext
  provider: string
  action: 'login' | 'user_creation'
  email: string | null
  emailVerified: boolean
  hasSecret: SocialProviderCredentialResolver
}): SocialProviderPolicy {
  const { tenant, provider, action, email, emailVerified, hasSecret } = input
  const policy = hostedAuthPolicy(tenant)
  if (policy.forceSso) deny('force_sso')
  if (action === 'login' && !policy.allowExistingUserLogin) deny('global_login_disabled')
  if (action === 'user_creation' && !policy.allowUserCreation) {
    deny('global_user_creation_disabled')
  }

  const providerPolicy = tenant.policy?.socialProviders?.[provider]
  if (!providerPolicy || !hasSocialProviderCredentials(providerPolicy, provider, hasSecret)) {
    denyInvalidRequest('provider_not_configured')
  }
  if (action === 'login' && !providerPolicy.allowLogin) deny('provider_login_disabled')
  if (action === 'user_creation' && !providerPolicy.allowUserCreation) {
    deny('provider_user_creation_disabled')
  }
  if (providerPolicy.requireVerifiedEmail && !emailVerified) deny('provider_email_unverified')
  assertEmailAllowed(tenant, email)

  const domain = email ? emailDomain(email) : null
  if (domain && providerPolicy.blockedEmailDomains.includes(domain)) {
    deny('provider_email_domain_blocked')
  }
  if (
    domain &&
    providerPolicy.allowedEmailDomains.length > 0 &&
    !providerPolicy.allowedEmailDomains.includes(domain)
  ) {
    deny('provider_email_domain_not_allowed')
  }
  return providerPolicy
}
