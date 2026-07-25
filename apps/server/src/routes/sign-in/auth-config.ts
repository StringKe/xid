import type { HostedAuthMethodPolicy, HostedAuthPolicy } from '@xid-kit/types'

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

export function enterpriseSsoEnabled(config: PublicHostedAuthConfig): boolean {
  const methodConfig = config.methods.enterpriseSso
  return methodConfig.enabled && methodConfig.allowLogin && methodConfig.domainDiscovery
}
