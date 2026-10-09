import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Button, Icon, Notice } from '../../components/ui'
import { AuthHeading } from '../../components/hosted/AuthHeading'
import { hosted } from '../../components/hosted/hosted-styles'
import { useAuth } from '../../lib/auth-context'
import { b64urlToBytes, bufferToB64url } from '../sign-in/passkey'
import type { ChallengeProps } from './CodeChallenges'
import { ChallengeExits } from './MfaExits'
import { useMfaVerify } from './use-mfa-verify'

type PasskeyMfaOptions = {
  challenge: string
  rpId: string
  userVerification: UserVerificationRequirement
  timeout?: number
  // 账户里还有早期在实例主域登记的 passkey,可以单独发起一次
  earlierAvailable?: boolean
  allowCredentials: Array<{
    id: string
    type: PublicKeyCredentialType
    transports?: AuthenticatorTransport[]
  }>
}

// passkey 只能在组织自己的地址使用:服务端要求换主机时带着当前会话整页跳过去,回来后续跑原流程。
type CeremonyHandoff = { handoff: { url: string } }

async function requestAssertion(options: PasskeyMfaOptions): Promise<PublicKeyCredential | null> {
  try {
    return (await navigator.credentials.get({
      publicKey: {
        challenge: b64urlToBytes(options.challenge),
        rpId: options.rpId,
        userVerification: options.userVerification,
        timeout: options.timeout,
        allowCredentials: options.allowCredentials.map((cred) => ({
          ...cred,
          id: b64urlToBytes(cred.id),
        })),
      },
    })) as PublicKeyCredential | null
  } catch {
    // 用户取消或超时(NotAllowedError)与认证器不可用同样回到可重试状态。
    return null
  }
}

export function PasskeyMfaChallenge({ isStepUp, methods, above }: ChallengeProps): ReactNode {
  const { t } = useLingui()
  const { api } = useAuth()
  const failedMessage = t`Passkey verification failed. Try another method or try again.`
  const verify = useMfaVerify({ method: 'passkey', invalidMessage: failedMessage })

  const [isRequesting, setIsRequesting] = useState(false)
  const [earlierAvailable, setEarlierAvailable] = useState(false)

  async function handleVerify(mode: { earlier: boolean }): Promise<void> {
    verify.setError(null)
    setIsRequesting(true)
    const optionsResult = await api.post<PasskeyMfaOptions | CeremonyHandoff>(
      '/auth/mfa/passkey/options',
      {
        continue: `${window.location.pathname}${window.location.search}`,
        ...(mode.earlier ? { earlier: true } : {}),
      },
    )
    const options = optionsResult.ok ? optionsResult.value : null
    if (options && 'handoff' in options) {
      window.location.assign(options.handoff.url)
      return
    }
    if (options) setEarlierAvailable(options.earlierAvailable === true)
    const credential = options ? await requestAssertion(options) : null
    setIsRequesting(false)
    if (!credential) {
      verify.setError(failedMessage)
      return
    }
    const response = credential.response as AuthenticatorAssertionResponse
    await verify.submit({
      path: '/auth/mfa/passkey/verify',
      body: {
        id: credential.id,
        rawId: bufferToB64url(credential.rawId),
        response: {
          clientDataJSON: bufferToB64url(response.clientDataJSON),
          authenticatorData: bufferToB64url(response.authenticatorData),
          signature: bufferToB64url(response.signature),
          userHandle: response.userHandle ? bufferToB64url(response.userHandle) : null,
        },
        type: credential.type,
        stepUp: isStepUp,
      },
    })
  }

  return (
    <div {...stylex.props(hosted.screen)}>
      <AuthHeading
        above={above}
        title={isStepUp ? <Trans>Confirm it's you</Trans> : <Trans>Verify with your passkey</Trans>}
        lead={
          <Trans>
            Use your fingerprint, face or screen lock, the same way you unlock your device.
          </Trans>
        }
      />
      {verify.error ? <Notice tone="danger">{verify.error}</Notice> : null}
      <Button
        variant="accent"
        size="lg"
        fullWidth
        isLoading={isRequesting || verify.isPending}
        onClick={() => void handleVerify({ earlier: false })}
      >
        <Icon name="passkey" size={18} />
        <Trans>Use passkey</Trans>
      </Button>
      {earlierAvailable ? (
        <Button
          variant="secondary"
          size="lg"
          fullWidth
          isLoading={isRequesting || verify.isPending}
          onClick={() => void handleVerify({ earlier: true })}
        >
          <Trans>Use a passkey created on an earlier address</Trans>
        </Button>
      ) : null}
      {isStepUp ? (
        <p {...stylex.props(hosted.note)}>
          <Trans>Text message codes can't be used to confirm changes like this.</Trans>
        </p>
      ) : null}
      <ChallengeExits methods={methods} isStepUp={isStepUp} />
    </div>
  )
}
