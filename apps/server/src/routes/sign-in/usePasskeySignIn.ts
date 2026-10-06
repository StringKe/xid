// Passkey 登录:Conditional UI 与显式按钮两条路径,四验证在 server。
// tab 可见性只取决于浏览器是否支持 WebAuthn;Turnstile 只拦截提交,不拆除 passkey 入口。

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
  // 根入口尚未定位到组织时,challenge 需要先用标识符解析 RPID。
  identifierRequired: boolean
  identifier: string
  organizationId?: string | null
  flowFields: SignInFlowFields
  turnstileRequired: boolean
  turnstileToken: string | null
  onTurnstileConsumed: () => void
  onOrganizationSelectionRequired: () => void
  onSuccess: (redirectUrl: string | undefined) => Promise<void>
}

type ChallengeOutcome = ChallengeResponse | 'organization_selection_required' | null

// 服务端 challenge 有效期 7 分钟,提前换新以免用户久等后选择的凭据对应已过期的 challenge。
const CONDITIONAL_REFRESH_MS = 5 * 60 * 1000
const IDENTIFIER_DEBOUNCE_MS = 500

function browserSupportsWebAuthn(): boolean {
  return (
    typeof window !== 'undefined' &&
    'PublicKeyCredential' in window &&
    typeof navigator !== 'undefined' &&
    'credentials' in navigator
  )
}

async function conditionalMediationAvailable(): Promise<boolean> {
  const probe = (
    PublicKeyCredential as { isConditionalMediationAvailable?: () => Promise<boolean> }
  ).isConditionalMediationAvailable
  if (!probe) return false
  try {
    return await probe()
  } catch {
    return false
  }
}

function useDebouncedValue(value: string, delayMs: number): string {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])
  return debounced
}

async function fetchChallenge(
  api: ApiClient,
  input: { identifier: string; organizationId?: string | null; clientId?: string },
): Promise<ChallengeOutcome> {
  const result = await api.post<ChallengeResponse>('/auth/passkey/challenge', {
    ...(input.identifier ? { identifier: input.identifier } : {}),
    ...(input.organizationId ? { organizationId: input.organizationId } : {}),
    ...(input.clientId ? { clientId: input.clientId } : {}),
  })
  if (result.ok) return result.value
  return result.error.code === 'organization_selection_required' ? result.error.code : null
}

function assertionBody(
  credential: PublicKeyCredential,
  challenge: ChallengeResponse,
  extras: { flowFields: SignInFlowFields; turnstileToken: string | null },
): VerifyBody {
  const { flowFields, turnstileToken } = extras
  return {
    ...serializeAssertion(credential, challenge.sessionId),
    ...(challenge.organizationId ? { organizationId: challenge.organizationId } : {}),
    ...(flowFields.clientId ? { clientId: flowFields.clientId } : {}),
    ...(flowFields.continue ? { continue: flowFields.continue } : {}),
    ...(flowFields.intent ? { intent: flowFields.intent } : {}),
    ...(turnstileToken ? { turnstileToken } : {}),
  }
}

function requestOptions(challenge: ChallengeResponse): PublicKeyCredentialRequestOptions {
  return {
    challenge: b64urlToBytes(challenge.challenge),
    userVerification: 'required',
    allowCredentials: [],
  }
}

