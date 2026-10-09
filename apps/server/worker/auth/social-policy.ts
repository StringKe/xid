import type { SocialProviderPolicy, TenantContext } from '@xid-kit/types'
import { deny, denyInvalidRequest, emailDomain, hostedAuthPolicy } from './hosted-policy-core'

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
  if (action === 'user_creation' && providerPolicy.requireVerifiedEmail && !emailVerified) {
    deny('provider_email_unverified')
  }
  assertSocialEmailDomains({ tenant, providerPolicy, action, email, emailVerified })
  return providerPolicy
}

// 黑名单对 provider 声称的任何 email 生效;白名单只认已验证的 email。建号时有白名单却拿不到
// 已验证 email 一律拒绝;已绑定身份的登录不因缺少可信 email 被拦。
function assertSocialEmailDomains(input: {
  tenant: TenantContext
  providerPolicy: SocialProviderPolicy
  action: 'login' | 'user_creation'
  email: string | null
  emailVerified: boolean
}): void {
  const { tenant, providerPolicy, action, email, emailVerified } = input
  const policy = hostedAuthPolicy(tenant)
  const domain = email ? emailDomain(email) : null
  if (email && !domain) deny('invalid_email')
  if (domain && policy.blockedEmailDomains.includes(domain)) deny('email_domain_blocked')
  if (domain && providerPolicy.blockedEmailDomains.includes(domain)) {
    deny('provider_email_domain_blocked')
  }

  const trustedDomain = emailVerified ? domain : null
  const mustProveDomain = action === 'user_creation'
  if (!domainAllowed(policy.allowedEmailDomains, trustedDomain, mustProveDomain)) {
    deny('email_domain_not_allowed')
  }
  if (!domainAllowed(providerPolicy.allowedEmailDomains, trustedDomain, mustProveDomain)) {
    deny('provider_email_domain_not_allowed')
  }
}

function domainAllowed(
  allowed: readonly string[],
  trustedDomain: string | null,
  mustProveDomain: boolean,
): boolean {
  if (allowed.length === 0) return true
  if (trustedDomain === null) return !mustProveDomain
  return allowed.includes(trustedDomain)
}
