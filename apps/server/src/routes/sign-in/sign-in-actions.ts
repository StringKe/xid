// 登录页的用户动作:标识符与方式切换、各凭证提交、社交登录与组织选择。

import type { Dispatch, SetStateAction } from 'react'
import type { Result, XidError } from '@xid-kit/types'
import type { useNavigate } from '@xid-kit/web-ui/tanstack-router'
import { trackEvent } from '../../lib/google-analytics'
import {
  trackAuthMethodSelected,
  trackMagicLinkSent,
  type AuthFlowIntent,
} from '../../lib/google-analytics-funnel'
import { setPendingAuthCompletion } from '../../lib/google-analytics-pending-auth'
import { isSignUpIntent } from '../../../shared/hosted-auth-intent'
import type { PublicHostedAuthConfig } from './auth-config'
import { apiErrorToKey, isOtpMethod, organizationSignInUrl } from './shared'
import type { ProfileFieldKey, ProfileValues, SignInErrorKey, SignInMethod } from './shared'
import {
  buildSocialAuthorizeUrl,
  signInPathWithLoginHint,
  signInPathWithoutLoginHint,
} from './sign-in-entry'
import {
  AUTH_METHOD_BY_SIGN_IN_METHOD,
  type SignInActions,
  type SignInSearch,
  type SignInStep,
} from './sign-in-types'
import type { AuthResponse, useCredentialMutations } from './useCredentialMutations'
import type { IdentifierDiscovery } from './useIdentifierDiscovery'
import type { OtpSend } from './useOtpSend'
import type { PasskeySignIn } from './usePasskeySignIn'

export type SignInActionContext = {
  search: SignInSearch
  navigate: ReturnType<typeof useNavigate>
  authConfig: PublicHostedAuthConfig
  identifier: string
  password: string
  rememberMe: boolean
  profileValues: ProfileValues
  method: SignInMethod
  isSignUpFlow: boolean
  analyticsIntent: AuthFlowIntent
  turnstileReady: boolean
  turnstileToken: string | null
  excludesFederatedEntry: boolean
  hostedReturn: string
  credentials: ReturnType<typeof useCredentialMutations>
  passkey: Pick<PasskeySignIn, 'triggerButton'>
  otp: Pick<OtpSend, 'sendOtp' | 'setOtpCode' | 'setOtpSentAt' | 'setOtpResent'>
  discovery: Pick<IdentifierDiscovery, 'startDiscovery' | 'setSsoTarget'>
  refetchAuthConfig: () => void
  showApiError: (apiError: Pick<XidError, 'code' | 'meta'>) => void
  handleAuthResult: (result: Result<AuthResponse>, signedInWith: SignInMethod) => Promise<void>
  finishSignIn: (
    redirectUrl: string | undefined,
    signedInWith: SignInMethod | 'guest',
  ) => Promise<void>
  setIdentifier: Dispatch<SetStateAction<string>>
  setProfileValues: Dispatch<SetStateAction<ProfileValues>>
  setPassword: Dispatch<SetStateAction<string>>
  setRememberMe: Dispatch<SetStateAction<boolean>>
  setPendingOtpSend: Dispatch<SetStateAction<boolean>>
  setMagicLinkSent: Dispatch<SetStateAction<boolean>>
  setTurnstileToken: Dispatch<SetStateAction<string | null>>
  setMethod: Dispatch<SetStateAction<SignInMethod>>
  setStep: Dispatch<SetStateAction<SignInStep>>
  setError: Dispatch<SetStateAction<SignInErrorKey | null>>
}

type IdentifierActions = Pick<
  SignInActions,
  | 'setIdentifier'
  | 'setProfileValue'
  | 'setPassword'
  | 'setRememberMe'
  | 'setOtpCode'
  | 'setTurnstileToken'
  | 'submitIdentifier'
  | 'changeIdentifier'
  | 'chooseMethod'
>
type CredentialActions = Pick<
  SignInActions,
  | 'submitPassword'
  | 'submitMagicLink'
  | 'requestOtp'
  | 'verifyOtp'
  | 'triggerPasskeyButton'
  | 'submitGuest'
>
type EntryActions = Pick<SignInActions, 'handleSocial' | 'selectOrganizationContext'>

export function buildSignInActions(ctx: SignInActionContext): SignInActions {
  return {
    ...buildIdentifierActions(ctx),
    ...buildCredentialActions(ctx),
    ...buildEntryActions(ctx),
  }
}

