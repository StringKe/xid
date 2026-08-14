// 登录页;枚举防护统一模糊失败文案;CLS 见 styles.ts。

import { Trans, useLingui } from '@lingui/react/macro'
import { useEffect } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { createLazyRoute, useSearch } from '@tanstack/react-router'
import * as stylex from '@stylexjs/stylex'
import { AuthLayout } from '../../components/layout'
import { Alert, Button, Field, Input, PageHeader } from '../../components/ui'
import { useAuth } from '../../lib/auth-context'
import { Link, useNavigate } from '../../lib/router'
import { styles } from './styles'
import { SignInOtpPanel } from './SignInOtpPanel'
import { SignInPanel, SignInTabs } from './SignInTabs'
import { SignInSocialButtons } from './SignInSocialButtons'
import { SignInGuestButton } from './SignInGuestButton'
import { useSignIn } from './useSignIn'
import { useTurnstile } from './useTurnstile'
import { isProductSignUpIntent, isSignUpIntent } from '../../../shared/hosted-auth-intent'
import { forgotPasswordHref } from '../forgot-password/navigation'
import {
  getEnabledOtpMethods,
  identifierPrompt,
  requiredProfileFields,
  resolveHostedReturn,
  resolveOtpMethod,
  visibleProfileFields,
  type IdentifierPrompt,
  type ProfileFieldKey,
  type SignInErrorKey,
} from './shared'

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

function buildIntentSwitchSearch(search: SignInSearch, target: 'sign-in' | 'sign-up'): string {
  const params = new URLSearchParams()
  if (target === 'sign-up') params.set('intent', 'sign-up')
  for (const key of INTENT_SWITCH_KEYS) {
    const value = search[key]
    if (value) params.set(key, value)
  }
  const query = params.toString()
  return query ? `?${query}` : ''
}

