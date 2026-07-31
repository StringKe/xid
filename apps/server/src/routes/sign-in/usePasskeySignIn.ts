// usePasskeySignIn:passkey 两条路径。
//   1. Conditional UI(mediation:'conditional'):挂载即静默启动,autofill 揭示已注册凭证。
//   2. 降级按钮(mediation:'optional'):显式点击触发选择器。
// 四验证在 server(challenge/origin/rpIdHash/signature,见 webauthn rule);此 hook 只编排浏览器调用。
// 能力探测(isConditionalMediationAvailable)未完成前 support='pending':SignInPage 据此保持稳定骨架,
// 探测完成揭示 passkey UI,不触发 layout shift。

import { useCallback, useEffect, useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import type { ApiClient } from '../../lib/api'
import { apiErrorToKey, type SignInErrorKey } from './shared'
import { b64urlToBytes, serializeAssertion } from './passkey'

type ChallengeResponse = { challenge: string; sessionId: string; organizationId?: string }
type VerifyResponse = { redirectUrl?: string }
type VerifyBody = ReturnType<typeof serializeAssertion> & {
  organizationId?: string
  clientId?: string
  turnstileToken?: string | null
}

export type PasskeySupport = 'pending' | 'yes' | 'no'

export type PasskeySignIn = {
  support: PasskeySupport
  // Conditional UI 选择器是否在等待用户选择(渐进揭示提示用)。
  conditionalRunning: boolean
  isVerifying: boolean
  error: SignInErrorKey | null
  // 降级按钮触发显式选择器。
  triggerButton: () => void
}

type PasskeySignInOptions = {
  api: ApiClient
  enabled: boolean
  identifier: string
  organizationId?: string | null
  applicationClientId?: string | null
  turnstileToken: string | null
  onTurnstileConsumed: () => void
  // 验证成功回调:接收 server 指定的 redirectUrl(可空),由调用方解析最终回跳。
  onSuccess: (redirectUrl: string | undefined) => Promise<void>
}

async function fetchChallenge(
  api: ApiClient,
  identifier: string,
  organizationId?: string | null,
  applicationClientId?: string | null,
): Promise<ChallengeResponse | null> {
  const result = await api.post<ChallengeResponse>('/auth/passkey/challenge', {
    identifier,
    ...(organizationId ? { organizationId } : {}),
    ...(applicationClientId ? { clientId: applicationClientId } : {}),
  })
  return result.ok ? result.value : null
}

function assertionBody(
  credential: PublicKeyCredential,
  challenge: ChallengeResponse,
  applicationClientId: string | null | undefined,
  turnstileToken: string | null,
): VerifyBody {
  return {
    ...serializeAssertion(credential, challenge.sessionId),
    ...(challenge.organizationId ? { organizationId: challenge.organizationId } : {}),
    ...(applicationClientId ? { clientId: applicationClientId } : {}),
    ...(turnstileToken ? { turnstileToken } : {}),
  }
}

export function usePasskeySignIn(options: PasskeySignInOptions): PasskeySignIn {
  const {
    api,
    enabled,
    identifier,
    organizationId,
    applicationClientId,
    turnstileToken,
    onTurnstileConsumed,
    onSuccess,
  } = options
  const [support, setSupport] = useState<PasskeySupport>('pending')
  const [conditionalRunning, setConditionalRunning] = useState(false)
  const [error, setError] = useState<SignInErrorKey | null>(null)
  // 取消正在进行的 conditional UI(组件卸载或切到按钮路径时)。
  const abortRef = useRef<AbortController | null>(null)
  // Conditional UI 可跨多次 render 等待用户选择,提交时必须读取最新的单次 Turnstile token。
  const turnstileTokenRef = useRef(turnstileToken)
  turnstileTokenRef.current = turnstileToken
  const onTurnstileConsumedRef = useRef(onTurnstileConsumed)
  onTurnstileConsumedRef.current = onTurnstileConsumed

  const verifyMutation = useMutation({
    mutationFn: (body: VerifyBody) => api.post<VerifyResponse>('/auth/passkey/verify', body),
    onSuccess: async (result) => {
      if (!result.ok) {
        setError(apiErrorToKey(result.error.code))
        return
      }
      await onSuccess(result.value.redirectUrl)
    },
    onSettled: () => onTurnstileConsumedRef.current(),
  })

  // mutate 引用在 TanStack Query 中跨渲染稳定;用它而非整个 verifyMutation 对象。
  // 后者每渲染换引用,进 useCallback/useEffect deps 会让 Conditional UI effect 无限重跑,
  // 猛打 /auth/passkey/challenge(死循环)。
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
    // 探测成功只更新 support state(揭示 passkey tab + conditional hint),
    // 不切 active panel:登录页 active 保持初始 'password',容器高度不变,绝不 layout shift。
    setSupport('yes')

    const normalizedIdentifier = identifier.trim()
    if (!normalizedIdentifier) return

    const challenge = await fetchChallenge(
      api,
      normalizedIdentifier,
      organizationId,
      applicationClientId,
    )
    if (!challenge) return

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
      // Conditional UI 静默(webauthn rule):用户未交互/无凭证/取消/关闭选择器都不报错,
      // 不污染表单错误态(否则登录页一挂载就显示 "Sign-in failed")。显式错误只走按钮路径。
      setConditionalRunning(false)
      return
    }
    setConditionalRunning(false)
    if (!credential) return
    verifyMutate(
      assertionBody(
        credential as PublicKeyCredential,
        challenge,
        applicationClientId,
        turnstileTokenRef.current,
      ),
    )
  }, [api, applicationClientId, enabled, identifier, organizationId, verifyMutate])

  // Conditional UI 仅挂载启动一次(startConditional 可能因依赖变化重建,用 ref 防重入 ->
  // 杜绝 effect 反复重跑猛打 challenge)。卸载 abort 拆到独立 effect,避免依赖变化时误 abort 在途选择器。
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
      const challenge = await fetchChallenge(
        api,
        normalizedIdentifier,
        organizationId,
        applicationClientId,
      )
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
          applicationClientId,
          turnstileTokenRef.current,
        ),
      )
    })()
  }, [api, applicationClientId, enabled, identifier, organizationId, verifyMutate])

  return {
    support,
    conditionalRunning,
    isVerifying: verifyMutation.isPending,
    error,
    triggerButton,
  }
}
