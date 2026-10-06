// 登录页;枚举防护统一模糊失败文案;CLS 见 styles.ts。

import { Trans, useLingui } from '@lingui/react/macro'
import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { createLazyRoute, useSearch } from '@tanstack/react-router'
import * as stylex from '@stylexjs/stylex'
import { AuthLayout } from '../../components/layout'
import { Alert, PageHeader } from '../../components/ui'
import { useAuth } from '../../lib/auth-context'
import { Link, useNavigate } from '../../lib/router'
import { styles } from './styles'
import { SignInOtpPanel } from './SignInOtpPanel'
import { SignInPanel, SignInTabs } from './SignInTabs'
import { SignInSocialButtons } from './SignInSocialButtons'
import { SignInGuestButton } from './SignInGuestButton'
import { SignInPasswordPanel } from './SignInPasswordPanel'
import {
  EnterpriseSsoPanel,
  MagicLinkPanel,
  OrganizationChooser,
  PasskeyPanel,
} from './SignInMethodPanels'
import { useIdentifierAriaLabel, useIdentifierPlaceholder } from './SignInFields'
import { useSignIn } from './useSignIn'
import { useTurnstile } from './useTurnstile'
import { isProductSignUpIntent, isSignUpIntent } from '../../../shared/hosted-auth-intent'
import { forgotPasswordHref } from '../forgot-password/navigation'
import { useApiErrorMessage } from '@xid-kit/web-ui/api-error-message'
import type { ApiErrorInput } from '@xid-kit/web-ui/api-errors'
import {
  getEnabledOtpMethods,
  identifierPrompt,
  isSignInCorrectableErrorKey,
  requiredProfileFields,
  resolveOtpMethod,
  visibleProfileFields,
  type SignInCorrectableErrorKey,
  type SignInErrorKey,
} from './shared'
import { resolveHostedReturn } from './sign-in-flow'

// 互切 intent 时透传认证动线参数;verified/reauthenticate/select_account 为一次性不带。
const INTENT_SWITCH_KEYS = [
  'continue',
  'client_id',
  'invitation_token',
  'organization_id',
  'authz_request_id',
  'login_hint',
] as const

type SignInSearch = {
  intent?: string
  continue?: string
  redirect?: string
  client_id?: string
  invitation_token?: string
  organization_id?: string
  authz_request_id?: string
  login_hint?: string
  reauthenticate?: string
  select_account?: string
  verified?: string
  locale?: string
}

// 应用登录流里切到注册是应用注册(application-sign-up),产品注册 intent 不能与 client_id 组合。
function buildIntentSwitchSearch(search: SignInSearch, target: 'sign-in' | 'sign-up'): string {
  const params = new URLSearchParams()
  if (target === 'sign-up') {
    params.set('intent', search.client_id ? 'application-sign-up' : 'sign-up')
  }
  for (const key of INTENT_SWITCH_KEYS) {
    const value = search[key]
    if (value) params.set(key, value)
  }
  const query = params.toString()
  return query ? `?${query}` : ''
}

function correctableError(key: SignInCorrectableErrorKey): ApiErrorInput {
  return key === 'password_too_short'
    ? { code: 'validation_failed', meta: { paramName: 'password' } }
    : { code: key }
}

// 枚举防护:不区分用户不存在 / 密码错误。
function useErrorMessage(key: SignInErrorKey | null): string | null {
  const { t } = useLingui()
  const apiErrorMessage = useApiErrorMessage()
  if (key !== null && isSignInCorrectableErrorKey(key)) {
    return apiErrorMessage(correctableError(key), { surface: 'general' })
  }
  switch (key) {
    case 'auth_failed':
      return t`Sign-in failed. Please check your credentials and try again.`
    case 'rate_limited':
      return t`Too many attempts. Please wait a moment and try again.`
    case 'account_locked':
      return t`Your account has been temporarily locked. Please try again later.`
    case 'captcha_required':
      return t`Security verification failed. Please refresh and try again.`
    case 'network_error':
      return t`Unable to connect. Please check your connection and try again.`
    case 'passkey_unavailable':
      return t`Passkeys are not supported in this browser. Please use another sign-in method.`
    case 'identifier_required':
      return t`Enter the email, username, or phone number for your account first.`
    case 'sso_not_available':
      return t`This email domain does not use enterprise SSO. Please use another sign-in method.`
    case 'cancelled':
      return t`Sign-in was cancelled. Choose a sign-in method to try again.`
    case 'session_expired':
      return t`Your sign-in attempt expired. Please start again.`
    case 'sign_in_failed':
      return t`We couldn't sign you in with that account. Please try again or use another sign-in method.`
    default:
      return null
  }
}

function useSuccessMessage(key: SignInErrorKey | null): string | null {
  const { t } = useLingui()
  if (key === 'magic_link_sent')
    return t`Check your email for a sign-in link. It expires in 15 minutes.`
  if (key === 'verify_email_sent') {
    return t`Check your email to verify your account before signing in.`
  }
  return null
}

