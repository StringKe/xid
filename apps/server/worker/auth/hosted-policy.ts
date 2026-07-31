import type {
  HostedAuthMethodPolicy,
  HostedAuthPolicy,
  SocialProviderPolicy,
  TenantContext,
} from '@xid-kit/types'
import type { InstanceLoginMatch } from '@xid-kit/db'
import { DEFAULT_HOSTED_AUTH_POLICY } from '@xid-kit/types'
import { AppError } from '../lib/errors'

export type HostedAuthPolicyDenialReason =
  | 'force_sso'
  | 'global_login_disabled'
  | 'global_user_creation_disabled'
  | 'method_disabled'
  | 'method_not_configured'
  | 'method_login_disabled'
  | 'method_user_creation_disabled'
  | 'identifier_mode_not_allowed'
  | 'instance_tenant_unresolved'
  | 'invalid_email'
  | 'email_domain_blocked'
  | 'email_domain_not_allowed'
  | 'provider_not_configured'
  | 'provider_login_disabled'
  | 'provider_user_creation_disabled'
  | 'provider_email_unverified'
  | 'provider_email_domain_blocked'
  | 'provider_email_domain_not_allowed'
  | 'enterprise_sso_disabled'
  | 'enterprise_sso_login_disabled'
  | 'enterprise_sso_jit_user_creation_disabled'
  | 'enterprise_sso_email_domain_blocked'
  | 'enterprise_sso_email_domain_not_allowed'
  | 'profile_field_required'

export class HostedAuthPolicyError extends AppError {
  readonly policyReason: HostedAuthPolicyDenialReason

  constructor(
    reason: HostedAuthPolicyDenialReason,
    code: 'invalid_credentials' | 'invalid_request' = 'invalid_credentials',
  ) {
    super(code)
    this.name = 'HostedAuthPolicyError'
    this.policyReason = reason
  }
}

export type PublicSocialProvider = {
  provider: string
  allowLogin: boolean
  allowUserCreation: boolean
  requireVerifiedEmail: boolean
  allowedEmailDomains: readonly string[]
  blockedEmailDomains: readonly string[]
}

export type PublicInstanceLoginMatch = {
  organizationId: string
  slug: string
  name: string
  issuer: string
}

export type PublicGuestEntryCapability = {
  capabilityToken: string
}

export type PublicHostedAuthConfig = {
  resolution:
    | { status: 'ready' }
    | {
        status: 'ambiguous'
        matchedBy: string
        matches: readonly PublicInstanceLoginMatch[]
      }
  identifierMode: HostedAuthPolicy['identifierMode']
  requireVerifiedEmail: boolean
  allowedEmailDomains: readonly string[]
  blockedEmailDomains: readonly string[]
  forceSso: boolean
  allowUserCreation: boolean
  allowExistingUserLogin: boolean
  turnstileSiteKey: string | null
  guest: PublicGuestEntryCapability | null
  profileFields: HostedAuthPolicy['profileFields']
  methods: {
    password: HostedAuthMethodPolicy
    magicLink: HostedAuthMethodPolicy
    emailOtp: HostedAuthMethodPolicy
    whatsappOtp: HostedAuthMethodPolicy
    smsOtp: HostedAuthMethodPolicy
    passkey: HostedAuthMethodPolicy
    enterpriseSso: HostedAuthPolicy['enterpriseSso']
  }
  socialProviders: readonly PublicSocialProvider[]
}

export type HostedAuthMethod = Exclude<keyof PublicHostedAuthConfig['methods'], 'enterpriseSso'>
export type SocialProviderCredentialResolver = (
  policy: SocialProviderPolicy,
  provider: string,
) => boolean

export type HostedAuthCapabilityResolver = (method: HostedAuthMethod) => boolean

function hostedAuthPolicy(tenant: TenantContext): HostedAuthPolicy {
  return tenant.policy?.hostedAuth ?? DEFAULT_HOSTED_AUTH_POLICY
}

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
      policy.jwksUri !== '')
  return (
    policy.enabled &&
    policy.clientId !== '' &&
    policy.authorizationEndpoint !== '' &&
    policy.tokenEndpoint !== '' &&
    profileReady &&
    hasSecret(policy, provider)
  )
}

function methodAllowedByIdentifierMode(
  policy: HostedAuthPolicy,
  method: HostedAuthMethod,
): boolean {
  if (method === 'magicLink' || method === 'emailOtp') {
    return policy.identifierMode === 'email' || policy.identifierMode === 'email_or_username'
  }
  if (method === 'whatsappOtp' || method === 'smsOtp') return policy.identifierMode === 'phone'
  return true
}