// 枚举防护:不区分用户不存在 / 密码错误。
function useErrorMessage(key: SignInErrorKey | null): string | null {
  const { t } = useLingui()
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

function IdentifierLabel({ prompt }: { prompt: IdentifierPrompt }): ReactNode {
  switch (prompt.mode) {
    case 'username':
      return <Trans>Username</Trans>
    case 'email_or_username':
      return <Trans>Email or username</Trans>
    case 'phone':
      return <Trans>Phone number</Trans>
    case 'external_id':
      return <Trans>External ID</Trans>
    case 'email':
    default:
      return <Trans>Email address</Trans>
  }
}

function useIdentifierPlaceholder(prompt: IdentifierPrompt): string {
  const { t } = useLingui()
  switch (prompt.mode) {
    case 'username':
      return t`username`
    case 'phone':
      return t`+1 555 000 0000`
    case 'external_id':
      return t`external-id`
    case 'email':
    case 'email_or_username':
    default:
      return t`you@example.com`
  }
}

function useIdentifierAriaLabel(prompt: IdentifierPrompt): string {
  const { t } = useLingui()
  switch (prompt.mode) {
    case 'username':
      return t`Username`
    case 'email_or_username':
      return t`Email or username`
    case 'phone':
      return t`Phone number`
    case 'external_id':
      return t`External ID`
    case 'email':
    default:
      return t`Email address`
  }
}

function ProfileFieldInput({
  field,
  value,
  required,
  disabled,
  onChange,
}: {
  field: ProfileFieldKey
  value: string
  required: boolean
  disabled: boolean
  onChange: (field: ProfileFieldKey, value: string) => void
}): ReactNode {
  const { t } = useLingui()
  const label =
    field === 'username' ? (
      <Trans>Username</Trans>
    ) : field === 'phone' ? (
      <Trans>Phone number</Trans>
    ) : field === 'name' ? (
      <Trans>Name</Trans>
    ) : field === 'givenName' ? (
      <Trans>First name</Trans>
    ) : field === 'familyName' ? (
      <Trans>Last name</Trans>
    ) : (
      <Trans>Email address</Trans>
    )
  return (
    <Field label={label} required={required}>
      <Input
        type={field === 'email' ? 'email' : field === 'phone' ? 'tel' : 'text'}
        autoComplete={field === 'email' ? 'email' : field === 'phone' ? 'tel' : 'name'}
        placeholder={field === 'email' ? t`you@example.com` : ''}
        value={value}
        onChange={(event) => onChange(field, event.target.value)}
        disabled={disabled}
      />
    </Field>
  )
}

function ProfileFields({
  fields,
  requiredFields,
  values,
  disabled,
  onChange,
}: {
  fields: readonly ProfileFieldKey[]
  requiredFields: readonly ProfileFieldKey[]
  values: Record<ProfileFieldKey, string>
  disabled: boolean
  onChange: (field: ProfileFieldKey, value: string) => void
}): ReactNode {
  if (fields.length === 0) return null
  return (
    <>
      {fields.map((field) => (
        <ProfileFieldInput
          key={field}
          field={field}
          value={values[field]}
          required={requiredFields.includes(field)}
          disabled={disabled}
          onChange={onChange}
        />
      ))}
    </>
  )
}

function SignInPage(): ReactNode {
  const { status } = useAuth()
  const navigate = useNavigate()
  const search = useSearch({ strict: false }) as SignInSearch
  const isInvitationFlow = Boolean(search.invitation_token)
  const isSignUpFlow = isInvitationFlow || isSignUpIntent(search.intent)
  const isProductSignUpFlow = isProductSignUpIntent(search.intent)
  const requiresExplicitInteraction = search.reauthenticate === '1' || search.select_account === '1'
  const { t } = useLingui()
  const [state, actions] = useSignIn()
  const { containerRef } = useTurnstile(
    state.authConfig.turnstileSiteKey,
    state.turnstileToken,
    actions.setTurnstileToken,
  )
  const errorMessage = useErrorMessage(state.error)
  const successMessage = useSuccessMessage(state.error)
  // 纵深:即使上游误传 passkey,sign-up 也不得暴露登录 ceremony。
  const enabledMethods = isSignUpFlow
    ? state.enabledMethods.filter((method) => method !== 'passkey')
    : state.enabledMethods
  const enabledOtpMethods = getEnabledOtpMethods(enabledMethods)
  const currentOtpMethod = resolveOtpMethod(state.method, enabledMethods)
  const isOtp = enabledOtpMethods.includes(currentOtpMethod) && state.method === currentOtpMethod
  const hasSocial = !state.authConfig.forceSso && state.authConfig.socialProviders.length > 0
  const hasTabs = enabledMethods.length > 1
  const showSeparator = hasSocial && enabledMethods.length > 0
  const prompt = identifierPrompt(state.authConfig)
  const identifierPlaceholder = useIdentifierPlaceholder(prompt)
  const identifierAriaLabel = useIdentifierAriaLabel(prompt)
  const passkeyAutoComplete = `${prompt.autoComplete} webauthn`
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

  const signedInReturn = resolveHostedReturn(
    state.tenantSelection.continueParam ?? state.tenantSelection.redirect,
    state.tenantSelection.authzRequestId,
    search.client_id,
  )
  const isInvitationReturn = signedInReturn.startsWith('/accept-invitation?')

  // 授权/邀请续跑原流程;普通 sign-up 进组织 onboarding。
  useEffect(() => {
    if (status !== 'authenticated' || requiresExplicitInteraction) return
    if (state.tenantSelection.authzRequestId) {
      globalThis.location.href = signedInReturn
      return
    }
    if (isProductSignUpFlow && !isInvitationReturn) {
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

  function handlePasswordSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    actions.submitPassword()
  }

  function handleEnterpriseSsoSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    actions.submitEnterpriseSso()
  }

  function handleMagicLinkSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    actions.submitMagicLink()
  }

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

        <p {...stylex.props(styles.footerText)}>
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

        {hasTabs ? (
          <SignInTabs
            method={state.method}
            passkeySupport={state.passkeySupport}
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
          <div {...stylex.props(styles.panel)}>
            <Alert tone="info">
              <Trans>Choose an organization to continue.</Trans>
            </Alert>
            {ambiguousResolution.matches.map((match) => (
              <Button
                key={match.organizationId}
                type="button"
                fullWidth
                onClick={() => actions.selectOrganizationContext(match.organizationId)}
              >
                {match.name}
              </Button>
            ))}
          </div>
        ) : null}

        {enabledMethods.length > 0 && !ambiguousResolution ? (
          <div {...stylex.props(styles.panelHost)}>
            {enabledMethods.includes('enterprise-sso') ? (
              <SignInPanel active={state.method === 'enterprise-sso'}>
                <form
                  onSubmit={handleEnterpriseSsoSubmit}
                  noValidate
                  {...stylex.props(styles.panel)}
                  aria-label={t`Continue with SSO`}
                >
                  <Field label={<Trans>Work email</Trans>} required>
                    <Input
                      type="email"
                      autoComplete="email"
                      placeholder={t`you@example.com`}
                      value={state.identifier}
                      onChange={(e) => actions.setIdentifier(e.target.value)}
                      disabled={state.isLoading}
                    />
                  </Field>
                  <Button
                    type="submit"
                    fullWidth
                    isLoading={state.isLoading}
                    disabled={!state.identifier.trim() || !state.turnstileReady}
                  >
                    <Trans>Continue with SSO</Trans>
                  </Button>
                </form>
              </SignInPanel>
            ) : null}

            {!isSignUpFlow && enabledMethods.includes('passkey') ? (
              <SignInPanel active={state.method === 'passkey'}>
                <Field label={<IdentifierLabel prompt={prompt} />}>
                  <Input
                    type={prompt.type}
                    autoComplete={passkeyAutoComplete}
                    placeholder={identifierPlaceholder}
                    value={state.identifier}
                    onChange={(e) => actions.setIdentifier(e.target.value)}
                    aria-label={identifierAriaLabel}
                  />
                </Field>
                <p
                  role="status"
                  aria-live="polite"
                  {...stylex.props(
                    styles.conditionalHint,
                    state.conditionalUiRunning ? styles.hintVisible : styles.hintHidden,
                  )}
                >
                  {state.conditionalUiRunning ? (
                    <Trans>Waiting for passkey selection...</Trans>
                  ) : null}
                </p>
                <Button
                  fullWidth
                  isLoading={state.isLoading}
                  disabled={!state.turnstileReady}
                  onClick={actions.triggerPasskeyButton}
                  aria-label={t`Sign in with passkey`}
                >
                  <Trans>Sign in with passkey</Trans>
                </Button>
              </SignInPanel>
            ) : null}

            {enabledMethods.includes('password') ? (
              <SignInPanel active={state.method === 'password'}>
                <form
                  onSubmit={handlePasswordSubmit}
                  noValidate
                  {...stylex.props(styles.panel)}
                  aria-label={isSignUpFlow ? t`Create your account` : t`Sign in with password`}
                >
                  <Field label={<IdentifierLabel prompt={prompt} />} required>
                    <Input
                      type={prompt.type}
                      autoComplete={prompt.autoComplete}
                      placeholder={identifierPlaceholder}
                      value={state.identifier}
                      onChange={(e) => actions.setIdentifier(e.target.value)}
                      disabled={state.isLoading}
                    />
                  </Field>
                  <Field label={<Trans>Password</Trans>} required>
                    <Input
                      type="password"
                      autoComplete={isSignUpFlow ? 'new-password' : 'current-password'}
                      placeholder={isSignUpFlow ? t`Minimum 12 characters` : t`Your password`}
                      value={state.password}
                      onChange={(e) => actions.setPassword(e.target.value)}
                      disabled={state.isLoading}
                    />
                  </Field>
                  <ProfileFields
                    fields={profileFields}
                    requiredFields={requiredFields}
                    values={state.profileValues}
                    disabled={state.isLoading}
                    onChange={actions.setProfileValue}
                  />
                  <div {...stylex.props(styles.rememberRow)}>
                    <label {...stylex.props(styles.checkLabel)}>
                      <input
                        type="checkbox"
                        checked={state.rememberMe}
                        onChange={(e) => actions.setRememberMe(e.target.checked)}
                        disabled={state.isLoading}
                        {...stylex.props(styles.checkInput)}
                      />
                      <span>
                        <Trans>Remember me</Trans>
                      </span>
                    </label>
                    {isSignUpFlow ? null : (
                      <a
                        href={forgotPasswordHref({
                          organizationId: search.organization_id,
                          locale: search.locale,
                        })}
                        {...stylex.props(styles.textLink)}
                      >
                        <Trans>Forgot password?</Trans>
                      </a>
                    )}
                  </div>
                  <Button
                    type="submit"
                    fullWidth
                    isLoading={state.isLoading}
                    disabled={
                      !state.identifier.trim() ||
                      !state.password.trim() ||
                      !requiredProfileComplete ||
                      !state.turnstileReady
                    }
                  >
                    {isSignUpFlow ? <Trans>Sign up</Trans> : <Trans>Sign in</Trans>}
                  </Button>
                </form>
              </SignInPanel>
            ) : null}

            {enabledMethods.includes('magic-link') ? (
              <SignInPanel active={state.method === 'magic-link'}>
                <form
                  onSubmit={handleMagicLinkSubmit}
                  noValidate
                  {...stylex.props(styles.panel)}
                  aria-label={isSignUpFlow ? t`Create your account` : t`Sign in with magic link`}
                >
                  <Field label={<Trans>Email address</Trans>} required>
                    <Input
                      type="email"
                      autoComplete="email"
                      placeholder={t`you@example.com`}
                      value={state.identifier}
                      onChange={(e) => actions.setIdentifier(e.target.value)}
                      disabled={state.isLoading}
                    />
                  </Field>
                  <ProfileFields
                    fields={profileFields}
                    requiredFields={requiredFields}
                    values={state.profileValues}
                    disabled={state.isLoading}
                    onChange={actions.setProfileValue}
                  />
                  <Button
                    type="submit"
                    fullWidth
                    isLoading={state.isLoading}
                    disabled={
                      !state.identifier.trim() || !requiredProfileComplete || !state.turnstileReady
                    }
                  >
                    <Trans>Send magic link</Trans>
                  </Button>
                </form>
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
      </div>
    </AuthLayout>
  )
}

export const Route = createLazyRoute('/sign-in')({
  component: SignInPage,
})