function buildIdentifierActions(ctx: SignInActionContext): IdentifierActions {
  const { search, navigate, identifier, isSignUpFlow, passkey, otp, discovery } = ctx
  return {
    setIdentifier: ctx.setIdentifier,
    setProfileValue: (field: ProfileFieldKey, value: string) =>
      ctx.setProfileValues((prev) => ({ ...prev, [field]: value })),
    setPassword: ctx.setPassword,
    setRememberMe: ctx.setRememberMe,
    setOtpCode: otp.setOtpCode,
    setTurnstileToken: ctx.setTurnstileToken,
    submitIdentifier: (options = {}) => {
      const trimmed = identifier.trim()
      if (!trimmed) return ctx.setError('identifier_required')
      ctx.setError(null)
      if (trimmed !== (search.login_hint ?? ''))
        navigate(signInPathWithLoginHint(search, trimmed), { replace: true })
      discovery.startDiscovery({ identifier: trimmed, ssoOnly: options.ssoOnly === true })
    },
    changeIdentifier: () => {
      if (search.login_hint) navigate(signInPathWithoutLoginHint(search), { replace: true })
      ctx.setStep('identifier')
      discovery.setSsoTarget(null)
      otp.setOtpSentAt(null)
      otp.setOtpResent(false)
      ctx.setMagicLinkSent(false)
      ctx.setPassword('')
      otp.setOtpCode('')
      ctx.setError(null)
    },
    chooseMethod: (next) => {
      trackAuthMethodSelected(AUTH_METHOD_BY_SIGN_IN_METHOD[next])
      ctx.setMethod(next)
      ctx.setError(null)
      otp.setOtpCode('')
      otp.setOtpSentAt(null)
      otp.setOtpResent(false)
      ctx.setMagicLinkSent(false)
      if (next === 'passkey') passkey.triggerButton()
      else if (isOtpMethod(next) && !isSignUpFlow) ctx.setPendingOtpSend(true)
    },
  }
}

function buildCredentialActions(ctx: SignInActionContext): CredentialActions {
  const {
    credentials,
    identifier,
    method,
    isSignUpFlow,
    profileValues,
    analyticsIntent,
    turnstileReady,
  } = ctx
  const whenTurnstileReady = (action: () => void) => () => {
    if (turnstileReady) action()
  }
  return {
    submitPassword: whenTurnstileReady(() =>
      credentials.password.mutate(
        {
          identifier: identifier.trim(),
          password: ctx.password,
          rememberMe: ctx.rememberMe,
          profile: isSignUpFlow ? profileValues : null,
        },
        { onSuccess: (result) => void ctx.handleAuthResult(result, 'password') },
      ),
    ),
    submitMagicLink: whenTurnstileReady(() =>
      credentials.magicLink.mutate(
        { email: identifier.trim(), profile: isSignUpFlow ? profileValues : null },
        {
          onSuccess: (result) => {
            if (!result.ok) return ctx.showApiError(result.error)
            trackMagicLinkSent(analyticsIntent)
            setPendingAuthCompletion({ method: 'magic_link', intent: analyticsIntent })
            ctx.setMagicLinkSent(true)
          },
        },
      ),
    ),
    requestOtp: whenTurnstileReady(() => ctx.otp.sendOtp(method)),
    verifyOtp: (code) => {
      if (!isOtpMethod(method)) return
      credentials.otpVerify.mutate(
        { method, target: identifier.trim(), code },
        { onSuccess: (result) => void ctx.handleAuthResult(result, method) },
      )
    },
    triggerPasskeyButton: whenTurnstileReady(() => ctx.passkey.triggerButton()),
    submitGuest: () => {
      if (!ctx.authConfig.guest || !turnstileReady) return
      credentials.guest.mutate(
        {
          capabilityToken: ctx.authConfig.guest.capabilityToken,
          turnstileToken: ctx.turnstileToken,
        },
        {
          onSuccess: async (result) => {
            if (!result.ok) return ctx.setError(apiErrorToKey(result.error))
            await ctx.finishSignIn(result.value.redirectUrl, 'guest')
          },
          onSettled: () => ctx.refetchAuthConfig(),
        },
      )
    },
  }
}

function buildEntryActions(ctx: SignInActionContext): EntryActions {
  const { search, authConfig, identifier } = ctx
  return {
    handleSocial: (provider) => {
      if (!ctx.turnstileReady || ctx.excludesFederatedEntry) return
      trackEvent('social_login_start', { provider })
      setPendingAuthCompletion({ method: 'social', intent: ctx.analyticsIntent })
      globalThis.location.href = buildSocialAuthorizeUrl({
        origin: globalThis.location.origin,
        provider,
        hostedReturn: ctx.hostedReturn,
        intent: isSignUpIntent(search.intent)
          ? search.intent
          : search.intent === 'sign-in'
            ? 'sign-in'
            : null,
        applicationClientId: search.client_id,
        identifier,
        organizationId: search.organization_id,
        turnstileToken: ctx.turnstileToken,
      }).toString()
    },
    selectOrganizationContext: (organizationId) => {
      const match =
        authConfig.resolution.status === 'ambiguous'
          ? authConfig.resolution.matches.find((item) => item.organizationId === organizationId)
          : undefined
      if (!match) return
      globalThis.location.href = organizationSignInUrl(match, {
        loginHint: identifier || search.login_hint || null,
        continueParam: search.continue ?? null,
        redirect: search.redirect ?? null,
        authzRequestId: search.authz_request_id ?? null,
        intent: search.intent ?? null,
        invitationToken: search.invitation_token ?? null,
      })
    },
  }
}