function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase()
}

export function emailDomain(email: string): string | null {
  const idx = email.lastIndexOf('@')
  if (idx <= 0 || idx === email.length - 1) return null
  return normalizeDomain(email.slice(idx + 1))
}

export function isHostedAuthPolicyError(value: unknown): value is HostedAuthPolicyError {
  return value instanceof HostedAuthPolicyError
}

function deny(reason: HostedAuthPolicyDenialReason): never {
  throw new HostedAuthPolicyError(reason)
}

function denyInvalidRequest(reason: HostedAuthPolicyDenialReason): never {
  throw new HostedAuthPolicyError(reason, 'invalid_request')
}

export function assertEmailAllowed(tenant: TenantContext, email: string | null): void {
  const policy = hostedAuthPolicy(tenant)
  if (!email) return
  const domain = emailDomain(email)
  if (!domain) deny('invalid_email')
  if (policy.blockedEmailDomains.includes(domain)) deny('email_domain_blocked')
  if (policy.allowedEmailDomains.length > 0 && !policy.allowedEmailDomains.includes(domain)) {
    deny('email_domain_not_allowed')
  }
}

export function assertMethodAvailable(tenant: TenantContext, method: HostedAuthMethod): void {
  return assertMethodAvailableWithCapabilities(tenant, method)
}

export function assertMethodAvailableWithCapabilities(
  tenant: TenantContext,
  method: HostedAuthMethod,
  hasCapability: HostedAuthCapabilityResolver = () => true,
): void {
  const policy = hostedAuthPolicy(tenant)
  if (policy.forceSso) deny('force_sso')
  if (!methodAllowedByIdentifierMode(policy, method)) deny('identifier_mode_not_allowed')
  if (!hasCapability(method)) deny('method_not_configured')
  const methodPolicy = policy[method]
  const canLogin = policy.allowExistingUserLogin && methodPolicy.allowLogin
  const canCreate = policy.allowUserCreation && methodPolicy.allowUserCreation
  if (!methodPolicy.enabled || (!canLogin && !canCreate)) {
    deny('method_disabled')
  }
}

export function assertMethodAllowed(
  tenant: TenantContext,
  method: HostedAuthMethod,
  action: 'login' | 'user_creation',
): void {
  return assertMethodAllowedWithCapabilities(tenant, method, action)
}

export function assertMethodAllowedWithCapabilities(
  tenant: TenantContext,
  method: HostedAuthMethod,
  action: 'login' | 'user_creation',
  hasCapability: HostedAuthCapabilityResolver = () => true,
): void {
  const policy = hostedAuthPolicy(tenant)
  if (policy.forceSso) deny('force_sso')
  if (action === 'login' && !policy.allowExistingUserLogin) deny('global_login_disabled')
  if (action === 'user_creation' && !policy.allowUserCreation) {
    deny('global_user_creation_disabled')
  }

  const methodPolicy = policy[method]
  if (!methodAllowedByIdentifierMode(policy, method)) deny('identifier_mode_not_allowed')
  if (!hasCapability(method)) deny('method_not_configured')
  if (!methodPolicy.enabled) deny('method_disabled')
  if (action === 'login' && !methodPolicy.allowLogin) deny('method_login_disabled')
  if (action === 'user_creation' && !methodPolicy.allowUserCreation) {
    deny('method_user_creation_disabled')
  }
}

// Guest 是 Hosted Auth 的平台扩展,没有独立 method policy,但仍必须服从全局登录/建号与 forceSso。
export function assertGuestAllowed(tenant: TenantContext, action: 'login' | 'user_creation'): void {
  const policy = hostedAuthPolicy(tenant)
  if (policy.forceSso) deny('force_sso')
  if (action === 'login' && !policy.allowExistingUserLogin) deny('global_login_disabled')
  if (action === 'user_creation' && !policy.allowUserCreation) {
    deny('global_user_creation_disabled')
  }
}

