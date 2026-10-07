import { ACCOUNT_EXACT_PATH } from '@xid-kit/types'
import type {
  DefaultLandingPath,
  HostedAuthMethodPolicy,
  HostedAuthPolicy,
  OrgBranding,
} from '@xid-kit/types'

export type PublicInstanceLoginMatch = {
  organizationId: string
  slug: string
  name: string
  issuer: string
}

export type PublicSocialProvider = {
  provider: string
  allowLogin: boolean
  allowUserCreation: boolean
  requireVerifiedEmail: boolean
  allowedEmailDomains: readonly string[]
  blockedEmailDomains: readonly string[]
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
  passkeyEntry: {
    identifierRequired: boolean
    reregistrationRequired: boolean
  }
  defaultLandingPath: DefaultLandingPath
  branding: OrgBranding | null
  context: HostedAuthContext
}

export type HostedAuthContext = {
  organizationName: string | null
  applicationName: string | null
  applicationLogoUrl: string | null
}

const METHOD_DISABLED: HostedAuthMethodPolicy = {
  enabled: false,
  allowLogin: false,
  allowUserCreation: false,
}

export const DEFAULT_PUBLIC_AUTH_CONFIG: PublicHostedAuthConfig = {
  resolution: { status: 'ready' },
  identifierMode: 'email',
  requireVerifiedEmail: true,
  allowedEmailDomains: [],
  blockedEmailDomains: [],
  forceSso: false,
  allowUserCreation: true,
  allowExistingUserLogin: true,
  turnstileSiteKey: null,
  guest: null,
  profileFields: {
    email: 'required',
    username: 'hidden',
    phone: 'hidden',
    name: 'hidden',
    givenName: 'hidden',
    familyName: 'hidden',
  },
  methods: {
    password: METHOD_DISABLED,
    magicLink: { enabled: true, allowLogin: true, allowUserCreation: true },
    emailOtp: { enabled: true, allowLogin: true, allowUserCreation: true },
    whatsappOtp: METHOD_DISABLED,
    smsOtp: METHOD_DISABLED,
    passkey: METHOD_DISABLED,
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
  passkeyEntry: { identifierRequired: false, reregistrationRequired: false },
  defaultLandingPath: ACCOUNT_EXACT_PATH,
  branding: null,
  context: { organizationName: null, applicationName: null, applicationLogoUrl: null },
}

export function methodEnabled(
  config: PublicHostedAuthConfig,
  method: keyof PublicHostedAuthConfig['methods'],
): boolean {
  if (method === 'enterpriseSso') return enterpriseSsoEnabled(config)
  const methodConfig: HostedAuthMethodPolicy = config.methods[method]
  return (
    methodConfig.enabled &&
    ((config.allowExistingUserLogin && methodConfig.allowLogin) ||
      (config.allowUserCreation && methodConfig.allowUserCreation))
  )
}

export function selfSignUpAvailable(config: PublicHostedAuthConfig): boolean {
  if (!config.allowUserCreation || config.forceSso) return false
  const { password, magicLink, emailOtp, whatsappOtp, smsOtp } = config.methods
  const methodAllows = [password, magicLink, emailOtp, whatsappOtp, smsOtp].some(
    (method) => method.enabled && method.allowUserCreation,
  )
  return methodAllows || config.socialProviders.some((provider) => provider.allowUserCreation)
}

export function enterpriseSsoEnabled(config: PublicHostedAuthConfig): boolean {
  const methodConfig = config.methods.enterpriseSso
  return methodConfig.enabled && methodConfig.allowLogin && methodConfig.domainDiscovery
}
