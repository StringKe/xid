// 登录共享:枚举防护统一模糊错误;回跳仅允许同源相对路径。

import type { XidErrorCode } from '@xid-kit/types'
import type { PublicHostedAuthConfig } from './auth-config'
import { enterpriseSsoEnabled, methodEnabled } from './auth-config'
import type { PublicInstanceLoginMatch } from './auth-config'

export type SignInMethod =
  | 'enterprise-sso'
  | 'passkey'
  | 'password'
  | 'magic-link'
  | 'otp-email'
  | 'otp-whatsapp'
  | 'otp-sms'

export type OtpSignInMethod = Extract<SignInMethod, 'otp-email' | 'otp-whatsapp' | 'otp-sms'>
export type IdentifierPrompt = {
  mode: PublicHostedAuthConfig['identifierMode']
  type: 'email' | 'tel' | 'text'
  autoComplete: string
}

export type ProfileFieldKey = 'email' | 'username' | 'phone' | 'name' | 'givenName' | 'familyName'

export type ProfileValues = Record<ProfileFieldKey, string>

export const SIGN_IN_METHODS: readonly SignInMethod[] = [
  'enterprise-sso',
  'passkey',
  'password',
  'magic-link',
  'otp-email',
  'otp-whatsapp',
  'otp-sms',
]

const OTP_METHODS: readonly OtpSignInMethod[] = ['otp-email', 'otp-whatsapp', 'otp-sms']

function emailIdentifierAvailable(config: PublicHostedAuthConfig): boolean {
  return config.identifierMode === 'email' || config.identifierMode === 'email_or_username'
}

function phoneIdentifierAvailable(config: PublicHostedAuthConfig): boolean {
  return config.identifierMode === 'phone'
}

export function enabledSignInMethods(config: PublicHostedAuthConfig): readonly SignInMethod[] {
  if (config.resolution.status === 'ambiguous') return []
  if (config.forceSso) return enterpriseSsoEnabled(config) ? ['enterprise-sso'] : []
  return SIGN_IN_METHODS.filter((item) => {
    if (item === 'enterprise-sso') return enterpriseSsoEnabled(config)
    if (item === 'otp-email')
      return emailIdentifierAvailable(config) && methodEnabled(config, 'emailOtp')
    if (item === 'otp-sms')
      return phoneIdentifierAvailable(config) && methodEnabled(config, 'smsOtp')
    if (item === 'otp-whatsapp')
      return phoneIdentifierAvailable(config) && methodEnabled(config, 'whatsappOtp')
    if (item === 'magic-link')
      return emailIdentifierAvailable(config) && methodEnabled(config, 'magicLink')
    return methodEnabled(config, item)
  })
}

export function initialSignInMethod(config: PublicHostedAuthConfig): SignInMethod {
  return enabledSignInMethods(config)[0] ?? 'enterprise-sso'
}

export function identifierPrompt(config: PublicHostedAuthConfig): IdentifierPrompt {
  switch (config.identifierMode) {
    case 'username':
      return {
        mode: 'username',
        type: 'text',
        autoComplete: 'username',
      }
    case 'email_or_username':
      return {
        mode: 'email_or_username',
        type: 'text',
        autoComplete: 'username',
      }
    case 'phone':
      return {
        mode: 'phone',
        type: 'tel',
        autoComplete: 'tel',
      }
    case 'external_id':
      return {
        mode: 'external_id',
        type: 'text',
        autoComplete: 'off',
      }
    case 'email':
    default:
      return {
        mode: 'email',
        type: 'email',
        autoComplete: 'email',
      }
  }
}

export function isOtpMethod(method: SignInMethod): method is OtpSignInMethod {
  return method === 'otp-email' || method === 'otp-whatsapp' || method === 'otp-sms'
}

export function getEnabledOtpMethods(
  enabledMethods: readonly SignInMethod[],
): readonly OtpSignInMethod[] {
  return OTP_METHODS.filter((item) => enabledMethods.includes(item))
}

export function shouldShowOtpMethodSwitch(enabledMethods: readonly OtpSignInMethod[]): boolean {
  return enabledMethods.length > 1
}

export function resolveOtpMethod(
  method: SignInMethod,
  enabledMethods: readonly SignInMethod[],
): OtpSignInMethod {
  const enabledOtpMethods = getEnabledOtpMethods(enabledMethods)
  if (isOtpMethod(method) && enabledOtpMethods.includes(method)) return method
  return enabledOtpMethods[0] ?? 'otp-email'
}

export function emptyProfileValues(): ProfileValues {
  return {
    email: '',
    username: '',
    phone: '',
    name: '',
    givenName: '',
    familyName: '',
  }
}

