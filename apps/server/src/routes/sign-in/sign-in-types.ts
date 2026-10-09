import type { AuthMethod } from '../../lib/google-analytics-funnel'
import type { PublicHostedAuthConfig } from './auth-config'
import type { IdentifierKind } from './method-order'
import type { ProfileFieldKey, ProfileValues, SignInErrorKey, SignInMethod } from './shared'
import type { PasskeySupport } from './usePasskeySignIn'
import type { SsoTarget } from './useSsoDiscovery'
import type { OtpSendStatus, TurnstileGate } from './turnstile-gate'

// identifier:只收标识符;methods:回显标识符后选一种方式;sso:跳转 IdP 的过渡屏;
// organization:根入口的标识符对应多个组织,先选组织。
export type SignInStep = 'identifier' | 'methods' | 'sso' | 'organization'

export type SignInSearch = {
  authz_request_id?: string
  continue?: string
  login_hint?: string
  redirect?: string
  organization_id?: string
  client_id?: string
  intent?: string
  invitation_token?: string
  error?: string
}

export const AUTH_METHOD_BY_SIGN_IN_METHOD: Readonly<Record<SignInMethod, AuthMethod>> = {
  'magic-link': 'magic_link',
  'otp-email': 'otp_email',
  'otp-whatsapp': 'otp_whatsapp',
  'otp-sms': 'otp_sms',
  'enterprise-sso': 'enterprise_sso',
  passkey: 'passkey',
  password: 'password',
}

export type SignInState = {
  step: SignInStep
  method: SignInMethod
  methods: readonly SignInMethod[]
  authConfig: PublicHostedAuthConfig
  configSettled: boolean
  enabledMethods: readonly SignInMethod[]
  identifier: string
  identifierKind: IdentifierKind
  isSignUpFlow: boolean
  profileValues: ProfileValues
  password: string
  rememberMe: boolean
  otpCode: string
  otpSentAt: number | null
  otpResent: boolean
  otpSendStatus: OtpSendStatus
  // 只表示发码请求在途;等待 Turnstile 不算发送中。
  isSendingOtp: boolean
  isVerifyingOtp: boolean
  magicLinkSent: boolean
  ssoTarget: SsoTarget | null
  isLoading: boolean
  passkeySupport: PasskeySupport
  passkeyConditionalAvailable: boolean
  conditionalUiRunning: boolean
  error: SignInErrorKey | null
  turnstileToken: string | null
  turnstileReady: boolean
  turnstileGate: TurnstileGate
  excludesFederatedEntry: boolean
  hostedReturn: string
  // config 未返回且 URL 不排除 guest 时为 true,页面固定高度占位防 CLS。
  guestEntryPending: boolean
  tenantSelection: {
    loginHint: string | null
    continueParam: string | null
    redirect: string | null
    authzRequestId: string | null
  }
}

export type SignInActions = {
  setIdentifier: (value: string) => void
  setProfileValue: (field: ProfileFieldKey, value: string) => void
  setPassword: (value: string) => void
  setRememberMe: (value: boolean) => void
  setOtpCode: (value: string) => void
  setTurnstileToken: (token: string) => void
  submitIdentifier: (options?: { ssoOnly?: boolean }) => void
  changeIdentifier: () => void
  chooseMethod: (method: SignInMethod) => void
  submitPassword: () => void
  submitMagicLink: () => void
  requestOtp: () => void
  verifyOtp: (code: string) => void
  triggerPasskeyButton: () => void
  triggerEarlierPasskeyButton: () => void
  submitGuest: () => void
  handleSocial: (provider: string) => void
  selectOrganizationContext: (organizationId: string) => void
}
