// 标识符提交后的去向:等 /auth/config 按 login_hint 解析完,再决定企业 SSO、组织选择或第二步。

import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import type { XidError } from '@xid-kit/types'
import type { ApiClient } from '../../lib/api'
import { trackEvent } from '../../lib/google-analytics'
import type { AuthFlowIntent } from '../../lib/google-analytics-funnel'
import { setPendingAuthCompletion } from '../../lib/google-analytics-pending-auth'
import { enterpriseSsoEnabled, type PublicHostedAuthConfig } from './auth-config'
import {
  browserStorage,
  defaultSecondStepMethod,
  identifierKindOf,
  readLastAuthMethod,
} from './method-order'
import { isOtpMethod, type SignInErrorKey, type SignInMethod } from './shared'
import type { SignInSearch, SignInStep } from './sign-in-types'
import { ssoTargetFrom, useSsoDiscovery, type SsoTarget } from './useSsoDiscovery'

export type PendingDiscovery = { identifier: string; ssoOnly: boolean }

export type IdentifierDiscoveryOptions = {
  api: ApiClient
  search: SignInSearch
  authConfig: PublicHostedAuthConfig
  configSettled: boolean
  methods: readonly SignInMethod[]
  isSignUpFlow: boolean
  excludesFederatedEntry: boolean
  turnstileReady: boolean
  turnstileToken: string | null
  selectedOrganizationId: string | null
  hostedReturn: string
  analyticsIntent: AuthFlowIntent
  resetTurnstile: () => void
  showApiError: (apiError: Pick<XidError, 'code' | 'meta'>) => void
  setError: Dispatch<SetStateAction<SignInErrorKey | null>>
  setStep: Dispatch<SetStateAction<SignInStep>>
  setMethod: Dispatch<SetStateAction<SignInMethod>>
  setPendingOtpSend: Dispatch<SetStateAction<boolean>>
}

export type IdentifierDiscovery = {
  pendingDiscovery: PendingDiscovery | null
  startDiscovery: (request: PendingDiscovery) => void
  ssoTarget: SsoTarget | null
  setSsoTarget: Dispatch<SetStateAction<SsoTarget | null>>
  isDiscovering: boolean
}

export function useIdentifierDiscovery(options: IdentifierDiscoveryOptions): IdentifierDiscovery {
  const { api, search, authConfig, configSettled, methods, isSignUpFlow, excludesFederatedEntry } =
    options
  const { turnstileReady, turnstileToken, selectedOrganizationId, hostedReturn, analyticsIntent } =
    options
  const { resetTurnstile, showApiError, setError, setStep, setMethod, setPendingOtpSend } = options
  const [pendingDiscovery, setPendingDiscovery] = useState<PendingDiscovery | null>(null)
  const [ssoTarget, setSsoTarget] = useState<SsoTarget | null>(null)
  const discovery = useSsoDiscovery(api, resetTurnstile)

  const enterMethodsStep = useCallback((): void => {
    const preferred = defaultSecondStepMethod(methods, readLastAuthMethod(browserStorage()))
    if (!preferred) {
      setError(authConfig.forceSso ? 'sso_not_available' : 'auth_failed')
      return
    }
    setMethod(preferred)
    setStep('methods')
    if (isOtpMethod(preferred) && !isSignUpFlow) setPendingOtpSend(true)
  }, [authConfig.forceSso, isSignUpFlow, methods, setError, setMethod, setPendingOtpSend, setStep])

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
    setError,
    setStep,
    showApiError,
    turnstileReady,
    turnstileToken,
  ])

  return {
    pendingDiscovery,
    startDiscovery: setPendingDiscovery,
    ssoTarget,
    setSsoTarget,
    isDiscovering: discovery.isPending,
  }
}