export function visibleProfileFields(
  config: PublicHostedAuthConfig,
  method: SignInMethod,
): readonly ProfileFieldKey[] {
  if (config.resolution.status === 'ambiguous') return []
  const fields = config.profileFields
  const requiresCreation =
    (method === 'password' && config.methods.password.allowUserCreation) ||
    (method === 'magic-link' && config.methods.magicLink.allowUserCreation) ||
    (method === 'otp-email' && config.methods.emailOtp.allowUserCreation) ||
    (method === 'otp-whatsapp' && config.methods.whatsappOtp.allowUserCreation) ||
    (method === 'otp-sms' && config.methods.smsOtp.allowUserCreation)
  if (!config.allowUserCreation || !requiresCreation) return []
  const identityFields = identifierProfileFields(config, method)
  return (Object.keys(fields) as ProfileFieldKey[])
    .filter((field) => fields[field] !== 'hidden')
    .filter((field) => !identityFields.includes(field))
}

export function requiredProfileFields(
  config: PublicHostedAuthConfig,
  method: SignInMethod,
): readonly ProfileFieldKey[] {
  return visibleProfileFields(config, method).filter(
    (field) => config.profileFields[field] === 'required',
  )
}

export function profilePayload(values: ProfileValues): Partial<ProfileValues> {
  return Object.fromEntries(
    Object.entries(values)
      .map(([key, value]) => [key, value.trim()] as const)
      .filter((entry) => entry[1] !== ''),
  ) as Partial<ProfileValues>
}

function identifierProfileFields(
  config: PublicHostedAuthConfig,
  method: SignInMethod,
): readonly ProfileFieldKey[] {
  if (method === 'magic-link' || method === 'otp-email') return ['email']
  if (method === 'otp-whatsapp' || method === 'otp-sms') return ['phone']
  if (method !== 'password' && method !== 'passkey') return []
  if (config.identifierMode === 'email') return ['email']
  if (config.identifierMode === 'username') return ['username']
  if (config.identifierMode === 'phone') return ['phone']
  return []
}

export type SignInErrorKey =
  | 'auth_failed'
  | 'rate_limited'
  | 'account_locked'
  | 'captcha_required'
  | 'network_error'
  | 'magic_link_sent'
  | 'otp_sent'
  | 'verify_email_sent'
  | 'passkey_unavailable'

// 认证类错误统一收敛为 auth_failed(枚举防护)。
export function apiErrorToKey(code: XidErrorCode): SignInErrorKey {
  if (code === 'rate_limited') return 'rate_limited'
  if (code === 'account_locked' || code === 'account_suspended' || code === 'account_banned') {
    return 'account_locked'
  }
  if (code === 'captcha_required' || code === 'captcha_failed') return 'captcha_required'
  if (code === 'service_unavailable' || code === 'server_error') return 'network_error'
  return 'auth_failed'
}

const DEFAULT_SIGN_IN_RETURN_PATH = '/console'

// 只允许同源相对路径,避免 open redirect。
export function resolveRedirect(continueUrl: string | null | undefined): string {
  if (!continueUrl) return DEFAULT_SIGN_IN_RETURN_PATH
  try {
    const url = new URL(continueUrl, globalThis.location.origin)
    if (url.origin === globalThis.location.origin) return url.pathname + url.search + url.hash
  } catch {
  }
  return DEFAULT_SIGN_IN_RETURN_PATH
}

export function resolveHostedReturn(
  continueUrl: string | null | undefined,
  authzRequestId: string | null | undefined,
  applicationClientId?: string | null,
): string {
  if (authzRequestId) {
    const params = new URLSearchParams({ authz_request_id: authzRequestId })
    if (applicationClientId) params.set('client_id', applicationClientId)
    return `/authorize?${params.toString()}`
  }
  return resolveRedirect(continueUrl)
}

export function organizationSignInUrl(
  match: PublicInstanceLoginMatch,
  input: {
    loginHint?: string | null
    continueParam?: string | null
    redirect?: string | null
    authzRequestId?: string | null
    intent?: string | null
    invitationToken?: string | null
  },
): string {
  const url = new URL('/sign-in', globalThis.location.origin)
  url.searchParams.set('organization_id', match.organizationId)
  if (input.loginHint) url.searchParams.set('login_hint', input.loginHint)
  if (input.authzRequestId) url.searchParams.set('authz_request_id', input.authzRequestId)
  if (input.continueParam) url.searchParams.set('continue', input.continueParam)
  if (input.redirect) url.searchParams.set('redirect', input.redirect)
  if (input.intent) url.searchParams.set('intent', input.intent)
  if (input.invitationToken) url.searchParams.set('invitation_token', input.invitationToken)
  return url.toString()
}
