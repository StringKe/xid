// 登录与注册共用一个标识符优先的入口;枚举防护统一模糊失败文案。

import { Trans, useLingui } from '@lingui/react/macro'
import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { createLazyRoute, useSearch } from '@tanstack/react-router'
import * as stylex from '@stylexjs/stylex'
import { AuthLayout, type AuthContextCopy } from '../../components/layout'
import { Notice } from '../../components/ui'
import { hosted } from '../../components/hosted/hosted-styles'
import { IdentifierChip } from '../../components/hosted/IdentityChip'
import { useContinueLine } from '../../components/hosted/context-copy'
import { useAuth } from '../../lib/auth-context'
import { Link, useNavigate } from '@xid-kit/web-ui/tanstack-router'
import { isProductSignUpIntent } from '../../../shared/hosted-auth-intent'
import { forgotPasswordHref } from '../forgot-password/navigation'
import { IdentifierStep } from './IdentifierStep'
import { MethodStep } from './MethodStep'
import { AccountLockedStep, OrganizationStep, SsoRedirectStep } from './RoutingSteps'
import { SignInGuestButton } from './SignInGuestButton'
import { selfSignUpAvailable } from './auth-config'
import { isOtpMethod } from './shared'
import { resolveHostedReturn } from './sign-in-flow'
import { useSignInErrorMessage } from './sign-in-messages'
import type { SignInSearch, SignInState } from './sign-in-types'
import { useSignIn } from './useSignIn'
import { useTurnstile } from './useTurnstile'

// 互切 intent 时透传认证动线参数;verified/reauthenticate/select_account 为一次性不带。
const INTENT_SWITCH_KEYS = [
  'continue',
  'client_id',
  'invitation_token',
  'organization_id',
  'authz_request_id',
  'login_hint',
] as const

type PageSearch = SignInSearch & {
  reauthenticate?: string
  select_account?: string
  verified?: string
  locale?: string
}

// 应用登录流里切到注册是应用注册(application-sign-up),产品注册 intent 不能与 client_id 组合。
function buildIntentSwitchSearch(search: PageSearch, target: 'sign-in' | 'sign-up'): string {
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

// 验证码与密码面板自己就地展示错码与限流;其余错误放在表单上方。
function inlineHandled(state: SignInState): boolean {
  if (state.step !== 'methods') return false
  if (state.error === 'auth_failed') return isOtpMethod(state.method) || state.method === 'password'
  return state.error === 'rate_limited' && isOtpMethod(state.method)
}

function useSignInContext(state: SignInState): AuthContextCopy | undefined {
  const { t } = useLingui()
  const line = useContinueLine()
  const target =
    state.authConfig.context.applicationName ?? state.authConfig.context.organizationName
  if (!state.isSignUpFlow || !target) return undefined
  return { lead: t`You are creating an account to continue to`, title: target, line }
}

function SignInPage(): ReactNode {
  const { t } = useLingui()
  const { status } = useAuth()
  const navigate = useNavigate()
  const search = useSearch({ strict: false }) as PageSearch
  const isProductSignUpFlow = isProductSignUpIntent(search.intent)
  const requiresExplicitInteraction = search.reauthenticate === '1' || search.select_account === '1'
  const [state, actions] = useSignIn()
  const { containerRef } = useTurnstile(
    state.authConfig.turnstileSiteKey,
    state.turnstileToken,
    actions.setTurnstileToken,
  )
  const errorMessage = useSignInErrorMessage()
  const context = useSignInContext(state)
  const org = state.authConfig.context.organizationName
  const signedInReturn = resolveHostedReturn(search, state.authConfig.defaultLandingPath)
  const isInvitationReturn = signedInReturn.startsWith('/accept-invitation?')
  const recoveryHref = forgotPasswordHref({
    ...search,
    login_hint: state.identifier.trim() || search.login_hint,
  })
  const createTitle = org ? (
    <Trans>Create your {org} account</Trans>
  ) : (
    <Trans>Create your account</Trans>
  )

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

  const switchIntent = state.isSignUpFlow ? (
    <>
      <Trans>Already have an account?</Trans>{' '}
      <Link
        to={`/sign-in${buildIntentSwitchSearch(search, 'sign-in')}`}
        {...stylex.props(hosted.textLink)}
      >
        <Trans>Sign in</Trans>
      </Link>
    </>
  ) : state.configSettled && selfSignUpAvailable(state.authConfig) ? (
    <>
      {org ? <Trans>New to {org}?</Trans> : <Trans>New here?</Trans>}{' '}
      <Link
        to={`/sign-in${buildIntentSwitchSearch(search, 'sign-up')}`}
        {...stylex.props(hosted.textLink)}
      >
        <Trans>Create account</Trans>
      </Link>
    </>
  ) : null
  const error = inlineHandled(state) ? null : errorMessage(state.error)
  const success =
    state.error === 'verify_email_sent'
      ? errorMessage('verify_email_sent')
      : search.verified === '1'
        ? t`Your email address is confirmed. Sign in to continue.`
        : null
  const inlineError =
    inlineHandled(state) && state.method === 'password' ? errorMessage(state.error) : null
  const above = <IdentifierChip value={state.identifier} onChange={actions.changeIdentifier} />

  if (state.error === 'account_locked') {
    return (
      <AuthLayout context={context}>
        <AccountLockedStep
          identifier={state.identifier}
          organizationName={org}
          applicationName={state.authConfig.context.applicationName}
          onUseDifferentAccount={actions.changeIdentifier}
        />
      </AuthLayout>
    )
  }

  return (
    <AuthLayout context={context}>
      <div {...stylex.props(hosted.screen)}>
        {error && state.error !== 'verify_email_sent' ? (
          <Notice tone="danger">{error}</Notice>
        ) : null}
        {success ? <Notice tone="success">{success}</Notice> : null}

        {state.step === 'organization' && state.authConfig.resolution.status === 'ambiguous' ? (
          <OrganizationStep
            matches={state.authConfig.resolution.matches}
            above={above}
            applicationName={state.authConfig.context.applicationName}
            onSelect={actions.selectOrganizationContext}
          />
        ) : state.step === 'sso' && state.ssoTarget ? (
          <SsoRedirectStep
            target={state.ssoTarget}
            above={above}
            applicationName={state.authConfig.context.applicationName}
            onUseDifferentEmail={actions.changeIdentifier}
          />
        ) : state.step === 'methods' ? (
          <MethodStep
            state={state}
            actions={actions}
            createTitle={createTitle}
            forgotPasswordHref={recoveryHref}
            inlineError={inlineError}
          />
        ) : (
          <IdentifierStep
            state={state}
            actions={actions}
            title={
              state.isSignUpFlow ? (
                createTitle
              ) : org ? (
                <Trans>Sign in to {org}</Trans>
              ) : (
                <Trans>Sign in</Trans>
              )
            }
            switchIntent={switchIntent}
            forgotPasswordHref={recoveryHref}
          />
        )}

        <div ref={containerRef} {...stylex.props(hosted.widgetSlot)} />

        {state.step === 'identifier' && state.authConfig.guest ? (
          <SignInGuestButton
            onContinue={actions.submitGuest}
            isLoading={state.isLoading}
            disabled={!state.turnstileReady}
          />
        ) : null}
      </div>
    </AuthLayout>
  )
}

export const Route = createLazyRoute('/sign-in')({
  component: SignInPage,
})