function SignInPage(): ReactNode {
  const { status } = useAuth()
  const navigate = useNavigate()
  const search = useSearch({ strict: false }) as SignInSearch
  const isInvitationFlow = Boolean(search.invitation_token)
  const isSignUpFlow = isInvitationFlow || isSignUpIntent(search.intent)
  const isProductSignUpFlow = isProductSignUpIntent(search.intent)
  const requiresExplicitInteraction = search.reauthenticate === '1' || search.select_account === '1'
  const [state, actions] = useSignIn()
  const { containerRef } = useTurnstile(
    state.authConfig.turnstileSiteKey,
    state.turnstileToken,
    actions.setTurnstileToken,
  )
  const errorMessage = useErrorMessage(state.error)
  const successMessage = useSuccessMessage(state.error)
  const signedInReturn = resolveHostedReturn(search, state.authConfig.defaultLandingPath)
  const isInvitationReturn = signedInReturn.startsWith('/accept-invitation?')
  // 邀请只走 Email claim:社交与企业 SSO 不接受邀请 capability(01 章 3)。
  const excludesFederatedEntry = isInvitationFlow || isInvitationReturn
  // 纵深:即使上游误传 passkey,sign-up 也不得暴露登录 ceremony。
  const enabledMethods = isSignUpFlow
    ? state.enabledMethods.filter((method) => method !== 'passkey')
    : state.enabledMethods
  const enabledOtpMethods = getEnabledOtpMethods(enabledMethods)
  const currentOtpMethod = resolveOtpMethod(state.method, enabledMethods)
  const isOtp = enabledOtpMethods.includes(currentOtpMethod) && state.method === currentOtpMethod
  const hasSocial =
    !excludesFederatedEntry &&
    !state.authConfig.forceSso &&
    state.authConfig.socialProviders.length > 0
  const showSeparator = hasSocial && enabledMethods.length > 0
  const prompt = identifierPrompt(state.authConfig)
  const identifierPlaceholder = useIdentifierPlaceholder(prompt)
  const identifierAriaLabel = useIdentifierAriaLabel(prompt)
  const passkeyOffered = !isSignUpFlow && enabledMethods.includes('passkey')
  const passkeyAutoComplete = `${prompt.autoComplete} webauthn`
  const passkeyReregistration = state.authConfig.passkeyEntry.reregistrationRequired
  const ambiguousResolution =
    state.authConfig.resolution.status === 'ambiguous' ? state.authConfig.resolution : null
  const configuredProfileFields = visibleProfileFields(state.authConfig, state.method)
  const configuredRequiredFields = requiredProfileFields(state.authConfig, state.method)
  const requiresInvitationEmail =
    isInvitationFlow && (state.method === 'otp-sms' || state.method === 'otp-whatsapp')
  const profileFields =
    requiresInvitationEmail && !configuredProfileFields.includes('email')
      ? (['email', ...configuredProfileFields] as const)
      : configuredProfileFields
  const requiredFields =
    requiresInvitationEmail && !configuredRequiredFields.includes('email')
      ? (['email', ...configuredRequiredFields] as const)
      : configuredRequiredFields
  const requiredProfileComplete = requiredFields.every(
    (field) => state.profileValues[field].trim() !== '',
  )
  const formProps = { profileFields, requiredFields, requiredProfileComplete }

  // 授权/邀请续跑原流程;普通 sign-up 进组织 onboarding。
  useEffect(() => {
    if (status !== 'authenticated' || requiresExplicitInteraction) return
    if (isProductSignUpFlow && !isInvitationReturn && !state.tenantSelection.authzRequestId) {
      navigate('/create-organization', { replace: true })
      return
    }
    navigate(signedInReturn, { replace: true })
  }, [
    isInvitationReturn,
    isProductSignUpFlow,
    navigate,
    requiresExplicitInteraction,
    signedInReturn,
    state.tenantSelection.authzRequestId,
    status,
  ])

  return (
    <AuthLayout
      footer={
        <p {...stylex.props(styles.footerText)}>
          <Trans>
            Use the same entry for sign-in and account creation. Organization policy decides which
            actions are allowed.
          </Trans>
        </p>
      }
    >
      <div {...stylex.props(styles.stack)}>
        <PageHeader
          title={isSignUpFlow ? <Trans>Create your account</Trans> : <Trans>Sign in</Trans>}
        />

        {errorMessage ? (
          <Alert tone="error">{errorMessage}</Alert>
        ) : successMessage ? (
          <Alert tone="success">{successMessage}</Alert>
        ) : search.verified === '1' ? (
          <Alert tone="success">
            <Trans>Your email has been verified. Sign in to continue.</Trans>
          </Alert>
        ) : null}

        <div ref={containerRef} {...stylex.props(styles.turnstile)} />

        <SignInSocialButtons
          providers={state.authConfig.socialProviders}
          onSelect={actions.handleSocial}
          isLoading={state.isLoading}
          disabled={!state.turnstileReady}
        />

        {showSeparator ? (
          <div role="separator" aria-hidden="true" {...stylex.props(styles.separator)}>
            <span {...stylex.props(styles.separatorRule)} />
            <Trans>or</Trans>
            <span {...stylex.props(styles.separatorRule)} />
          </div>
        ) : null}

        {enabledMethods.length > 1 ? (
          <SignInTabs
            method={state.method}
            passkeySupport={state.passkeySupport}
            passkeyLast={passkeyReregistration}
            enabledMethods={enabledMethods}
            isSignUpFlow={isSignUpFlow}
            onSelect={actions.setMethod}
          />
        ) : null}

        {enabledMethods.length === 0 && !ambiguousResolution ? (
          <Alert tone="error">
            <Trans>No sign-in methods are available for this organization.</Trans>
          </Alert>
        ) : null}

        {ambiguousResolution ? (
          <OrganizationChooser
            matches={ambiguousResolution.matches}
            onSelect={actions.selectOrganizationContext}
          />
        ) : null}

        {enabledMethods.length > 0 && !ambiguousResolution ? (
          <div {...stylex.props(styles.panelHost)}>
            {enabledMethods.includes('enterprise-sso') ? (
              <SignInPanel active={state.method === 'enterprise-sso'}>
                <EnterpriseSsoPanel state={state} actions={actions} />
              </SignInPanel>
            ) : null}

            {passkeyOffered ? (
              <SignInPanel active={state.method === 'passkey'}>
                <PasskeyPanel
                  state={state}
                  actions={actions}
                  prompt={prompt}
                  identifierPlaceholder={identifierPlaceholder}
                  identifierAriaLabel={identifierAriaLabel}
                  identifierAutoComplete={passkeyAutoComplete}
                  reregistrationRequired={passkeyReregistration}
                />
              </SignInPanel>
            ) : null}

            {enabledMethods.includes('password') ? (
              <SignInPanel active={state.method === 'password'}>
                <SignInPasswordPanel
                  state={state}
                  actions={actions}
                  prompt={prompt}
                  identifierPlaceholder={identifierPlaceholder}
                  identifierAutoComplete={
                    passkeyOffered ? passkeyAutoComplete : prompt.autoComplete
                  }
                  isSignUpFlow={isSignUpFlow}
                  forgotPasswordHref={forgotPasswordHref({
                    ...search,
                    login_hint: state.identifier.trim() || search.login_hint,
                  })}
                  {...formProps}
                />
              </SignInPanel>
            ) : null}

            {enabledMethods.includes('magic-link') ? (
              <SignInPanel active={state.method === 'magic-link'}>
                <MagicLinkPanel
                  state={state}
                  actions={actions}
                  isSignUpFlow={isSignUpFlow}
                  {...formProps}
                />
              </SignInPanel>
            ) : null}

            {enabledOtpMethods.length > 0 ? (
              <SignInPanel active={isOtp}>
                <SignInOtpPanel
                  method={currentOtpMethod}
                  enabledMethods={enabledOtpMethods}
                  step={state.otpStep}
                  identifier={state.identifier}
                  otpCode={state.otpCode}
                  profileValues={state.profileValues}
                  profileFields={profileFields}
                  requiredProfileFields={requiredFields}
                  isLoading={state.isLoading}
                  isTurnstileReady={state.turnstileReady}
                  onChangeIdentifier={actions.setIdentifier}
                  onChangeProfileValue={actions.setProfileValue}
                  onChangeCode={actions.setOtpCode}
                  onSwitchMethod={actions.setMethod}
                  onRequestOtp={actions.submitOtpRequest}
                  onVerifyOtp={actions.submitOtpVerify}
                />
              </SignInPanel>
            ) : null}
          </div>
        ) : null}

        {ambiguousResolution ? null : state.authConfig.guest ? (
          <SignInGuestButton
            onContinue={actions.submitGuest}
            isLoading={state.isLoading}
            disabled={!state.turnstileReady}
          />
        ) : state.guestEntryPending ? (
          <div aria-hidden="true" {...stylex.props(styles.guestEntryPlaceholder)} />
        ) : null}

        <p {...stylex.props(styles.footerText, styles.intentSwitch)}>
          {isSignUpFlow ? (
            <Link
              to={{ pathname: '/sign-in', search: buildIntentSwitchSearch(search, 'sign-in') }}
              {...stylex.props(styles.textLink)}
            >
              <Trans>Already have an account? Sign in</Trans>
            </Link>
          ) : (
            <Link
              to={{ pathname: '/sign-in', search: buildIntentSwitchSearch(search, 'sign-up') }}
              {...stylex.props(styles.textLink)}
            >
              <Trans>New here? Create an account</Trans>
            </Link>
          )}
        </p>
      </div>
    </AuthLayout>
  )
}

export const Route = createLazyRoute('/sign-in')({
  component: SignInPage,
})
