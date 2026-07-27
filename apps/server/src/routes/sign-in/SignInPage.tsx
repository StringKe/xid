// SignInPage:登录主页面(路由 /sign-in)。
// 五条认证路径:passkey Conditional UI + 降级按钮 / 密码 / magic-link / email+WhatsApp+SMS OTP / 社交。
// 枚举防护:认证失败文案统一模糊。Turnstile invisible 防刷。
// a11y:语义 form/label 关联、aria-live 错误/状态、focus-visible。文案全走 lingui。
//
// CLS 防护(渐进增强,稳定骨架,详见 styles.ts):
//   tab 栏初始渲染全部 tab,passkey tab 探测前 opacity:0 占位;面板全部挂载,非激活脱流;
//   conditional UI 提示固定行高占位渐入;Turnstile invisible 容器 display:none。切换零 layout shift。

import { Trans, useLingui } from '@lingui/react/macro'
import { useEffect } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { createLazyRoute, useSearch } from '@tanstack/react-router'
import * as stylex from '@stylexjs/stylex'
import { AuthLayout } from '../../components/layout'
import { Alert, Button, Field, Input, PageHeader } from '../../components/ui'
import { useAuth } from '../../lib/auth-context'
import { useNavigate } from '../../lib/router'
import { styles } from './styles'
import { SignInOtpPanel } from './SignInOtpPanel'
import { SignInPanel, SignInTabs } from './SignInTabs'
import { SignInSocialButtons } from './SignInSocialButtons'
import { SignInGuestButton } from './SignInGuestButton'
import { useSignIn } from './useSignIn'
import { useTurnstile } from './useTurnstile'
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

// 错误文案映射(lingui t``,枚举防护:不区分用户不存在 / 密码错误)。
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
  const search = useSearch({ strict: false }) as { intent?: string }
  const isSignUpIntent = search.intent === 'sign-up'
  const { t } = useLingui()
  const [state, actions] = useSignIn()
  const { containerRef } = useTurnstile(actions.setTurnstileToken)
  const errorMessage = useErrorMessage(state.error)
  const successMessage = useSuccessMessage(state.error)
  const enabledOtpMethods = getEnabledOtpMethods(state.enabledMethods)
  const currentOtpMethod = resolveOtpMethod(state.method, state.enabledMethods)
  const isOtp = enabledOtpMethods.includes(currentOtpMethod) && state.method === currentOtpMethod
  const hasSocial = !state.authConfig.forceSso && state.authConfig.socialProviders.length > 0
  const hasTabs = state.enabledMethods.length > 1
  const showSeparator = hasSocial && state.enabledMethods.length > 0
  const prompt = identifierPrompt(state.authConfig)
  const identifierPlaceholder = useIdentifierPlaceholder(prompt)
  const identifierAriaLabel = useIdentifierAriaLabel(prompt)
  const passkeyAutoComplete = `${prompt.autoComplete} webauthn`
  const ambiguousResolution =
    state.authConfig.resolution.status === 'ambiguous' ? state.authConfig.resolution : null
  const profileFields = visibleProfileFields(state.authConfig, state.method)
  const requiredFields = requiredProfileFields(state.authConfig, state.method)
  const requiredProfileComplete = requiredFields.every(
    (field) => state.profileValues[field].trim() !== '',
  )

  const signedInReturn = resolveHostedReturn(
    state.tenantSelection.continueParam ?? state.tenantSelection.redirect,
    state.tenantSelection.authzRequestId,
  )
  const isInvitationReturn = signedInReturn.startsWith('/accept-invitation?')

  // 授权和邀请必须续跑原流程;普通 sign-up 会话进入组织 onboarding。
  useEffect(() => {
    if (status !== 'authenticated') return
    if (state.tenantSelection.authzRequestId) {
      globalThis.location.href = signedInReturn
      return
    }
    if (isSignUpIntent && !isInvitationReturn) {
      navigate('/create-organization', { replace: true })
      return
    }
    navigate(signedInReturn, { replace: true })
  }, [
    isInvitationReturn,
    isSignUpIntent,
    navigate,
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
          title={isSignUpIntent ? <Trans>Create your account</Trans> : <Trans>Sign in</Trans>}
        />

        {errorMessage ? (
          <Alert tone="error">{errorMessage}</Alert>
        ) : successMessage ? (
          <Alert tone="success">{successMessage}</Alert>
        ) : null}

        <SignInSocialButtons
          providers={state.authConfig.socialProviders}
          onSelect={actions.handleSocial}
          isLoading={state.isLoading}
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
            enabledMethods={state.enabledMethods}
            onSelect={actions.setMethod}
          />
        ) : null}

        {state.enabledMethods.length === 0 && !ambiguousResolution ? (
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

        {state.enabledMethods.length > 0 && !ambiguousResolution ? (
          <div {...stylex.props(styles.panelHost)}>
            {state.enabledMethods.includes('enterprise-sso') ? (
              <SignInPanel active={state.method === 'enterprise-sso'}>
                <form
                  onSubmit={handleEnterpriseSsoSubmit}
                  noValidate
                  {...stylex.props(styles.panel)}
                  aria-label={t`Sign in with SSO`}
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
                    disabled={!state.identifier.trim()}
                  >
                    <Trans>Continue with SSO</Trans>
                  </Button>
                </form>
              </SignInPanel>
            ) : null}

            {state.enabledMethods.includes('passkey') ? (
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
                  onClick={actions.triggerPasskeyButton}
                  aria-label={t`Sign in with passkey`}
                >
                  <Trans>Sign in with passkey</Trans>
                </Button>
              </SignInPanel>
            ) : null}

            {state.enabledMethods.includes('password') ? (
              <SignInPanel active={state.method === 'password'}>
                <form
                  onSubmit={handlePasswordSubmit}
                  noValidate
                  {...stylex.props(styles.panel)}
                  aria-label={t`Sign in with password`}
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
                      autoComplete="current-password"
                      placeholder={t`Your password`}
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
                    <a href="/reset-password" {...stylex.props(styles.textLink)}>
                      <Trans>Forgot password?</Trans>
                    </a>
                  </div>
                  <Button
                    type="submit"
                    fullWidth
                    isLoading={state.isLoading}
                    disabled={
                      !state.identifier.trim() || !state.password.trim() || !requiredProfileComplete
                    }
                  >
                    <Trans>Sign in</Trans>
                  </Button>
                </form>
              </SignInPanel>
            ) : null}

            {state.enabledMethods.includes('magic-link') ? (
              <SignInPanel active={state.method === 'magic-link'}>
                <form
                  onSubmit={handleMagicLinkSubmit}
                  noValidate
                  {...stylex.props(styles.panel)}
                  aria-label={t`Sign in with magic link`}
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
                    disabled={!state.identifier.trim() || !requiredProfileComplete}
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

        {ambiguousResolution ? null : (
          <SignInGuestButton onContinue={actions.submitGuest} isLoading={state.isLoading} />
        )}

        <div ref={containerRef} aria-hidden="true" {...stylex.props(styles.turnstile)} />
      </div>
    </AuthLayout>
  )
}

// TanStack Router lazy 路由(对齐 verify-email / forgot-password 原生 Route 约定)。
export const Route = createLazyRoute('/sign-in')({
  component: SignInPage,
})
