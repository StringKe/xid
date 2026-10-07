// 第三步:生成并一次性展示备用码;激活时已签发 step-up,生成请求不会被重新验证拦下。

import { Trans, useLingui } from '@lingui/react/macro'
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { useApiErrorMessage } from '@xid-kit/web-ui/api-error-message'
import { Button } from '@xid-kit/web-ui/ui/Button'
import { Notice } from '@xid-kit/web-ui/ui/Notice'
import { Spinner } from '@xid-kit/web-ui/ui/Spinner'
import { AuthHeading } from '../../components/hosted/AuthHeading'
import { BackupCodesSheet } from '../../components/hosted/BackupCodesSheet'
import { hosted } from '../../components/hosted/hosted-styles'
import { page } from '../../styles/product-surface.stylex'
import { useGenerateBackupCodes } from '../account/queries'

export type BackupCodesStepProps = {
  organizationName: string | null
  onContinue: (codeCount: number) => void
}

export function BackupCodesStep({ organizationName, onContinue }: BackupCodesStepProps): ReactNode {
  const { t } = useLingui()
  const apiErrorMessage = useApiErrorMessage()
  const generate = useGenerateBackupCodes()
  const [saved, setSaved] = useState(false)
  const started = useRef(false)

  useEffect(() => {
    if (started.current) return
    started.current = true
    generate.mutate()
  }, [generate])

  const heading = organizationName
    ? t`Backup codes for ${organizationName}`
    : t`Backup codes for your account`
  const codes = generate.data?.codes ?? []

  return (
    <div {...stylex.props(hosted.screen)}>
      <AuthHeading
        eyebrow={<Trans>Step 3 of 3</Trans>}
        title={<Trans>Save your backup codes</Trans>}
        lead={
          <Trans>
            If you lose your phone, each code lets you sign in once. Keep them somewhere only you
            can reach, like a password manager.
          </Trans>
        }
      />
      {generate.isError ? (
        <Notice
          tone="danger"
          title={<Trans>Couldn't create backup codes</Trans>}
          action={
            <Button variant="secondary" onClick={() => generate.mutate()}>
              <Trans>Try again</Trans>
            </Button>
          }
        >
          {apiErrorMessage(generate.error, { surface: 'general' })}
        </Notice>
      ) : codes.length > 0 ? (
        <BackupCodesSheet codes={codes} heading={heading} saved={saved} onSavedChange={setSaved} />
      ) : (
        <div {...stylex.props(page.loadingCenter)}>
          <Spinner label={t`Creating your backup codes`} />
        </div>
      )}
      <div {...stylex.props(hosted.group)}>
        <Button
          variant="accent"
          size="lg"
          fullWidth
          disabled={!saved || codes.length === 0}
          onClick={() => onContinue(codes.length)}
        >
          <Trans>Continue</Trans>
        </Button>
        <p {...stylex.props(hosted.note)}>
          <Trans>
            You won't see these codes again. You can make a new set in your account, which turns
            these off.
          </Trans>
        </p>
      </div>
    </div>
  )
}
