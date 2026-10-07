// 标识符优先的登录:第一步只收标识符(passkey 从 autofill 出现),提交后按已验证域名直跳企业 SSO、
// 按根入口歧义选组织,否则进入第二步。失败统一模糊 key;发码与发链接成功不泄露联系方式是否存在。

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearch } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import type { Result, XidError } from '@xid-kit/types'
import { useAuth } from '../../lib/auth-context'
import { useNavigate } from '@xid-kit/web-ui/tanstack-router'
import {
  apiErrorToKey,
  emptyProfileValues,
  federatedSignInErrorKey,
  isOtpMethod,
  organizationSignInUrl,
} from './shared'
import type { ProfileFieldKey, ProfileValues, SignInErrorKey, SignInMethod } from './shared'
import { trackEvent } from '../../lib/google-analytics'
import {
  trackAuthMethodSelected,
  trackAuthSuccess,
  trackMagicLinkSent,
  trackOtpSent,
} from '../../lib/google-analytics-funnel'
import {
  clearPendingAuthCompletion,
  setPendingAuthCompletion,
} from '../../lib/google-analytics-pending-auth'
import { buildSignInFlowFields, resolveHostedReturn } from './sign-in-flow'
import { buildFlowPayload, organizationSelectionPath, otpTarget } from './sign-in-requests'
import { usePasskeySignIn } from './usePasskeySignIn'
import { DEFAULT_PUBLIC_AUTH_CONFIG, enterpriseSsoEnabled } from './auth-config'
import { authConfigQueryOptions } from './auth-config-query'
import { isSignUpIntent } from '../../../shared/hosted-auth-intent'
import {
  browserStorage,
  defaultSecondStepMethod,
  identifierKindOf,
  readLastAuthMethod,
  secondStepMethods,
  writeLastAuthMethod,
} from './method-order'
import {
  AUTH_METHOD_BY_SIGN_IN_METHOD,
  type SignInActions,
  type SignInSearch,
  type SignInState,
  type SignInStep,
} from './sign-in-types'
import {
  buildSocialAuthorizeUrl,
  enabledSignInMethodsForIntent,
  passkeyPromptPath,
  signInPathWithLoginHint,
  signInPathWithoutLoginHint,
} from './sign-in-entry'
import { useCredentialMutations, type AuthResponse } from './useCredentialMutations'
import { ssoTargetFrom, useSsoDiscovery, type SsoTarget } from './useSsoDiscovery'

export type { SignInActions, SignInState, SignInStep } from './sign-in-types'
export type { SignInMethod, SignInErrorKey } from './shared'
export { buildAuthConfigPath } from './auth-config-query'
export { buildSocialAuthorizeUrl, enabledSignInMethodsForIntent } from './sign-in-entry'

type PendingDiscovery = { identifier: string; ssoOnly: boolean }

