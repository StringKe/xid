// 登录业务逻辑;枚举防护:失败统一模糊 key,magic-link/OTP 成功不泄露联系方式是否存在。
// Turnstile 每次服务端校验后清空,由 widget 签发新单次 token。

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearch } from '@tanstack/react-router'
import { useMutation, useQuery } from '@tanstack/react-query'
import type { Result } from '@xid-kit/types'
import { useAuth } from '../../lib/auth-context'
import { useNavigate } from '../../lib/router'
import {
  apiErrorToKey,
  enabledSignInMethods,
  emptyProfileValues,
  initialSignInMethod,
  profilePayload,
  resolveHostedReturn,
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

type SignInResult = Result<{
  redirectUrl?: string
  nextStep?: 'verify_email' | 'complete'
}>
type PasswordResult = Result<{ redirectUrl?: string; nextStep?: 'verify_email' | 'complete' }>
type HrdResult = {
  organizationId?: string
  connectionId: string | null
  orgId?: string
  protocol?: 'saml' | 'oidc'
}

export function buildSocialAuthorizeUrl(input: {
  origin: string
  provider: string
  hostedReturn: string
  intent?: HostedAuthIntent | null
  applicationClientId?: string | null
  identifier: string
  organizationId?: string
  invitationToken?: string | null
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
  if (input.invitationToken) url.searchParams.set('invitation_token', input.invitationToken)
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

export function useSignIn(): [SignInState, SignInActions] {
  const { api, refresh } = useAuth()
  const navigate = useNavigate()
  // strict:false:兼容工厂挂载,不绑单一 route id。
  const search = useSearch({ strict: false }) as {
    authz_request_id?: string
    continue?: string
    login_hint?: string
    redirect?: string
    organization_id?: string
    client_id?: string
    intent?: string
    invitation_token?: string
  }
  const continueParam = search.continue ?? search.redirect ?? null
  const redirectParam = search.redirect ?? null
  const authzRequestId = search.authz_request_id ?? null
  const selectedOrganizationId = search.organization_id ?? null
  const hostedReturn = resolveHostedReturn(continueParam, authzRequestId, search.client_id)
  const signInFlowExtras = {
    ...(continueParam ? { continue: continueParam } : {}),
    ...(search.intent ? { intent: search.intent } : {}),
    ...(search.client_id ? { clientId: search.client_id } : {}),
    ...(search.invitation_token ? { invitationToken: search.invitation_token } : {}),
  }

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
  const [error, setError] = useState<SignInErrorKey | null>(null)
  const resetTurnstile = useCallback((): void => setTurnstileToken(null), [])

  const authConfigQuery = useQuery(authConfigQueryOptions(search, api))
  const authConfig = authConfigQuery.data ?? DEFAULT_PUBLIC_AUTH_CONFIG
  const enabledMethods = useMemo<readonly SignInMethod[]>(() => {
    return enabledSignInMethodsForIntent(
      authConfig,
      search.invitation_token ? 'sign-up' : search.intent,
    )
  }, [authConfig, search.intent, search.invitation_token])

  useEffect(() => {
    if (!enabledMethods.includes(method)) setMethodState(enabledMethods[0] ?? 'enterprise-sso')
  }, [enabledMethods, method])

  const authFlowIntent =
    search.invitation_token || isSignUpIntent(search.intent) ? 'sign_up' : 'sign_in'
  const analyticsAuthIntent = authFlowIntent === 'sign_up' ? 'sign_up' : 'sign_in'

  function signInMethodToAuthMethod(signInMethod: SignInMethod): AuthMethod {
    if (signInMethod === 'magic-link') return 'magic_link'
    if (signInMethod === 'otp-email') return 'otp_email'
    if (signInMethod === 'otp-whatsapp') return 'otp_whatsapp'
    if (signInMethod === 'otp-sms') return 'otp_sms'
    if (signInMethod === 'enterprise-sso') return 'enterprise_sso'
    if (signInMethod === 'passkey') return 'passkey'
    if (signInMethod === 'password') return 'password'
    return 'unknown'
  }

  const finishSignIn = useCallback(
    async (redirectUrl: string | undefined, method: AuthMethod): Promise<void> => {
      clearPendingAuthCompletion()
      trackAuthSuccess({
        method,
        intent: authFlowIntent === 'sign_up' ? 'sign_up' : 'sign_in',
      })
      await refresh()
      const target = redirectUrl ?? hostedReturn
      if (authzRequestId) {
        globalThis.location.href = target
        return
      }
      navigate(target, { replace: true })
    },
    [authFlowIntent, authzRequestId, hostedReturn, navigate, refresh],
  )

  const handleAuthResult = useCallback(
    async (result: SignInResult): Promise<void> => {
      if (!result.ok) {
        setError(apiErrorToKey(result.error.code))
        return
      }
      if (result.value.nextStep === 'verify_email') {
        setError('verify_email_sent')
        return
      }
      const otpMethod: AuthMethod =
        method === 'otp-email'
          ? 'otp_email'
          : method === 'otp-whatsapp'
            ? 'otp_whatsapp'
            : 'otp_sms'
      await finishSignIn(result.value.redirectUrl, otpMethod)
    },
    [finishSignIn, method],
  )

  const passkey = usePasskeySignIn({
    api,
    enabled: enabledMethods.includes('passkey'),
    identifier,
    organizationId: selectedOrganizationId,
    applicationClientId: search.client_id,
    turnstileToken,
    onTurnstileConsumed: resetTurnstile,
    onSuccess: async (redirectUrl) => {
      await finishSignIn(redirectUrl, 'passkey')
    },
  })

  const passwordMutation = useMutation({
    mutationFn: () =>
      api.post<{ redirectUrl?: string; nextStep?: 'verify_email' | 'complete' }>(
        '/auth/password/sign-in',
        {
          identifier,
          ...profilePayload(profileValues),
          password,
          rememberMe,
          ...(selectedOrganizationId ? { organizationId: selectedOrganizationId } : {}),
          ...signInFlowExtras,
          turnstileToken,
        },
      ),
    onSuccess: async (result: PasswordResult) => {
      if (!result.ok) {
        setError(apiErrorToKey(result.error.code))
        return
      }
      if (result.value.nextStep === 'verify_email') {
        setError('verify_email_sent')
        return
      }
      await finishSignIn(result.value.redirectUrl, 'password')
    },
    onSettled: resetTurnstile,
  })

  const magicLinkMutation = useMutation({
    mutationFn: () =>
      api.post('/auth/magic-link/send', {
        email: identifier,
        ...profilePayload(profileValues),
        ...(selectedOrganizationId ? { organizationId: selectedOrganizationId } : {}),
        ...signInFlowExtras,
        turnstileToken,
      }),
    onSuccess: (result) => {
      if (result.ok) {
        trackMagicLinkSent(analyticsAuthIntent)
        setPendingAuthCompletion({ method: 'magic_link', intent: analyticsAuthIntent })
      }
      // 枚举防护:不区分邮箱是否存在,统一"已发送"。
      setError(result.ok ? 'magic_link_sent' : apiErrorToKey(result.error.code))
    },
    onSettled: resetTurnstile,
  })

  const otpRequestMutation = useMutation({
    mutationFn: () => {
      const endpoint =
        method === 'otp-email'
          ? '/auth/otp/email/send'
          : method === 'otp-whatsapp'
            ? '/auth/otp/whatsapp/send'
            : '/auth/otp/sms/send'
      const body =
        method === 'otp-email'
          ? {
              email: identifier,
              ...profilePayload(profileValues),
              ...(selectedOrganizationId ? { organizationId: selectedOrganizationId } : {}),
              ...signInFlowExtras,
              turnstileToken,
            }
          : {
              phone: identifier,
              ...profilePayload(profileValues),
              ...(selectedOrganizationId ? { organizationId: selectedOrganizationId } : {}),
              ...signInFlowExtras,
              turnstileToken,
            }
      return api.post(endpoint, body)
    },
    onSuccess: (result) => {
      if (!result.ok) {
        setError(apiErrorToKey(result.error.code))
        return
      }
      const channel =
        method === 'otp-email' ? 'email' : method === 'otp-whatsapp' ? 'whatsapp' : 'sms'
      trackOtpSent(channel, analyticsAuthIntent)
      setOtpStep('sent')
      setError('otp_sent')
    },
    onSettled: resetTurnstile,
  })

  const otpVerifyMutation = useMutation({
    mutationFn: () => {
      const endpoint =
        method === 'otp-email'
          ? '/auth/otp/email/verify'
          : method === 'otp-whatsapp'
            ? '/auth/otp/whatsapp/verify'
            : '/auth/otp/sms/verify'
      const body =
        method === 'otp-email'
          ? {
              email: identifier,
              code: otpCode,
              ...(selectedOrganizationId ? { organizationId: selectedOrganizationId } : {}),
              ...signInFlowExtras,
            }
          : {
              phone: identifier,
              code: otpCode,
              ...(selectedOrganizationId ? { organizationId: selectedOrganizationId } : {}),
              ...signInFlowExtras,
            }
      return api.post<{ redirectUrl?: string; nextStep?: 'verify_email' | 'complete' }>(
        endpoint,
        body,
      )
    },
    onSuccess: handleAuthResult,
  })

  const enterpriseSsoMutation = useMutation({
    mutationFn: () =>
      api.post<HrdResult>('/sso/hrd', {
        email: identifier,
        ...(selectedOrganizationId ? { organizationId: selectedOrganizationId } : {}),
        ...(search.invitation_token ? { invitationToken: search.invitation_token } : {}),
        ...(search.intent ? { intent: search.intent } : {}),
        ...(search.client_id ? { clientId: search.client_id } : {}),
        turnstileToken,
      }),
    onSuccess: (result) => {
      if (!result.ok || !result.value.connectionId || !result.value.protocol) {
        setError(result.ok ? 'auth_failed' : apiErrorToKey(result.error.code))
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
      if (search.invitation_token) {
        url.searchParams.set('invitation_token', search.invitation_token)
      }
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
        setError(apiErrorToKey(result.error.code))
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
        invitationToken: search.invitation_token ?? null,
        turnstileToken,
      })
      globalThis.location.href = url.toString()
    },
    [
      analyticsAuthIntent,
      authFlowIntent,
      hostedReturn,
      identifier,
      search.organization_id,
      search.client_id,
      search.invitation_token,
      turnstileToken,
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
    trackAuthMethodSelected(signInMethodToAuthMethod(next))
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

  const actions: SignInActions = {
    setMethod,
    setIdentifier,
    setProfileValue,
    setPassword,
    setRememberMe,
    setOtpCode: (value) => setOtpCode(value.replace(/\D/g, '')),
    setTurnstileToken,
    submitPassword: () => passwordMutation.mutate(),
    submitMagicLink: () => magicLinkMutation.mutate(),
    submitOtpRequest: () => otpRequestMutation.mutate(),
    submitOtpVerify: () => otpVerifyMutation.mutate(),
    submitEnterpriseSso: () => enterpriseSsoMutation.mutate(),
    submitGuest: () => {
      if (authConfig.guest) guestMutation.mutate(authConfig.guest.capabilityToken)
    },
    triggerPasskeyButton: passkey.triggerButton,
    handleSocial,
    selectOrganizationContext,
  }

  return [state, actions]
}
