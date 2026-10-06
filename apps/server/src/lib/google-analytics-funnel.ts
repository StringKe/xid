import { trackEvent } from './google-analytics'

export type AuthMethod =
  | 'password'
  | 'passkey'
  | 'magic_link'
  | 'otp_email'
  | 'otp_sms'
  | 'otp_whatsapp'
  | 'social'
  | 'enterprise_sso'
  | 'guest'
  | 'unknown'

export type AuthFlowIntent = 'sign_in' | 'sign_up'

export function trackAuthSuccess(input: { method: AuthMethod; intent: AuthFlowIntent }): void {
  if (input.intent === 'sign_up') {
    trackEvent('sign_up', { method: input.method })
  }
  trackEvent('login', { method: input.method })
}

export function trackMfaComplete(
  method: 'totp' | 'passkey' | 'sms' | 'email' | 'backup_code',
): void {
  trackEvent('mfa_complete', { method })
}

export function trackEmailVerified(): void {
  trackEvent('email_verified')
}

export function trackOrganizationCreated(): void {
  trackEvent('organization_created')
  trackEvent('generate_lead', { lead_type: 'organization' })
}

export function trackConsentDecision(approved: boolean): void {
  trackEvent(approved ? 'consent_granted' : 'consent_denied')
}

export function trackInvitationAccepted(): void {
  trackEvent('invitation_accepted')
}

export function trackPasswordResetComplete(): void {
  trackEvent('password_reset_complete')
}

// 目前只有账户安全页注册 passkey;登录后的渐进式注册尚未实现。
export function trackPasskeyRegistered(): void {
  trackEvent('passkey_registered', { context: 'account' })
}

export function trackLogout(): void {
  trackEvent('logout')
}

export function trackPasswordResetRequest(): void {
  trackEvent('password_reset_request')
}

export function trackMagicLinkSent(intent: AuthFlowIntent): void {
  trackEvent('magic_link_sent', { intent })
}

export type OtpChannel = 'email' | 'sms' | 'whatsapp'

export function trackOtpSent(channel: OtpChannel, intent: AuthFlowIntent): void {
  trackEvent('otp_sent', { channel, intent })
}

export function trackAuthMethodSelected(method: AuthMethod): void {
  trackEvent('auth_method_selected', { method })
}

export function trackOrganizationSelected(): void {
  trackEvent('organization_selected')
}

export function trackOrganizationSwitched(): void {
  trackEvent('organization_switched')
}

export function trackDeviceActivationDecision(approved: boolean): void {
  trackEvent(approved ? 'device_activation_approved' : 'device_activation_denied')
}

export function trackCibaActivationDecision(approved: boolean): void {
  trackEvent(approved ? 'ciba_activation_approved' : 'ciba_activation_denied')
}

export function trackLocaleChange(fromLocale: string, toLocale: string): void {
  trackEvent('locale_change', { from_locale: fromLocale, to_locale: toLocale })
}

export function trackPasswordChanged(): void {
  trackEvent('password_changed')
}

export type MfaEnrollType = 'totp' | 'backup_codes' | 'sms'

export function trackMfaFactorEnrolled(type: MfaEnrollType): void {
  trackEvent('mfa_factor_enrolled', { factor_type: type })
}

export function trackSocialDisconnected(provider: string): void {
  trackEvent('social_disconnected', { provider })
}
