// passkey 作为第二步:调起系统创建窗口;用户取消或浏览器拒绝时留在本步,可重试或换验证器。

import { Trans } from '@lingui/react/macro'
import { useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Button } from '@xid-kit/web-ui/ui/Button'
import { Notice } from '@xid-kit/web-ui/ui/Notice'
import { AuthHeading } from '../../components/hosted/AuthHeading'
import { hosted } from '../../components/hosted/hosted-styles'
import { useRegisterPasskey } from '../account/queries'
import { useDefaultPasskeyName } from '../../components/hosted/passkey-name'

export type PasskeySetupStepProps = {
  onRegistered: () => void
  alternative: ReactNode
}

export function PasskeySetupStep({ onRegistered, alternative }: PasskeySetupStepProps): ReactNode {
  const register = useRegisterPasskey()
  const deviceName = useDefaultPasskeyName()
  const [failed, setFailed] = useState(false)

  async function create(): Promise<void> {
    setFailed(false)
    try {
      await register.mutateAsync({ deviceName })
      onRegistered()
    } catch {
      setFailed(true)
    }
  }

  return (
    <div {...stylex.props(hosted.screen)}>
      <AuthHeading
        eyebrow={<Trans>Step 2 of 3</Trans>}
        title={<Trans>Create a passkey</Trans>}
        lead={
          <Trans>
            Your device will ask for your face, fingerprint or screen lock. The passkey stays on
            this device or in your password manager.
          </Trans>
        }
      />
      {failed ? (
        <Notice tone="warning" title={<Trans>Passkey not created</Trans>}>
          <Trans>
            The prompt closed before it finished, so nothing was saved. Try again, or set up an
            authenticator app instead.
          </Trans>
        </Notice>
      ) : null}
      <div {...stylex.props(hosted.group)}>
        <Button
          variant="accent"
          size="lg"
          fullWidth
          isLoading={register.isPending}
          onClick={() => void create()}
        >
          {failed ? <Trans>Try again</Trans> : <Trans>Create a passkey</Trans>}
        </Button>
      </div>
      {alternative}
    </div>
  )
}