export function usePasskeySignIn(options: PasskeySignInOptions): PasskeySignIn {
  const { api, enabled, identifierRequired, organizationId, turnstileRequired } = options
  const [support, setSupport] = useState<PasskeySupport>('pending')
  const [conditionalAvailable, setConditionalAvailable] = useState(false)
  const [conditionalRunning, setConditionalRunning] = useState(false)
  const [generation, setGeneration] = useState(0)
  const [error, setError] = useState<SignInErrorKey | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  // Conditional UI 跨 render 等待选择,提交时读取最新的单次 Turnstile token 与流程参数。
  const latest = useRef(options)
  latest.current = options

  const identifier = useDebouncedValue(options.identifier.trim(), IDENTIFIER_DEBOUNCE_MS)
  const clientId = options.flowFields.clientId
  const turnstileReady = !turnstileRequired || options.turnstileToken !== null
  const restart = useCallback(() => setGeneration((value) => value + 1), [])

  const verifyMutation = useMutation({
    mutationFn: (body: VerifyBody) => api.post<VerifyResponse>('/auth/passkey/verify', body),
    onSuccess: async (result) => {
      if (!result.ok) {
        setError(apiErrorToKey(result.error))
        restart()
        return
      }
      await latest.current.onSuccess(result.value.redirectUrl)
    },
    onError: () => {
      setError('network_error')
      restart()
    },
    onSettled: () => latest.current.onTurnstileConsumed(),
  })
  const { mutate: verifyMutate } = verifyMutation

  const submitAssertion = useCallback(
    (credential: PublicKeyCredential, challenge: ChallengeResponse): void => {
      const { turnstileToken, flowFields } = latest.current
      if (turnstileRequired && !turnstileToken) {
        setError('captcha_required')
        restart()
        return
      }
      verifyMutate(assertionBody(credential, challenge, { flowFields, turnstileToken }))
    },
    [restart, turnstileRequired, verifyMutate],
  )

  useEffect(() => {
    if (!browserSupportsWebAuthn()) {
      setSupport('no')
      return
    }
    setSupport('yes')
    void conditionalMediationAvailable().then(setConditionalAvailable)
  }, [])

  const identifierReady = !identifierRequired || identifier.length > 0
  const canRunConditional = enabled && conditionalAvailable && identifierReady && turnstileReady

  useEffect(() => {
    if (!canRunConditional) return
    const controller = new AbortController()
    abortRef.current = controller
    const refreshTimer = setTimeout(() => {
      controller.abort()
      restart()
    }, CONDITIONAL_REFRESH_MS)

    void (async () => {
      const challenge = await fetchChallenge(api, { identifier, organizationId, clientId })
      if (!challenge || challenge === 'organization_selection_required') return
      if (controller.signal.aborted) return
      setConditionalRunning(true)
      let credential: Credential | null = null
      try {
        credential = await navigator.credentials.get({
          signal: controller.signal,
          mediation: 'conditional',
          publicKey: requestOptions(challenge),
        } as CredentialRequestOptions)
      } catch {
        // 被取消或中止时不污染表单错误,也不立即重启,避免浏览器连续拒绝时反复请求 challenge。
      } finally {
        setConditionalRunning(false)
      }
      clearTimeout(refreshTimer)
      if (controller.signal.aborted || !credential) return
      submitAssertion(credential as PublicKeyCredential, challenge)
    })()

    return () => {
      clearTimeout(refreshTimer)
      controller.abort()
    }
  }, [
    api,
    canRunConditional,
    clientId,
    generation,
    identifier,
    organizationId,
    restart,
    submitAssertion,
  ])

  const triggerButton = useCallback((): void => {
    if (!enabled || !browserSupportsWebAuthn()) {
      setError('passkey_unavailable')
      return
    }
    const currentIdentifier = latest.current.identifier.trim()
    if (identifierRequired && !currentIdentifier) {
      setError('identifier_required')
      return
    }
    abortRef.current?.abort()
    setError(null)
    void (async () => {
      const challenge = await fetchChallenge(api, {
        identifier: currentIdentifier,
        organizationId,
        clientId,
      })
      if (challenge === 'organization_selection_required') {
        latest.current.onOrganizationSelectionRequired()
        return
      }
      if (!challenge) {
        setError('auth_failed')
        restart()
        return
      }
      let credential: Credential | null = null
      try {
        credential = await navigator.credentials.get({
          mediation: 'optional',
          publicKey: requestOptions(challenge),
        } as CredentialRequestOptions)
      } catch {
        // 用户取消或超时(NotAllowedError)只回到可重试状态,不当作认证失败。
      }
      if (credential) submitAssertion(credential as PublicKeyCredential, challenge)
      else restart()
    })()
  }, [api, clientId, enabled, identifierRequired, organizationId, restart, submitAssertion])

  return {
    support,
    conditionalRunning,
    isVerifying: verifyMutation.isPending,
    error,
    triggerButton,
  }
}
