// 验证器绑定:进入即申请密钥,二维码与可复制的手动密钥并排,验证 6 位码后激活。

import { Trans, useLingui } from '@lingui/react/macro'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import type { XidError } from '@xid-kit/types'
import { renderSVG } from 'uqr'
import { Button } from '@xid-kit/web-ui/ui/Button'
import { CopyButton } from '@xid-kit/web-ui/ui/CopyButton'
import { Notice } from '@xid-kit/web-ui/ui/Notice'
import { Spinner } from '@xid-kit/web-ui/ui/Spinner'
import { text } from '@xid-kit/web-ui/styles/scale.stylex'
import { useApiErrorMessage } from '@xid-kit/web-ui/api-error-message'
import { AuthHeading } from '../../components/hosted/AuthHeading'
import { CodeField, useCodeFormatMessage } from '../../components/hosted/CodeField'
import { codeFormatIssue, normalizeCode } from '../../components/hosted/code-input'
import { hosted } from '../../components/hosted/hosted-styles'
import { tokens } from '../../styles/tokens.stylex'
import { useStartTotpSetup, useVerifyTotpSetup } from '../account/queries'
import type { TotpSetupResponse } from '../account/types'
import { groupSecret, otpauthDisplayName } from './setup-steps'

const styles = stylex.create({
  pairing: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '1.25rem',
    padding: '1.25rem',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: tokens['--xid-border'],
    borderRadius: tokens['--xid-radius-lg'],
  },
  qr: {
    display: 'block',
    flexShrink: 0,
    width: '7.5rem',
    height: '7.5rem',
    padding: '0.25rem',
    borderRadius: tokens['--xid-radius-sm'],
    backgroundColor: '#ffffff',
  },
  manual: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: '0.5rem',
    flexGrow: 1,
    flexBasis: '10rem',
    minWidth: 0,
  },
  secret: {
    margin: 0,
    fontFamily: tokens['--xid-font-mono'],
    fontSize: text.sm,
    lineHeight: '1.25rem',
    color: tokens['--xid-fg'],
    overflowWrap: 'anywhere',
  },
  center: {
    display: 'flex',
    justifyContent: 'center',
    paddingBlock: '2rem',
  },
})

const CODE_REJECTIONS: ReadonlySet<string> = new Set([
  'mfa_invalid',
  'invalid_credentials',
  'validation_failed',
])

function qrDataUrl(uri: string): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(renderSVG(uri, { border: 0 }))}`
}

function PairingPanel({ setup }: { setup: TotpSetupResponse }): ReactNode {
  const { t } = useLingui()
  const qr = useMemo(() => qrDataUrl(setup.otpauthUri), [setup.otpauthUri])
  return (
    <div {...stylex.props(styles.pairing)}>
      <img
        src={qr}
        alt={t`QR code to add this account to your authenticator app`}
        {...stylex.props(styles.qr)}
      />
      <div {...stylex.props(styles.manual)}>
        <p {...stylex.props(hosted.note)}>
          <Trans>Can't scan? Enter this key instead.</Trans>
        </p>
        <code {...stylex.props(styles.secret)}>{groupSecret(setup.secret)}</code>
        <CopyButton value={setup.secret} subject={t`setup key`} />
      </div>
    </div>
  )
}

export type TotpSetupStepProps = {
  onActivated: () => void
  alternative: ReactNode
}

export function TotpSetupStep(props: TotpSetupStepProps): ReactNode {
  const { t } = useLingui()
  const apiErrorMessage = useApiErrorMessage()
  const formatMessage = useCodeFormatMessage()
  const start = useStartTotpSetup()
  const verify = useVerifyTotpSetup()
  const [setup, setSetup] = useState<TotpSetupResponse | null>(null)
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const started = useRef(false)

  useEffect(() => {
    if (started.current) return
    started.current = true
    start.mutate(undefined, { onSuccess: setSetup })
  }, [start])

  async function submit(value: string): Promise<void> {
    if (!setup || verify.isPending) return
    const issue = codeFormatIssue(value, { length: 6, charset: 'numeric' })
    if (issue) {
      setError(formatMessage(issue, { length: 6, actual: value, charset: 'numeric' }))
      return
    }
    setError(null)
    try {
      await verify.mutateAsync({ factorId: setup.factorId, code: normalizeCode(value, 'numeric') })
      props.onActivated()
    } catch (cause) {
      const failure = cause as XidError
      setError(
        CODE_REJECTIONS.has(failure.code)
          ? t`That code didn't work. Enter the code your app shows now.`
          : apiErrorMessage(failure, { surface: 'general' }),
      )
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    void submit(code)
  }

  const display = setup ? otpauthDisplayName(setup.otpauthUri) : null
  const issuerName = display?.issuer
  const accountName = display?.account
  return (
    <div {...stylex.props(hosted.screen)}>
      <AuthHeading
        eyebrow={<Trans>Step 2 of 3</Trans>}
        title={<Trans>Scan this code with your authenticator app</Trans>}
        lead={
          display ? (
            <Trans>
              In the app, add an account and point your camera at the code. It will appear as{' '}
              {issuerName} ({accountName}).
            </Trans>
          ) : (
            <Trans>In the app, add an account and point your camera at the code.</Trans>
          )
        }
      />
      {start.isError ? (
        <Notice tone="danger" title={<Trans>Couldn't start setup</Trans>}>
          {apiErrorMessage(start.error, { surface: 'general' })}
        </Notice>
      ) : setup ? (
        <PairingPanel setup={setup} />
      ) : (
        <div {...stylex.props(styles.center)}>
          <Spinner label={t`Preparing your setup key`} />
        </div>
      )}
      <form onSubmit={handleSubmit} {...stylex.props(hosted.form)}>
        <CodeField
          label={<Trans>Enter the 6-digit code the app shows</Trans>}
          value={code}
          onValueChange={setCode}
          onComplete={(value) => void submit(value)}
          length={6}
          error={error ?? undefined}
          disabled={!setup}
        />
        <Button type="submit" variant="accent" size="lg" fullWidth isLoading={verify.isPending}>
          <Trans>Verify and continue</Trans>
        </Button>
      </form>
      {props.alternative}
    </div>
  )
}
