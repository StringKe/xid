// Conditional UI + 降级按钮;四验证在 server。support='pending' 时保持骨架防 CLS。

import { useCallback, useEffect, useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import type { ApiClient } from '../../lib/api'
import { apiErrorToKey, type SignInErrorKey } from './shared'
import { b64urlToBytes, serializeAssertion } from './passkey'
import type { SignInFlowFields } from './sign-in-flow'

type ChallengeResponse = { challenge: string; sessionId: string; organizationId?: string }
type VerifyResponse = { redirectUrl?: string }
type VerifyBody = ReturnType<typeof serializeAssertion> & {
  organizationId?: string
  clientId?: string
  continue?: string
  intent?: string
  turnstileToken?: string | null
}

export type PasskeySupport = 'pending' | 'yes' | 'no'

export type PasskeySignIn = {
  support: PasskeySupport
  conditionalRunning: boolean
  isVerifying: boolean
  error: SignInErrorKey | null
  triggerButton: () => void
}

type PasskeySignInOptions = {
  api: ApiClient
  enabled: boolean
  identifier: string
  organizationId?: string | null
  flowFields: SignInFlowFields
  turnstileToken: string | null
  onTurnstileConsumed: () => void
  onOrganizationSelectionRequired: () => void
  onSuccess: (redirectUrl: string | undefined) => Promise<void>
}

type ChallengeOutcome = ChallengeResponse | 'organization_selection_required' | null

async function fetchChallenge(
  api: ApiClient,
  identifier: string,
  organizationId: string | null | undefined,
  flowFields: SignInFlowFields,
): Promise<ChallengeOutcome> {
  const result = await api.post<ChallengeResponse>('/auth/passkey/challenge', {
    identifier,
    ...(organizationId ? { organizationId } : {}),
    ...(flowFields.clientId ? { clientId: flowFields.clientId } : {}),
  })
  if (result.ok) return result.value
  return result.error.code === 'organization_selection_required' ? result.error.code : null
}

function assertionBody(
  credential: PublicKeyCredential,
  challenge: ChallengeResponse,
  flowFields: SignInFlowFields,
  turnstileToken: string | null,
): VerifyBody {
  return {
    ...serializeAssertion(credential, challenge.sessionId),
    ...(challenge.organizationId ? { organizationId: challenge.organizationId } : {}),
    ...(flowFields.clientId ? { clientId: flowFields.clientId } : {}),
    ...(flowFields.continue ? { continue: flowFields.continue } : {}),
    ...(flowFields.intent ? { intent: flowFields.intent } : {}),
    ...(turnstileToken ? { turnstileToken } : {}),
  }
}

export function usePasskeySignIn(options: PasskeySignInOptions): PasskeySignIn {
  const {
    api,
    enabled,
    identifier,
    organizationId,
    flowFields,
    turnstileToken,
    onTurnstileConsumed,
    onSuccess,
  } = options
  const onOrganizationSelectionRequiredRef = useRef(options.onOrganizationSelectionRequired)
  onOrganizationSelectionRequiredRef.current = options.onOrganizationSelectionRequired
  const [support, setSupport] = useState<PasskeySupport>('pending')
  const [conditionalRunning, setConditionalRunning] = useState(false)
  const [error, setError] = useState<SignInErrorKey | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  // Conditional UI 跨 render 等待选择,提交须读最新单次 Turnstile token。
  const turnstileTokenRef = useRef(turnstileToken)
  turnstileTokenRef.current = turnstileToken
  const onTurnstileConsumedRef = useRef(onTurnstileConsumed)
  onTurnstileConsumedRef.current = onTurnstileConsumed

  const verifyMutation = useMutation({
    mutationFn: (body: VerifyBody) => api.post<VerifyResponse>('/auth/passkey/verify', body),
    onSuccess: async (result) => {
      if (!result.ok) {
        setError(apiErrorToKey(result.error))
        return
      }
      await onSuccess(result.value.redirectUrl)
    },
    onSettled: () => onTurnstileConsumedRef.current(),
  })

  // 用稳定的 mutate 引用;整对象进 deps 会使 Conditional UI effect 死循环打 challenge。
  const { mutate: verifyMutate } = verifyMutation

  const startConditional = useCallback(async (): Promise<void> => {
    if (!enabled) {
      setSupport('no')
      return
    }
    if (!('credentials' in navigator) || !('PublicKeyCredential' in window)) {
      setSupport('no')
      return
    }
    const available = await (
      PublicKeyCredential as { isConditionalMediationAvailable?: () => Promise<boolean> }
    ).isConditionalMediationAvailable?.()
    if (!available) {
      setSupport('no')
      return
    }
    // 探测只更新 support 揭示 tab,绝不自动切 active panel(防 CLS)。
    setSupport('yes')

    const normalizedIdentifier = identifier.trim()
    if (!normalizedIdentifier) return

    const challenge = await fetchChallenge(api, normalizedIdentifier, organizationId, flowFields)
    if (!challenge || challenge === 'organization_selection_required') return

    abortRef.current = new AbortController()
    setConditionalRunning(true)
    let credential: Credential | null
    try {
      credential = await navigator.credentials.get({
        signal: abortRef.current.signal,
        mediation: 'conditional',
        publicKey: {
          challenge: b64urlToBytes(challenge.challenge),
          userVerification: 'required',
          allowCredentials: [],
        },
      } as CredentialRequestOptions)
    } catch {
      // Conditional UI 静默失败不污染表单错误;显式错误只走按钮路径。
      setConditionalRunning(false)
      return
    }
    setConditionalRunning(false)
    if (!credential) return
    verifyMutate(
      assertionBody(
        credential as PublicKeyCredential,
        challenge,
        flowFields,
        turnstileTokenRef.current,
      ),
    )
  }, [api, flowFields, enabled, identifier, organizationId, verifyMutate])

  // 挂载只启动一次(ref 防重入);卸载 abort 独立 effect,避免依赖变化误 abort 在途选择器。
  const startedRef = useRef(false)
  useEffect(() => {
    if (!enabled) {
      setSupport('no')
      return
    }
    if (startedRef.current) return
    startedRef.current = true
    void startConditional()
  }, [enabled, startConditional])
  useEffect(() => () => abortRef.current?.abort(), [])

  const triggerButton = useCallback((): void => {
    if (!enabled) {
      setError('passkey_unavailable')
      return
    }
    if (!('credentials' in navigator)) {
      setError('passkey_unavailable')
      return
    }
    abortRef.current?.abort()
    setError(null)
    void (async () => {
      const normalizedIdentifier = identifier.trim()
      if (!normalizedIdentifier) {
        setError('auth_failed')
        return
      }
      const challenge = await fetchChallenge(api, normalizedIdentifier, organizationId, flowFields)
      if (challenge === 'organization_selection_required') {
        onOrganizationSelectionRequiredRef.current()
        return
      }
      if (!challenge) {
        setError('auth_failed')
        return
      }
      let credential: Credential | null
      try {
        credential = await navigator.credentials.get({
          mediation: 'optional',
          publicKey: {
            challenge: b64urlToBytes(challenge.challenge),
            userVerification: 'required',
            allowCredentials: [],
          },
        } as CredentialRequestOptions)
      } catch {
        setError('auth_failed')
        return
      }
      if (!credential) return
      verifyMutate(
        assertionBody(
          credential as PublicKeyCredential,
          challenge,
          flowFields,
          turnstileTokenRef.current,
        ),
      )
    })()
  }, [api, flowFields, enabled, identifier, organizationId, verifyMutate])

  return {
    support,
    conditionalRunning,
    isVerifying: verifyMutation.isPending,
    error,
    triggerButton,
  }
}