export function useSignIn(): [SignInState, SignInActions] {
  const { api, refresh } = useAuth()
  const navigate = useNavigate()
  const search = useSearch({ strict: false }) as SignInSearch
  const selectedOrganizationId = search.organization_id ?? null
  const flowFields = useMemo(() => buildSignInFlowFields(search), [search])
  const [step, setStep] = useState<SignInStep>('identifier')
  const [method, setMethodState] = useState<SignInMethod>('password')
  const [identifier, setIdentifier] = useState(search.login_hint ?? '')
  const [profileValues, setProfileValues] = useState<ProfileValues>(() => emptyProfileValues())
  const [password, setPassword] = useState('')
  const [rememberMe, setRememberMe] = useState(false)
  const [otpCode, setOtpCodeState] = useState('')
  const [otpSentAt, setOtpSentAt] = useState<number | null>(null)
  const [otpResent, setOtpResent] = useState(false)
  const [pendingOtpSend, setPendingOtpSend] = useState(false)
  const [magicLinkSent, setMagicLinkSent] = useState(false)
  const [pendingDiscovery, setPendingDiscovery] = useState<PendingDiscovery | null>(null)
  const [ssoTarget, setSsoTarget] = useState<SsoTarget | null>(null)
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null)
  const [error, setError] = useState<SignInErrorKey | null>(() =>
    federatedSignInErrorKey(search.error),
  )
  const resetTurnstile = useCallback((): void => setTurnstileToken(null), [])

  const authConfigQuery = useQuery(authConfigQueryOptions(search, api))
  const authConfig = authConfigQuery.data ?? DEFAULT_PUBLIC_AUTH_CONFIG
  const configSettled = !authConfigQuery.isPending && !authConfigQuery.isPlaceholderData
  const hostedReturn = resolveHostedReturn(search, authConfig.defaultLandingPath)
  const turnstileReady =
    configSettled && (authConfig.turnstileSiteKey === null || Boolean(turnstileToken))
  const isSignUpFlow = Boolean(search.invitation_token) || isSignUpIntent(search.intent)
  // 邀请只走 Email claim:社交与企业 SSO 不接受邀请 capability(01 章 3)。
  const excludesFederatedEntry =
    Boolean(search.invitation_token) || hostedReturn.startsWith('/accept-invitation?')
  const enabledMethods = useMemo<readonly SignInMethod[]>(() => {
    const methods = enabledSignInMethodsForIntent(
      authConfig,
      isSignUpFlow ? 'sign-up' : search.intent,
    )
    return excludesFederatedEntry ? methods.filter((item) => item !== 'enterprise-sso') : methods
  }, [authConfig, excludesFederatedEntry, isSignUpFlow, search.intent])
  const identifierKind = identifierKindOf(identifier, authConfig.identifierMode)
  const methods = useMemo(
    () => secondStepMethods(enabledMethods, identifierKind),
    [enabledMethods, identifierKind],
  )
  const analyticsIntent = isSignUpFlow ? 'sign_up' : 'sign_in'
  const flowPayload = useCallback(
    (options: { withTurnstile: boolean }) =>
      buildFlowPayload({
        organizationId: selectedOrganizationId,
        flowFields,
        ...(options.withTurnstile ? { turnstileToken } : {}),
      }),
    [flowFields, selectedOrganizationId, turnstileToken],
  )
  const credentials = useCredentialMutations({
    api,
    flowPayload,
    onTurnstileConsumed: resetTurnstile,
  })
  const discovery = useSsoDiscovery(api, resetTurnstile)

  const showApiError = useCallback(
    (apiError: Pick<XidError, 'code' | 'meta'>): void => {
      if (apiError.code === 'organization_selection_required' && identifier.trim()) {
        setError(null)
        navigate(organizationSelectionPath(search, identifier), { replace: true })
        return
      }
      setError(apiErrorToKey(apiError))
    },
    [identifier, navigate, search],
  )

  const finishSignIn = useCallback(
    async (
      redirectUrl: string | undefined,
      signedInWith: SignInMethod | 'guest',
    ): Promise<void> => {
      clearPendingAuthCompletion()
      trackAuthSuccess({
        method: signedInWith === 'guest' ? 'guest' : AUTH_METHOD_BY_SIGN_IN_METHOD[signedInWith],
        intent: analyticsIntent,
      })
      if (signedInWith !== 'guest') writeLastAuthMethod(browserStorage(), signedInWith)
      await refresh()
      const target = redirectUrl ?? hostedReturn
      const prompt =
        signedInWith !== 'guest' &&
        signedInWith !== 'passkey' &&
        enabledMethods.includes('passkey') &&
        !target.startsWith('/mfa') &&
        !isSignUpFlow
          ? passkeyPromptPath(target)
          : null
      navigate(prompt ?? target, { replace: true })
    },
    [analyticsIntent, enabledMethods, hostedReturn, isSignUpFlow, navigate, refresh],
  )

  const handleAuthResult = useCallback(
    async (result: Result<AuthResponse>, signedInWith: SignInMethod): Promise<void> => {
      if (!result.ok) return showApiError(result.error)
      if (result.value.nextStep === 'verify_email') return setError('verify_email_sent')
      await finishSignIn(result.value.redirectUrl, signedInWith)
    },
    [finishSignIn, showApiError],
  )

  const passkey = usePasskeySignIn({
    api,
    enabled: enabledMethods.includes('passkey') && configSettled,
    conditionalEnabled: step === 'identifier',
    identifierRequired:
      authConfig.passkeyEntry.identifierRequired && !selectedOrganizationId && !flowFields.clientId,
    identifier,
    organizationId: selectedOrganizationId,
    flowFields,
    turnstileRequired: authConfig.turnstileSiteKey !== null,
    turnstileToken,
    onTurnstileConsumed: resetTurnstile,
    onOrganizationSelectionRequired: () =>
      navigate(organizationSelectionPath(search, identifier), { replace: true }),
    onSuccess: (redirectUrl) => finishSignIn(redirectUrl, 'passkey'),
  })

  const sendOtp = useCallback(
    (otpMethod: SignInMethod): void => {
      if (!isOtpMethod(otpMethod)) return
      const resend = otpSentAt !== null
      credentials.otpSend.mutate(
        {
          method: otpMethod,
          target: identifier.trim(),
          profile: isSignUpFlow ? profileValues : null,
        },
        {
          onSuccess: (result) => {
            if (!result.ok) return showApiError(result.error)
            trackOtpSent(otpTarget(otpMethod).channel, analyticsIntent)
            setError(null)
            setOtpCodeState('')
            setOtpSentAt(Date.now())
            setOtpResent(resend)
          },
        },
      )
    },
    [
      analyticsIntent,
      credentials.otpSend,
      identifier,
      isSignUpFlow,
      otpSentAt,
      profileValues,
      showApiError,
    ],
  )

  const enterMethodsStep = useCallback((): void => {
    const preferred = defaultSecondStepMethod(methods, readLastAuthMethod(browserStorage()))
    if (!preferred) {
      setError(authConfig.forceSso ? 'sso_not_available' : 'auth_failed')
      return
    }
    setMethodState(preferred)
    setStep('methods')
    if (isOtpMethod(preferred) && !isSignUpFlow) setPendingOtpSend(true)
  }, [authConfig.forceSso, isSignUpFlow, methods])

  // login_hint 写回 URL 后等 /auth/config 按该标识符解析完,再决定 SSO、组织选择或第二步。
  useEffect(() => {
    if (!pendingDiscovery || !configSettled) return
    if ((search.login_hint ?? '') !== pendingDiscovery.identifier) return
    if (authConfig.resolution.status === 'ambiguous') {
      setPendingDiscovery(null)
      setStep('organization')
      return
    }
    const canDiscover =
      identifierKindOf(pendingDiscovery.identifier, authConfig.identifierMode) === 'email' &&
      enterpriseSsoEnabled(authConfig) &&
      !excludesFederatedEntry
    if (!canDiscover) {
      setPendingDiscovery(null)
      if (pendingDiscovery.ssoOnly) setError('sso_not_available')
      else enterMethodsStep()
      return
    }
    if (!turnstileReady || discovery.isPending) return
    const request = pendingDiscovery
    setPendingDiscovery(null)
    discovery.mutate(
      {
        email: request.identifier,
        organizationId: selectedOrganizationId,
        intent: search.intent,
        clientId: search.client_id,
        turnstileToken,
      },
      {
        onSuccess: (result) => {
          if (!result.ok) return showApiError(result.error)
          const target = ssoTargetFrom(result.value, {
            email: request.identifier,
            origin: globalThis.location.origin,
            hostedReturn,
            intent: search.intent,
            clientId: search.client_id,
          })
          if (target) {
            trackEvent('enterprise_sso_start', { protocol: target.protocol })
            setPendingAuthCompletion({ method: 'enterprise_sso', intent: analyticsIntent })
            setSsoTarget(target)
            setStep('sso')
          } else if (request.ssoOnly || authConfig.forceSso) setError('sso_not_available')
          else enterMethodsStep()
        },
      },
    )
  }, [
    analyticsIntent,
    authConfig,
    configSettled,
    discovery,
    enterMethodsStep,
    excludesFederatedEntry,
    hostedReturn,
    pendingDiscovery,
    search.client_id,
    search.intent,
    search.login_hint,
    selectedOrganizationId,
    showApiError,
    turnstileReady,
    turnstileToken,
  ])

  useEffect(() => {
    if (!pendingOtpSend || step !== 'methods' || !turnstileReady || credentials.otpSend.isPending)
      return
    setPendingOtpSend(false)
    sendOtp(method)
  }, [credentials.otpSend.isPending, method, pendingOtpSend, sendOtp, step, turnstileReady])

  const whenTurnstileReady = (action: () => void) => () => {
    if (turnstileReady) action()
  }

  const actions: SignInActions = {
    setIdentifier,
    setProfileValue: (field: ProfileFieldKey, value: string) =>
      setProfileValues((prev) => ({ ...prev, [field]: value })),
    setPassword,
    setRememberMe,
    setOtpCode: setOtpCodeState,
    setTurnstileToken,
    submitIdentifier: (options = {}) => {
      const trimmed = identifier.trim()
      if (!trimmed) return setError('identifier_required')
      setError(null)
      if (trimmed !== (search.login_hint ?? ''))
        navigate(signInPathWithLoginHint(search, trimmed), { replace: true })
      setPendingDiscovery({ identifier: trimmed, ssoOnly: options.ssoOnly === true })
    },
    changeIdentifier: () => {
      if (search.login_hint) navigate(signInPathWithoutLoginHint(search), { replace: true })
      setStep('identifier')
      setSsoTarget(null)
      setOtpSentAt(null)
      setOtpResent(false)
      setMagicLinkSent(false)
      setPassword('')
      setOtpCodeState('')
      setError(null)
    },
    chooseMethod: (next) => {
      trackAuthMethodSelected(AUTH_METHOD_BY_SIGN_IN_METHOD[next])
      setMethodState(next)
      setError(null)
      setOtpCodeState('')
      setOtpSentAt(null)
      setOtpResent(false)
      setMagicLinkSent(false)
      if (next === 'passkey') passkey.triggerButton()
      else if (isOtpMethod(next) && !isSignUpFlow) setPendingOtpSend(true)
    },
    submitPassword: whenTurnstileReady(() =>
      credentials.password.mutate(
        {
          identifier: identifier.trim(),
          password,
          rememberMe,
          profile: isSignUpFlow ? profileValues : null,
        },
        { onSuccess: (result) => void handleAuthResult(result, 'password') },
      ),
    ),
    submitMagicLink: whenTurnstileReady(() =>
      credentials.magicLink.mutate(
        { email: identifier.trim(), profile: isSignUpFlow ? profileValues : null },
        {
          onSuccess: (result) => {
            if (!result.ok) return showApiError(result.error)
            trackMagicLinkSent(analyticsIntent)
            setPendingAuthCompletion({ method: 'magic_link', intent: analyticsIntent })
            setMagicLinkSent(true)
          },
        },
      ),
    ),
    requestOtp: whenTurnstileReady(() => sendOtp(method)),
    verifyOtp: (code) => {
      if (!isOtpMethod(method)) return
      credentials.otpVerify.mutate(
        { method, target: identifier.trim(), code },
        { onSuccess: (result) => void handleAuthResult(result, method) },
      )
    },
    triggerPasskeyButton: whenTurnstileReady(() => passkey.triggerButton()),
    submitGuest: () => {
      if (!authConfig.guest || !turnstileReady) return
      credentials.guest.mutate(
        { capabilityToken: authConfig.guest.capabilityToken, turnstileToken },
        {
          onSuccess: async (result) => {
            if (!result.ok) return setError(apiErrorToKey(result.error))
            await finishSignIn(result.value.redirectUrl, 'guest')
          },
          onSettled: () => void authConfigQuery.refetch(),
        },
      )
    },
    handleSocial: (provider) => {
      if (!turnstileReady || excludesFederatedEntry) return
      trackEvent('social_login_start', { provider })
      setPendingAuthCompletion({ method: 'social', intent: analyticsIntent })
      globalThis.location.href = buildSocialAuthorizeUrl({
        origin: globalThis.location.origin,
        provider,
        hostedReturn,
        intent: isSignUpIntent(search.intent)
          ? search.intent
          : search.intent === 'sign-in'
            ? 'sign-in'
            : null,
        applicationClientId: search.client_id,
        identifier,
        organizationId: search.organization_id,
        turnstileToken,
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

  const isLoading =
    passkey.isVerifying ||
    discovery.isPending ||
    pendingDiscovery !== null ||
    credentials.password.isPending ||
    credentials.magicLink.isPending ||
    credentials.otpSend.isPending ||
    credentials.otpVerify.isPending ||
    credentials.guest.isPending

  const state: SignInState = {
    step: authConfig.resolution.status === 'ambiguous' ? 'organization' : step,
    method,
    methods,
    authConfig,
    configSettled,
    enabledMethods,
    identifier,
    identifierKind,
    isSignUpFlow,
    profileValues,
    password,
    rememberMe,
    otpCode,
    otpSentAt,
    otpResent,
    isSendingOtp: credentials.otpSend.isPending || pendingOtpSend,
    isVerifyingOtp: credentials.otpVerify.isPending,
    magicLinkSent,
    ssoTarget,
    isLoading,
    passkeySupport: passkey.support,
    passkeyConditionalAvailable: passkey.conditionalAvailable,
    conditionalUiRunning: passkey.conditionalRunning,
    error: passkey.error ?? error,
    turnstileToken,
    turnstileReady,
    excludesFederatedEntry,
    hostedReturn,
    guestEntryPending:
      authConfigQuery.isPending &&
      !search.organization_id &&
      !search.client_id &&
      !search.invitation_token &&
      !search.authz_request_id &&
      (search.intent === undefined || search.intent === 'sign-up'),
    tenantSelection: {
      loginHint: search.login_hint ?? null,
      continueParam: search.continue ?? null,
      redirect: search.redirect ?? null,
      authzRequestId: search.authz_request_id ?? null,
    },
  }

  return [state, actions]
}