export function assertTenantResolvedForWebAuthn(tenant: TenantContext): void {
  if (tenant.resolution?.unresolvedRoot) denyInvalidRequest('instance_tenant_unresolved')
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

export function assertEnterpriseSsoAllowed(input: {
  tenant: TenantContext
  action: 'login' | 'user_creation' | 'logout'
  email: string | null
}): void {
  const { tenant, action, email } = input
  if (action === 'logout') return
  const policy = hostedAuthPolicy(tenant)
  const enterpriseSso = policy.enterpriseSso

  if (!enterpriseSso.enabled) deny('enterprise_sso_disabled')
  if (action === 'login' && !policy.allowExistingUserLogin) deny('global_login_disabled')
  if (action === 'user_creation' && !policy.allowUserCreation) {
    deny('global_user_creation_disabled')
  }
  if (!enterpriseSso.allowLogin) deny('enterprise_sso_login_disabled')
  if (action === 'user_creation' && !enterpriseSso.allowJitUserCreation) {
    deny('enterprise_sso_jit_user_creation_disabled')
  }

  assertEmailAllowed(tenant, email)

  const domain = email ? emailDomain(email) : null
  if (domain && enterpriseSso.blockedEmailDomains.includes(domain)) {
    deny('enterprise_sso_email_domain_blocked')
  }
  if (
    domain &&
    enterpriseSso.allowedEmailDomains.length > 0 &&
    !enterpriseSso.allowedEmailDomains.includes(domain)
  ) {
    deny('enterprise_sso_email_domain_not_allowed')
  }
}

export function publicHostedAuthConfig(
  tenant: TenantContext,
  hasSecret: SocialProviderCredentialResolver = () => false,
  hasCapability: HostedAuthCapabilityResolver = () => false,
): PublicHostedAuthConfig {
  const policy = hostedAuthPolicy(tenant)
  const providers = policy.forceSso
    ? []
    : Object.entries(tenant.policy?.socialProviders ?? {})
        .filter((entry) => hasSocialProviderCredentials(entry[1], entry[0], hasSecret))
        .filter((entry) => entry[1].allowLogin || entry[1].allowUserCreation)
        .map(([provider, providerPolicy]) => ({
          provider,
          allowLogin: providerPolicy.allowLogin,
          allowUserCreation: providerPolicy.allowUserCreation,
          requireVerifiedEmail: providerPolicy.requireVerifiedEmail,
          allowedEmailDomains: providerPolicy.allowedEmailDomains,
          blockedEmailDomains: providerPolicy.blockedEmailDomains,
        }))

  const whatsappOtp = hasCapability('whatsappOtp')
    ? policy.whatsappOtp
    : DEFAULT_HOSTED_AUTH_POLICY.whatsappOtp
  const smsOtp = hasCapability('smsOtp') ? policy.smsOtp : DEFAULT_HOSTED_AUTH_POLICY.smsOtp

  return {
    resolution: { status: 'ready' },
    identifierMode: policy.identifierMode,
    requireVerifiedEmail: policy.requireVerifiedEmail,
    allowedEmailDomains: policy.allowedEmailDomains,
    blockedEmailDomains: policy.blockedEmailDomains,
    forceSso: policy.forceSso,
    allowUserCreation: policy.allowUserCreation,
    allowExistingUserLogin: policy.allowExistingUserLogin,
    turnstileSiteKey: null,
    guest: null,
    profileFields: policy.profileFields,
    methods: {
      password: policy.password,
      magicLink: policy.magicLink,
      emailOtp: policy.emailOtp,
      whatsappOtp,
      smsOtp,
      passkey: policy.passkey,
      enterpriseSso: policy.enterpriseSso,
    },
    socialProviders: providers,
  }
}

export function ambiguousHostedAuthConfig(input: {
  matchedBy: string
  matches: readonly InstanceLoginMatch[]
}): PublicHostedAuthConfig {
  const methodDisabled: HostedAuthMethodPolicy = {
    enabled: false,
    allowLogin: false,
    allowUserCreation: false,
  }
  const tenant: TenantContext = {
    tenantId: '',
    issuer: '',
    rpId: '',
    signingKeys: { activeKid: '', defaultAlg: 'ES256', keys: [] },
    policy: { hostedAuth: DEFAULT_HOSTED_AUTH_POLICY },
  }
  return {
    ...publicHostedAuthConfig(tenant),
    resolution: {
      status: 'ambiguous',
      matchedBy: input.matchedBy,
      matches: input.matches.map((match) => ({
        organizationId: match.tenantId,
        slug: match.slug,
        name: match.name,
        issuer: match.issuer,
      })),
    },
    methods: {
      password: methodDisabled,
      magicLink: methodDisabled,
      emailOtp: methodDisabled,
      whatsappOtp: methodDisabled,
      smsOtp: methodDisabled,
      passkey: methodDisabled,
      enterpriseSso: {
        enabled: false,
        allowLogin: false,
        allowJitUserCreation: false,
        domainDiscovery: false,
        allowedEmailDomains: [],
        blockedEmailDomains: [],
      },
    },
    socialProviders: [],
  }
}
