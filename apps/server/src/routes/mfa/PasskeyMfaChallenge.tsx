import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Alert, Button, PageHeader } from '../../components/ui'
import { useAuth } from '../../lib/auth-context'
import { b64urlToBytes, bufferToB64url } from '../sign-in/passkey'
import type { ChallengeProps } from './CodeChallenges'
import { ChallengeExits } from './MfaExits'
import { styles } from './styles'
import { useMfaVerify } from './use-mfa-verify'

type PasskeyMfaOptions = {
  challenge: string
  rpId: string
  userVerification: UserVerificationRequirement
  timeout?: number
  allowCredentials: Array<{
    id: string
    type: PublicKeyCredentialType
    transports?: AuthenticatorTransport[]
  }>
}

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

export function PasskeyMfaChallenge({ isStepUp, methods }: ChallengeProps): ReactNode {
  const { t } = useLingui()
  const { api } = useAuth()
  const failedMessage = t`Passkey verification failed. Try another method or try again.`
  const verify = useMfaVerify({ method: 'passkey', invalidMessage: failedMessage })

  const [isRequesting, setIsRequesting] = useState(false)

  async function handleVerify(): Promise<void> {
    verify.setError(null)
    setIsRequesting(true)
    const optionsResult = await api.post<PasskeyMfaOptions>('/auth/mfa/passkey/options')
    const credential = optionsResult.ok ? await requestAssertion(optionsResult.value) : null
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
    <div {...stylex.props(styles.stack)}>
      <PageHeader
        title={<Trans>Passkey verification</Trans>}
        lead={
          <Trans>
            Use a registered passkey with device verification to complete two-factor authentication.
          </Trans>
        }
      />
      {verify.error ? <Alert tone="error">{verify.error}</Alert> : null}
      <Button
        variant="accent"
        fullWidth
        isLoading={isRequesting || verify.isPending}
        onClick={() => void handleVerify()}
      >
        <Trans>Use passkey</Trans>
      </Button>
      <ChallengeExits methods={methods} />
    </div>
  )
}
