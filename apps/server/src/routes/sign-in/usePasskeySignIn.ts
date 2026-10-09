// Passkey 登录:Conditional UI 与显式按钮两条路径,四验证在 server。
// tab 可见性只取决于浏览器是否支持 WebAuthn;Turnstile 只拦截提交,不拆除 passkey 入口。
// 多租户根域上,组织的 passkey 只属于其子域:challenge 返回 ceremony 时带着登录流程参数跳到子域完成,
// 子域验签后服务端返回一次性交接表单,浏览器 POST 回根域续跑 /authorize。

import { useCallback, useEffect, useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import type { ApiClient } from '../../lib/api'
import { apiErrorToKey, type SignInErrorKey } from './shared'
import { b64urlToBytes, browserSupportsWebAuthn, serializeAssertion } from './passkey'
import type { SignInFlowFields } from './sign-in-flow'

type ChallengeResponse = { challenge: string; sessionId: string; organizationId?: string }
type CeremonyResponse = { ceremony: { origin: string; state: string }; organizationId: string }
type HandoffForm = { action: string; method: 'POST'; fields: Record<string, string> }
type VerifyResponse = { redirectUrl?: string; handoff?: HandoffForm }
type VerifyBody = ReturnType<typeof serializeAssertion> & {
  organizationId?: string
  clientId?: string
  continue?: string
  intent?: string
  turnstileToken?: string | null
  handoffState?: string
}

const HANDOFF_STATE_PARAM = 'handoff_state'
const PASSKEY_PARAM = 'passkey'

function currentSearchParam(name: string): string | null {
  if (typeof window === 'undefined') return null
  return new URLSearchParams(window.location.search).get(name)
}

// 把当前登录页的流程参数原样带到组织子域的登录页,并附上根域 state 与要直接走 passkey 的标记。
function continueOnCeremonyHost(ceremony: CeremonyResponse): void {
  const params = new URLSearchParams(window.location.search)
  params.set(HANDOFF_STATE_PARAM, ceremony.ceremony.state)
  params.set('organization_id', ceremony.organizationId)
  params.set(PASSKEY_PARAM, '1')
  window.location.assign(`${ceremony.ceremony.origin}/sign-in?${params.toString()}`)
}

function submitHandoff(form: HandoffForm): void {
  const element = document.createElement('form')
  element.method = form.method
  element.action = form.action
  for (const [name, value] of Object.entries(form.fields)) {
    const input = document.createElement('input')
    input.type = 'hidden'
    input.name = name
    input.value = value
    element.appendChild(input)
  }
  document.body.appendChild(element)
  element.submit()
}

export type PasskeySupport = 'pending' | 'yes' | 'no'

export type PasskeySignIn = {
  support: PasskeySupport
  // 浏览器支持 Conditional UI 时 passkey 从标识符输入框的 autofill 出现,不再显示单独按钮。
  conditionalAvailable: boolean
  conditionalRunning: boolean
  isVerifying: boolean
  error: SignInErrorKey | null
  triggerButton: () => void
}

type PasskeySignInOptions = {
  api: ApiClient
  enabled: boolean
  // Conditional UI 只挂在标识符输入框上;离开第一步后只保留显式按钮。
  conditionalEnabled: boolean
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

type ChallengeOutcome =
  | ChallengeResponse
  | CeremonyResponse
  | 'organization_selection_required'
  | null

function isCeremony(outcome: ChallengeOutcome): outcome is CeremonyResponse {
  return typeof outcome === 'object' && outcome !== null && 'ceremony' in outcome
}

// 服务端 challenge 有效期 7 分钟,提前换新以免用户久等后选择的凭据对应已过期的 challenge。
const CONDITIONAL_REFRESH_MS = 5 * 60 * 1000
const IDENTIFIER_DEBOUNCE_MS = 500

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
  const result = await api.post<ChallengeResponse | CeremonyResponse>('/auth/passkey/challenge', {
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
  const handoffState = currentSearchParam(HANDOFF_STATE_PARAM)
  return {
    ...serializeAssertion(credential, challenge.sessionId),
    ...(challenge.organizationId ? { organizationId: challenge.organizationId } : {}),
    ...(flowFields.clientId ? { clientId: flowFields.clientId } : {}),
    ...(flowFields.continue ? { continue: flowFields.continue } : {}),
    ...(flowFields.intent ? { intent: flowFields.intent } : {}),
    ...(turnstileToken ? { turnstileToken } : {}),
    ...(handoffState ? { handoffState } : {}),
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

  // 已定位组织时标识符不参与 challenge,输入变化不能打断浏览器的 passkey 建议。
  const debouncedIdentifier = useDebouncedValue(options.identifier.trim(), IDENTIFIER_DEBOUNCE_MS)
  const identifier = identifierRequired ? debouncedIdentifier : ''
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
      if (result.value.handoff) {
        submitHandoff(result.value.handoff)
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
  const canRunConditional =
    enabled &&
    options.conditionalEnabled &&
    conditionalAvailable &&
    identifierReady &&
    turnstileReady

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
      // 需要换到组织子域时只在用户主动点按钮后跳转,自动填充建议不触发页面跳转。
      if (!challenge || challenge === 'organization_selection_required' || isCeremony(challenge)) {
        return
      }
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
      if (isCeremony(challenge)) {
        continueOnCeremonyHost(challenge)
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

  // 从根域跳来时直接发起一次;浏览器要求用户手势而拒绝时,按钮仍在,用户再点一次即可。
  const autoStarted = useRef(false)
  useEffect(() => {
    if (autoStarted.current || support !== 'yes' || !enabled || !turnstileReady) return
    if (currentSearchParam(PASSKEY_PARAM) !== '1') return
    autoStarted.current = true
    triggerButton()
  }, [enabled, support, triggerButton, turnstileReady])

  return {
    support,
    conditionalAvailable,
    conditionalRunning,
    isVerifying: verifyMutation.isPending,
    error,
    triggerButton,
  }
}
