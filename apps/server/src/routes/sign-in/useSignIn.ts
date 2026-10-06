// 登录业务逻辑;枚举防护:失败统一模糊 key,magic-link/OTP 成功不泄露联系方式是否存在。
// Turnstile 每次服务端校验后清空,由 widget 签发新单次 token。

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearch } from '@tanstack/react-router'
import { useMutation, useQuery } from '@tanstack/react-query'
import type { Result, XidError } from '@xid-kit/types'
import { useAuth } from '../../lib/auth-context'
import { useNavigate } from '../../lib/router'
import {
  apiErrorToKey,
  enabledSignInMethods,
  emptyProfileValues,
  federatedSignInErrorKey,
  initialSignInMethod,
  isOtpMethod,
  profilePayload,
  organizationSignInUrl,
  type ProfileFieldKey,
  type ProfileValues,
  type SignInErrorKey,
  type SignInMethod,
} from './shared'
import { trackEvent } from '../../lib/google-analytics'
import {
  trackAuthMethodSelected,
  trackAuthSuccess,
  trackMagicLinkSent,
  trackOtpSent,
  type AuthMethod,
} from '../../lib/google-analytics-funnel'
import {
  clearPendingAuthCompletion,
  setPendingAuthCompletion,
} from '../../lib/google-analytics-pending-auth'
import { buildSignInFlowFields, resolveHostedReturn } from './sign-in-flow'
import {
  buildFlowPayload,
  organizationSelectionPath,
  otpEndpoint,
  otpTarget,
} from './sign-in-requests'
import { usePasskeySignIn } from './usePasskeySignIn'
import type { PasskeySupport } from './usePasskeySignIn'
import { DEFAULT_PUBLIC_AUTH_CONFIG, type PublicHostedAuthConfig } from './auth-config'
import { authConfigQueryOptions } from './auth-config-query'
import {
  isProductSignUpIntent,
  isSignUpIntent,
  type HostedAuthIntent,
} from '../../../shared/hosted-auth-intent'

export type { SignInMethod, SignInErrorKey } from './shared'
export { buildAuthConfigPath } from './auth-config-query'

type AuthResponse = { redirectUrl?: string; nextStep?: 'verify_email' | 'complete' }
type AuthResult = Result<AuthResponse>
type HrdResult = {
  organizationId?: string
  connectionId: string | null
  orgId?: string
  protocol?: 'saml' | 'oidc'
}

const AUTH_METHOD_BY_SIGN_IN_METHOD: Readonly<Record<SignInMethod, AuthMethod>> = {
  'magic-link': 'magic_link',
  'otp-email': 'otp_email',
  'otp-whatsapp': 'otp_whatsapp',
  'otp-sms': 'otp_sms',
  'enterprise-sso': 'enterprise_sso',
  passkey: 'passkey',
  password: 'password',
}

export function buildSocialAuthorizeUrl(input: {
  origin: string
  provider: string
  hostedReturn: string
  intent?: HostedAuthIntent | null
  applicationClientId?: string | null
  identifier: string
  organizationId?: string
  turnstileToken: string | null
}): URL {
  const url = new URL(`/auth/${input.provider}/authorize`, input.origin)
  url.searchParams.set(
    'continue',
    isProductSignUpIntent(input.intent) ? '/create-organization' : input.hostedReturn,
  )
  if (input.intent) url.searchParams.set('intent', input.intent)
  if (input.applicationClientId) url.searchParams.set('client_id', input.applicationClientId)
  if (input.identifier.trim()) url.searchParams.set('login_hint', input.identifier.trim())
  if (input.organizationId) url.searchParams.set('organization_id', input.organizationId)
  if (input.turnstileToken) url.searchParams.set('turnstile', input.turnstileToken)
  return url
}

export function enabledSignInMethodsForIntent(
  config: PublicHostedAuthConfig,
  intent: string | null | undefined,
): readonly SignInMethod[] {
  const methods = enabledSignInMethods(config)
  // sign-up 尚无独立 passkey 注册流,禁止跑登录 ceremony。
  return isSignUpIntent(intent) ? methods.filter((method) => method !== 'passkey') : methods
}

