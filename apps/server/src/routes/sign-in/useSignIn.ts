// 标识符优先的登录:第一步只收标识符(passkey 从 autofill 出现),提交后按已验证域名直跳企业 SSO、
// 按根入口歧义选组织,否则进入第二步。失败统一模糊 key;发码与发链接成功不泄露联系方式是否存在。

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearch } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useLocalizedAuthConfig } from '../../components/hosted/use-hosted-auth-config'
import { useAuth } from '../../lib/auth-context'
import { useNavigate } from '@xid-kit/web-ui/tanstack-router'
import { emptyProfileValues, federatedSignInErrorKey } from './shared'
import type { ProfileValues, SignInErrorKey, SignInMethod } from './shared'
import { buildSignInFlowFields, resolveHostedReturn } from './sign-in-flow'
import { buildFlowPayload, organizationSelectionPath } from './sign-in-requests'
import { usePasskeySignIn } from './usePasskeySignIn'
import { DEFAULT_PUBLIC_AUTH_CONFIG } from './auth-config'
import { authConfigQueryOptions } from './auth-config-query'
import { isSignUpIntent } from '../../../shared/hosted-auth-intent'
import { identifierKindOf, secondStepMethods } from './method-order'
import type { SignInActions, SignInSearch, SignInState, SignInStep } from './sign-in-types'
import { enabledSignInMethodsForIntent } from './sign-in-entry'
import { useCredentialMutations } from './useCredentialMutations'
import { useIdentifierDiscovery } from './useIdentifierDiscovery'
import { useSignInCompletion } from './useSignInCompletion'
import { useOtpSend } from './useOtpSend'
import { buildSignInActions } from './sign-in-actions'

export type { SignInActions, SignInState, SignInStep } from './sign-in-types'
export type { SignInMethod, SignInErrorKey } from './shared'
export { buildAuthConfigPath } from './auth-config-query'
export { buildSocialAuthorizeUrl, enabledSignInMethodsForIntent } from './sign-in-entry'

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
  const [pendingOtpSend, setPendingOtpSend] = useState(false)
  const [magicLinkSent, setMagicLinkSent] = useState(false)
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null)
  const [error, setError] = useState<SignInErrorKey | null>(() =>
    federatedSignInErrorKey(search.error),
  )
  const resetTurnstile = useCallback((): void => setTurnstileToken(null), [])

  const authConfigQuery = useQuery(authConfigQueryOptions(search, api))
  const authConfig = useLocalizedAuthConfig(authConfigQuery.data ?? DEFAULT_PUBLIC_AUTH_CONFIG)
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

  const { showApiError, finishSignIn, handleAuthResult } = useSignInCompletion({
    navigate,
    refresh,
    search,
    identifier,
    analyticsIntent,
    enabledMethods,
    hostedReturn,
    isSignUpFlow,
    setError,
  })

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

  const otp = useOtpSend({
    otpSend: credentials.otpSend,
    identifier,
    isSignUpFlow,
    profileValues,
    analyticsIntent,
    showApiError,
    setError,
  })
  const { sendOtp } = otp

  const discovery = useIdentifierDiscovery({
    api,
    search,
    authConfig,
    configSettled,
    methods,
    isSignUpFlow,
    excludesFederatedEntry,
    turnstileReady,
    turnstileToken,
    selectedOrganizationId,
    hostedReturn,
    analyticsIntent,
    resetTurnstile,
    showApiError,
    setError,
    setStep,
    setMethod: setMethodState,
    setPendingOtpSend,
  })

  useEffect(() => {
    if (!pendingOtpSend || step !== 'methods' || !turnstileReady || credentials.otpSend.isPending)
      return
    setPendingOtpSend(false)
    sendOtp(method)
  }, [credentials.otpSend.isPending, method, pendingOtpSend, sendOtp, step, turnstileReady])

  const actions = buildSignInActions({
    search,
    navigate,
    authConfig,
    identifier,
    password,
    rememberMe,
    profileValues,
    method,
    isSignUpFlow,
    analyticsIntent,
    turnstileReady,
    turnstileToken,
    excludesFederatedEntry,
    hostedReturn,
    credentials,
    passkey,
    otp,
    discovery,
    refetchAuthConfig: () => void authConfigQuery.refetch(),
    showApiError,
    handleAuthResult,
    finishSignIn,
    setIdentifier,
    setProfileValues,
    setPassword,
    setRememberMe,
    setPendingOtpSend,
    setMagicLinkSent,
    setTurnstileToken,
    setMethod: setMethodState,
    setStep,
    setError,
  })

  const isLoading =
    passkey.isVerifying ||
    discovery.isDiscovering ||
    discovery.pendingDiscovery !== null ||
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
    otpCode: otp.otpCode,
    otpSentAt: otp.otpSentAt,
    otpResent: otp.otpResent,
    isSendingOtp: credentials.otpSend.isPending || pendingOtpSend,
    isVerifyingOtp: credentials.otpVerify.isPending,
    magicLinkSent,
    ssoTarget: discovery.ssoTarget,
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
