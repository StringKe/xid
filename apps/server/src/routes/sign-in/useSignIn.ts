// useSignIn:登录页业务逻辑(TanStack Router useSearch + Query useMutation)。
// 五条认证路径:passkey(委托 usePasskeySignIn)/ 密码 / magic-link / email+WhatsApp+SMS OTP / 社交。
// 枚举防护(铁律):认证失败统一模糊 key,magic-link/OTP 成功不泄露联系方式是否存在。
// Turnstile invisible token 由 SignInPage 在 callback 中注入(setTurnstileToken)。

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { useMutation, useQuery } from '@tanstack/react-query'
import type { Result } from '@xid-kit/types'
import { useAuth } from '../../lib/auth-context'
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

export type { SignInMethod, SignInErrorKey } from './shared'

type SignInResult = Result<{ redirectUrl?: string }>
type PasswordResult = Result<{ redirectUrl?: string; nextStep?: 'verify_email' | 'complete' }>
type HrdResult = {
  organizationId?: string
  connectionId: string | null
  orgId?: string
  protocol?: 'saml' | 'oidc'
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
  triggerPasskeyButton: () => void
  handleSocial: (provider: string) => void
  selectOrganizationContext: (organizationId: string) => void
}

export function useSignIn(): [SignInState, SignInActions] {
  const { api, refresh } = useAuth()
  const navigate = useNavigate()
  // strict:false -- /sign-in 经兼容工厂挂载,不绑定单一 route id;透传任意 query。
  const search = useSearch({ strict: false }) as {
    authz_request_id?: string
    continue?: string
    login_hint?: string
    redirect?: string
    organization_id?: string
    intent?: string
    invitation_token?: string
  }
  const continueParam = search.continue ?? search.redirect ?? null
  const redirectParam = search.redirect ?? null
  const authzRequestId = search.authz_request_id ?? null
  const selectedOrganizationId = search.organization_id ?? null
  const hostedReturn = resolveHostedReturn(continueParam, authzRequestId)
  const signInFlowExtras = {
    ...(continueParam ? { continue: continueParam } : {}),
    ...(search.intent ? { intent: search.intent } : {}),
    ...(search.invitation_token ? { invitationToken: search.invitation_token } : {}),
  }

  // 初始方法来自 deny-by-default fallback,默认租户首屏为 magic-link。
  // passkey 探测成功只揭示 passkey tab(SignInTabs 据 passkeySupport 渲染),用户主动点 tab 才切换,绝不自动切 active panel。
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

  const authConfigQuery = useQuery<PublicHostedAuthConfig, never>({
    queryKey: ['auth-config', search.login_hint ?? null, search.organization_id ?? null],
    queryFn: async () => {
      const params = new URLSearchParams()
      if (search.login_hint) params.set('login_hint', search.login_hint)
      if (search.organization_id) params.set('organization_id', search.organization_id)
      const configPath = params.size > 0 ? `/auth/config?${params.toString()}` : '/auth/config'
      const result = await api.get<PublicHostedAuthConfig>(configPath)
      return result.ok ? result.value : DEFAULT_PUBLIC_AUTH_CONFIG
    },
    retry: false,
  })
  const authConfig = authConfigQuery.data ?? DEFAULT_PUBLIC_AUTH_CONFIG
  const enabledMethods = useMemo<readonly SignInMethod[]>(() => {
    return enabledSignInMethods(authConfig)
  }, [authConfig])

  useEffect(() => {
    if (!enabledMethods.includes(method)) setMethodState(enabledMethods[0] ?? 'enterprise-sso')
  }, [enabledMethods, method])

  const authFlowIntent = search.intent === 'sign-up' ? 'sign_up' : 'sign_in'
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

  // 登录成功统一收尾:刷新 /v1/me 后导航到回跳目标。
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
      void navigate({ to: target as never, replace: true })
    },
    [authFlowIntent, authzRequestId, hostedReturn, navigate, refresh],
  )

  // 认证类提交后的统一结果处理:失败置错误 key,成功收尾导航。
  const handleAuthResult = useCallback(
    async (result: SignInResult): Promise<void> => {
      if (!result.ok) {
        setError(apiErrorToKey(result.error.code))
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
      // 成功不区分邮箱是否存在(枚举防护),统一显示"已发送"。
      setError(result.ok ? 'magic_link_sent' : apiErrorToKey(result.error.code))
    },
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
      return api.post<{ redirectUrl?: string }>(endpoint, body)
    },
    onSuccess: handleAuthResult,
  })

  const enterpriseSsoMutation = useMutation({
    mutationFn: () =>
      api.post<HrdResult>('/sso/hrd', {
        email: identifier,
        ...(selectedOrganizationId ? { organizationId: selectedOrganizationId } : {}),
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
      if (result.value.organizationId) {
        url.searchParams.set('organization_id', result.value.organizationId)
      }
      globalThis.location.href = url.toString()
    },
  })

  // 社交登录:整页跳到 OAuth 端点,带 continue 让 callback 回跳正确目标。
  const handleSocial = useCallback(
    (provider: string): void => {
      trackEvent('social_login_start', { provider })
      setPendingAuthCompletion({ method: 'social', intent: analyticsAuthIntent })
      const url = new URL(`/auth/${provider}/authorize`, globalThis.location.origin)
      url.searchParams.set('continue', hostedReturn)
      if (identifier.trim()) url.searchParams.set('login_hint', identifier.trim())
      if (search.organization_id) url.searchParams.set('organization_id', search.organization_id)
      if (turnstileToken) url.searchParams.set('turnstile', turnstileToken)
      globalThis.location.href = url.toString()
    },
    [analyticsAuthIntent, hostedReturn, identifier, search.organization_id, turnstileToken],
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
      })
    },
    [
      authConfig.resolution,
      authzRequestId,
      identifier,
      redirectParam,
      search.continue,
      search.login_hint,
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
    enterpriseSsoMutation.isPending

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
    // passkey verify 错误优先(其分支独立于表单错误)。
    error: passkey.error ?? error,
    otpStep,
    turnstileToken,
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
    triggerPasskeyButton: passkey.triggerButton,
    handleSocial,
    selectOrganizationContext,
  }

  return [state, actions]
}