export type SignInState = {
  method: SignInMethod
  authConfig: PublicHostedAuthConfig
  enabledMethods: readonly SignInMethod[]
  identifier: string
  profileValues: ProfileValues
  password: string
  rememberMe: boolean
  otpCode: string
  isLoading: boolean
  passkeySupport: PasskeySupport
  conditionalUiRunning: boolean
  error: SignInErrorKey | null
  otpStep: 'input' | 'sent'
  turnstileToken: string | null
  turnstileReady: boolean
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
  setMethod: (method: SignInMethod) => void
  setIdentifier: (value: string) => void
  setProfileValue: (field: ProfileFieldKey, value: string) => void
  setPassword: (value: string) => void
  setRememberMe: (value: boolean) => void
  setOtpCode: (value: string) => void
  setTurnstileToken: (token: string) => void
  submitPassword: () => void
  submitMagicLink: () => void
  submitOtpRequest: () => void
  submitOtpVerify: () => void
  submitEnterpriseSso: () => void
  submitGuest: () => void
  triggerPasskeyButton: () => void
  handleSocial: (provider: string) => void
  selectOrganizationContext: (organizationId: string) => void
}

type SignInSearch = {
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

export function useSignIn(): [SignInState, SignInActions] {
  const { api, refresh } = useAuth()
  const navigate = useNavigate()
  // strict:false:兼容工厂挂载,不绑单一 route id。
  const search = useSearch({ strict: false }) as SignInSearch
  const redirectParam = search.redirect ?? null
  const authzRequestId = search.authz_request_id ?? null
  const selectedOrganizationId = search.organization_id ?? null
  const signInFlowExtras = useMemo(
    () =>
      buildSignInFlowFields({
        authz_request_id: search.authz_request_id,
        continue: search.continue,
        redirect: search.redirect,
        client_id: search.client_id,
        intent: search.intent,
        invitation_token: search.invitation_token,
      }),
    [
      search.authz_request_id,
      search.continue,
      search.redirect,
      search.client_id,
      search.intent,
      search.invitation_token,
    ],
  )

  // deny-by-default 首屏 magic-link;passkey 探测只揭示 tab,绝不自动切面板。
  const [method, setMethodState] = useState<SignInMethod>(() =>
    initialSignInMethod(DEFAULT_PUBLIC_AUTH_CONFIG),
  )
  const [identifier, setIdentifier] = useState(search.login_hint ?? '')
  const [profileValues, setProfileValues] = useState<ProfileValues>(() => emptyProfileValues())
  const [password, setPassword] = useState('')
  const [rememberMe, setRememberMe] = useState(false)
  const [otpCode, setOtpCode] = useState('')
  const [otpStep, setOtpStep] = useState<'input' | 'sent'>('input')
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null)
  const [error, setError] = useState<SignInErrorKey | null>(() =>
    federatedSignInErrorKey(search.error),
  )
  const resetTurnstile = useCallback((): void => setTurnstileToken(null), [])

  const authConfigQuery = useQuery(authConfigQueryOptions(search, api))
  const authConfig = authConfigQuery.data ?? DEFAULT_PUBLIC_AUTH_CONFIG
  const hostedReturn = resolveHostedReturn(search, authConfig.defaultLandingPath)
  const turnstileReady =
    !authConfigQuery.isPending && (authConfig.turnstileSiteKey === null || Boolean(turnstileToken))
  // 邀请只走 Email claim:企业 SSO 不接受邀请 capability(01 章 3)。
  const excludesFederatedEntry =
    Boolean(search.invitation_token) || hostedReturn.startsWith('/accept-invitation?')
  const enabledMethods = useMemo<readonly SignInMethod[]>(() => {
    const methods = enabledSignInMethodsForIntent(
      authConfig,
      search.invitation_token ? 'sign-up' : search.intent,
    )
    return excludesFederatedEntry
      ? methods.filter((method) => method !== 'enterprise-sso')
      : methods
  }, [authConfig, excludesFederatedEntry, search.intent, search.invitation_token])

  useEffect(() => {
    if (!enabledMethods.includes(method)) setMethodState(enabledMethods[0] ?? 'enterprise-sso')
  }, [enabledMethods, method])

  const analyticsAuthIntent =
    search.invitation_token || isSignUpIntent(search.intent) ? 'sign_up' : 'sign_in'
  const flowPayload = useCallback(
    (options: { withTurnstile: boolean }) =>
      buildFlowPayload({
        organizationId: selectedOrganizationId,
        flowFields: signInFlowExtras,
        ...(options.withTurnstile ? { turnstileToken } : {}),
      }),
    [selectedOrganizationId, signInFlowExtras, turnstileToken],
  )

  // 多组织 identifier 由 Worker 返回 organization_selection_required:改走组织选择,不显示凭证错误。
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
    async (redirectUrl: string | undefined, authMethod: AuthMethod): Promise<void> => {
      clearPendingAuthCompletion()
      trackAuthSuccess({ method: authMethod, intent: analyticsAuthIntent })
      await refresh()
      navigate(redirectUrl ?? hostedReturn, { replace: true })
    },
    [analyticsAuthIntent, hostedReturn, navigate, refresh],
  )

  const handleAuthResult = useCallback(
    async (result: AuthResult, authMethod: AuthMethod): Promise<void> => {
      if (!result.ok) {
        showApiError(result.error)
        return
      }
      if (result.value.nextStep === 'verify_email') {
        setError('verify_email_sent')
        return
      }
      await finishSignIn(result.value.redirectUrl, authMethod)
    },
    [finishSignIn, showApiError],
  )

  const passkey = usePasskeySignIn({
    api,
    enabled: enabledMethods.includes('passkey') && !authConfigQuery.isPending,
    identifierRequired:
      authConfig.passkeyEntry.identifierRequired &&
      !selectedOrganizationId &&
      !signInFlowExtras.clientId,
    identifier,
    organizationId: selectedOrganizationId,
    flowFields: signInFlowExtras,
    turnstileRequired: authConfig.turnstileSiteKey !== null,
    turnstileToken,
    onTurnstileConsumed: resetTurnstile,
    onOrganizationSelectionRequired: () =>
      navigate(organizationSelectionPath(search, identifier), { replace: true }),
    onSuccess: async (redirectUrl) => {
      await finishSignIn(redirectUrl, 'passkey')
    },
  })

  const passwordMutation = useMutation({
    mutationFn: () =>
      api.post<AuthResponse>('/auth/password/sign-in', {
        identifier,
        ...profilePayload(profileValues),
        password,
        rememberMe,
        ...flowPayload({ withTurnstile: true }),
      }),
    onSuccess: (result) => handleAuthResult(result, 'password'),
    onSettled: resetTurnstile,
  })

  const magicLinkMutation = useMutation({
    mutationFn: () =>
      api.post('/auth/magic-link/send', {
        email: identifier,
        ...profilePayload(profileValues),
        ...flowPayload({ withTurnstile: true }),
      }),
    onSuccess: (result) => {
      if (!result.ok) {
        showApiError(result.error)
        return
      }
      trackMagicLinkSent(analyticsAuthIntent)
      setPendingAuthCompletion({ method: 'magic_link', intent: analyticsAuthIntent })
      // 枚举防护:不区分邮箱是否存在,统一"已发送"。
      setError('magic_link_sent')
    },
    onSettled: resetTurnstile,
  })

  const otpMethod = isOtpMethod(method) ? method : 'otp-email'
  const otpRequestMutation = useMutation({
    mutationFn: () =>
      api.post(otpEndpoint(otpMethod, 'send'), {
        [otpTarget(otpMethod).field]: identifier,
        ...profilePayload(profileValues),
        ...flowPayload({ withTurnstile: true }),
      }),
    onSuccess: (result) => {
      if (!result.ok) {
        showApiError(result.error)
        return
      }
      trackOtpSent(otpTarget(otpMethod).channel, analyticsAuthIntent)
      setOtpStep('sent')
      setError('otp_sent')
    },
    onSettled: resetTurnstile,
  })

  const otpVerifyMutation = useMutation({
    mutationFn: () =>
      api.post<AuthResponse>(otpEndpoint(otpMethod, 'verify'), {
        [otpTarget(otpMethod).field]: identifier,
        code: otpCode,
        ...flowPayload({ withTurnstile: false }),
      }),
    onSuccess: (result) => handleAuthResult(result, AUTH_METHOD_BY_SIGN_IN_METHOD[otpMethod]),
  })

  const enterpriseSsoMutation = useMutation({
    mutationFn: () =>
      api.post<HrdResult>('/sso/hrd', {
        email: identifier,
        ...(selectedOrganizationId ? { organizationId: selectedOrganizationId } : {}),
        ...(search.intent ? { intent: search.intent } : {}),
        ...(search.client_id ? { clientId: search.client_id } : {}),
        turnstileToken,
      }),
    onSuccess: (result) => {
      if (!result.ok) {
        showApiError(result.error)
        return
      }
      if (!result.value.connectionId || !result.value.protocol) {
        setError('sso_not_available')
        return
      }
      const path =
        result.value.protocol === 'saml'
          ? `/sso/saml/${result.value.connectionId}/login`
          : `/sso/oidc/${result.value.connectionId}/authorize`
      trackEvent('enterprise_sso_start', { protocol: result.value.protocol })
      setPendingAuthCompletion({ method: 'enterprise_sso', intent: analyticsAuthIntent })
      const url = new URL(path, globalThis.location.origin)
      url.searchParams.set('continue', hostedReturn)
      if (search.intent) url.searchParams.set('intent', search.intent)
      if (search.client_id) url.searchParams.set('client_id', search.client_id)
      if (result.value.organizationId) {
        url.searchParams.set('organization_id', result.value.organizationId)
      }
      globalThis.location.href = url.toString()
    },
    onSettled: resetTurnstile,
  })

  const guestMutation = useMutation({
    mutationFn: (capabilityToken: string) =>
      api.post<{ redirectUrl: string }>('/auth/guest', {
        capabilityToken,
        turnstileToken,
      }),
    onSuccess: async (result) => {
      if (!result.ok) {
        setError(apiErrorToKey(result.error))
        return
      }
      await finishSignIn(result.value.redirectUrl, 'guest')
    },
    onSettled: async () => {
      resetTurnstile()
      await authConfigQuery.refetch()
    },
  })

  const handleSocial = useCallback(
    (provider: string): void => {
      if (!turnstileReady || excludesFederatedEntry) return
      trackEvent('social_login_start', { provider })
      setPendingAuthCompletion({ method: 'social', intent: analyticsAuthIntent })
      const url = buildSocialAuthorizeUrl({
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
      })
      globalThis.location.href = url.toString()
    },
    [
      analyticsAuthIntent,
      excludesFederatedEntry,
      hostedReturn,
      identifier,
      search.intent,
      search.organization_id,
      search.client_id,
      turnstileToken,
      turnstileReady,
    ],
  )

  const selectOrganizationContext = useCallback(
    (organizationId: string): void => {
      const match =
        authConfig.resolution.status === 'ambiguous'
          ? authConfig.resolution.matches.find((item) => item.organizationId === organizationId)
          : undefined
      if (!match) return
      globalThis.location.href = organizationSignInUrl(match, {
        loginHint: identifier || search.login_hint || null,
        continueParam: search.continue ?? null,
        redirect: redirectParam,
        authzRequestId,
        intent: search.intent ?? null,
        invitationToken: search.invitation_token ?? null,
      })
    },
    [
      authConfig.resolution,
      authzRequestId,
      identifier,
      redirectParam,
      search.continue,
      search.login_hint,
      search.intent,
      search.invitation_token,
    ],
  )

  const setMethod = useCallback((next: SignInMethod): void => {
    trackAuthMethodSelected(AUTH_METHOD_BY_SIGN_IN_METHOD[next])
    setMethodState(next)
    setError(null)
    setOtpStep('input')
  }, [])

  const setProfileValue = useCallback((field: ProfileFieldKey, value: string): void => {
    setProfileValues((prev) => ({ ...prev, [field]: value }))
  }, [])

  const isLoading =
    passkey.isVerifying ||
    passwordMutation.isPending ||
    magicLinkMutation.isPending ||
    otpRequestMutation.isPending ||
    otpVerifyMutation.isPending ||
    enterpriseSsoMutation.isPending ||
    guestMutation.isPending

  const state: SignInState = {
    method,
    authConfig,
    enabledMethods,
    identifier,
    profileValues,
    password,
    rememberMe,
    otpCode,
    isLoading,
    passkeySupport: passkey.support,
    conditionalUiRunning: passkey.conditionalRunning,

    error: passkey.error ?? error,
    otpStep,
    turnstileToken,
    turnstileReady,
    // org/client/invitation/authz 任一存在则无 guest 入口;租户维度须等 config。
    guestEntryPending:
      authConfigQuery.isPending &&
      !search.organization_id &&
      !search.client_id &&
      !search.invitation_token &&
      !authzRequestId &&
      (search.intent === undefined || search.intent === 'sign-up'),
    tenantSelection: {
      loginHint: search.login_hint ?? null,
      continueParam: search.continue ?? null,
      redirect: redirectParam,
      authzRequestId,
    },
  }

  const whenTurnstileReady =
    (action: () => void): (() => void) =>
    () => {
      if (turnstileReady) action()
    }

  const actions: SignInActions = {
    setMethod,
    setIdentifier,
    setProfileValue,
    setPassword,
    setRememberMe,
    setOtpCode: (value) => setOtpCode(value.replace(/\D/g, '')),
    setTurnstileToken,
    submitPassword: whenTurnstileReady(() => passwordMutation.mutate()),
    submitMagicLink: whenTurnstileReady(() => magicLinkMutation.mutate()),
    submitOtpRequest: whenTurnstileReady(() => otpRequestMutation.mutate()),
    submitOtpVerify: () => otpVerifyMutation.mutate(),
    submitEnterpriseSso: whenTurnstileReady(() => {
      if (!excludesFederatedEntry) enterpriseSsoMutation.mutate()
    }),
    submitGuest: () => {
      if (authConfig.guest && turnstileReady) {
        guestMutation.mutate(authConfig.guest.capabilityToken)
      }
    },
    triggerPasskeyButton: whenTurnstileReady(() => passkey.triggerButton()),
    handleSocial,
    selectOrganizationContext,
  }

  return [state, actions]
}
