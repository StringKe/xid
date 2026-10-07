// 设备激活各屏:手动输入码、核对带码链接里的码、批准详情、完成 / 拒绝 / 无法激活。

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Button, Notice } from '../../components/ui'
import { AuthHeading } from '../../components/hosted/AuthHeading'
import { CodeField, useCodeFormatMessage } from '../../components/hosted/CodeField'
import {
  codeFormatIssue,
  formatDeviceCode,
  normalizeCode,
} from '../../components/hosted/code-input'
import { hosted } from '../../components/hosted/hosted-styles'
import { RequestCard } from '../../components/hosted/RequestCard'
import { text } from '@xid-kit/web-ui/styles/scale.stylex'
import { tokens } from '../../styles/tokens.stylex'

export type DeviceActivationParams = {
  userCode: string
  clientId: string
  clientName: string
  clientLogoUrl: string | null
  scopes: string[]
  expiresAt: string
  firstParty: boolean
}

const styles = stylex.create({
  codeBox: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '0.5rem',
    paddingBlock: '1.25rem',
    paddingInline: '1rem',
    borderRadius: tokens['--xid-radius-lg'],
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: tokens['--xid-border'],
    backgroundColor: tokens['--xid-sidebar'],
  },
  code: {
    fontFamily: tokens['--xid-font-mono'],
    fontSize: text.xl,
    letterSpacing: '0.18em',
    color: tokens['--xid-fg'],
  },
})

export function minutesUntil(iso: string, now: number): number {
  return Math.max(0, Math.ceil((Date.parse(iso) - now) / 60_000))
}

export function CodeEntryStep(props: {
  above: ReactNode
  initialCode: string
  error: string | null
  isLoading: boolean
  onSubmit: (code: string) => void
}): ReactNode {
  const formatMessage = useCodeFormatMessage()
  const [code, setCode] = useState(props.initialCode)
  const [formatError, setFormatError] = useState<string | null>(null)
  const host = typeof window === 'undefined' ? '' : `${window.location.host}/activate`

  function submit(raw: string): void {
    const issue = codeFormatIssue(raw, { length: 8, charset: 'device' })
    if (issue) {
      setFormatError(formatMessage(issue, { length: 8, actual: raw, charset: 'device' }))
      return
    }
    setFormatError(null)
    props.onSubmit(normalizeCode(raw, 'device'))
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    submit(code)
  }

  return (
    <div {...stylex.props(hosted.screen)}>
      <AuthHeading
        above={props.above}
        title={<Trans>Enter the code shown on your device</Trans>}
        lead={<Trans>It's on the sign-in screen of the device you're setting up.</Trans>}
      />
      <form noValidate onSubmit={handleSubmit} {...stylex.props(hosted.form)}>
        <CodeField
          label={<Trans>Device code</Trans>}
          value={code}
          onValueChange={(value) => {
            setFormatError(null)
            setCode(value)
          }}
          length={8}
          charset="device"
          oneTimeCode={false}
          hint={
            <Trans>
              8 letters, never vowels. Upper or lower case, spaces and dashes are all fine.
            </Trans>
          }
          error={formatError ?? props.error ?? undefined}
          autoFocus
        />
        <Button type="submit" variant="accent" size="lg" fullWidth isLoading={props.isLoading}>
          <Trans>Continue</Trans>
        </Button>
      </form>
      <p {...stylex.props(hosted.note)}>
        <Trans>
          Started this on a TV or tablet? Open {host} on your phone and enter the code there.
        </Trans>
      </p>
    </div>
  )
}

export function CheckCodeStep(props: {
  above: ReactNode
  params: DeviceActivationParams
  now: number
  onMatch: () => void
  onMismatch: () => void
  isSubmitting: boolean
}): ReactNode {
  const minutes = minutesUntil(props.params.expiresAt, props.now)
  const app = props.params.clientName
  return (
    <div {...stylex.props(hosted.screen)}>
      <AuthHeading
        above={props.above}
        title={<Trans>Check the code on your device</Trans>}
        lead={<Trans>Does {app} show this exact code?</Trans>}
      />
      <div {...stylex.props(styles.codeBox)}>
        <span {...stylex.props(styles.code)}>{formatDeviceCode(props.params.userCode)}</span>
        <span {...stylex.props(hosted.note)}>
          <Trans>The code expires in {minutes} minutes.</Trans>
        </span>
      </div>
      <div {...stylex.props(hosted.actions)}>
        <Button variant="accent" size="lg" fullWidth onClick={props.onMatch}>
          <Trans>Yes, it matches</Trans>
        </Button>
        <Button
          variant="secondary"
          size="lg"
          fullWidth
          isLoading={props.isSubmitting}
          onClick={props.onMismatch}
        >
          <Trans>No, it's different</Trans>
        </Button>
      </div>
      <p {...stylex.props(hosted.note)}>
        <Trans>
          If you didn't start this on a device in front of you, choose No. Someone may have sent you
          this link.
        </Trans>
      </p>
    </div>
  )
}

export function ApproveDeviceStep(props: {
  above: ReactNode
  params: DeviceActivationParams
  isSubmitting: boolean
  submitError: string | null
  onDecide: (approved: boolean) => void
}): ReactNode {
  const { params } = props
  const app = params.clientName
  const code = formatDeviceCode(params.userCode)
  return (
    <div {...stylex.props(hosted.screen)}>
      <AuthHeading
        above={props.above}
        title={<Trans>Let {app} sign in as you?</Trans>}
        lead={<Trans>Code {code} matched. Here's what this device will get.</Trans>}
      />
      <RequestCard
        clientName={app}
        clientId={params.clientId}
        firstParty={params.firstParty}
        scopes={params.scopes}
        heading={<Trans>This device will be able to</Trans>}
        footer={<Trans>Only allow it if you're holding that device right now.</Trans>}
      />
      {props.submitError ? <Notice tone="danger">{props.submitError}</Notice> : null}
      <div {...stylex.props(hosted.actions)}>
        <Button
          variant="accent"
          size="lg"
          fullWidth
          isLoading={props.isSubmitting}
          onClick={() => props.onDecide(true)}
        >
          <Trans>Allow</Trans>
        </Button>
        <Button
          variant="secondary"
          size="lg"
          fullWidth
          disabled={props.isSubmitting}
          onClick={() => props.onDecide(false)}
        >
          <Trans>Deny</Trans>
        </Button>
      </div>
    </div>
  )
}

export function DeviceResultStep(props: {
  above: ReactNode
  app: string
  outcome: 'allowed' | 'denied'
  organizationName: string | null
}): ReactNode {
  const { app, organizationName: org } = props
  if (props.outcome === 'allowed') {
    return (
      <div {...stylex.props(hosted.screen)} aria-live="polite">
        <AuthHeading
          above={props.above}
          title={<Trans>{app} is signed in</Trans>}
          lead={
            <Trans>
              Go back to your device. It will finish on its own. You can close this tab.
            </Trans>
          }
        />
        <p {...stylex.props(hosted.note)}>
          {org ? (
            <Trans>If you didn't expect this request, let your {org} admin know.</Trans>
          ) : (
            <Trans>If you didn't expect this request, let your admin know.</Trans>
          )}
        </p>
      </div>
    )
  }
  return (
    <div {...stylex.props(hosted.screen)} aria-live="polite">
      <AuthHeading
        above={props.above}
        title={<Trans>{app} wasn't connected</Trans>}
        lead={
          <Trans>
            The device will show that you said no. Nothing from your account was shared.
          </Trans>
        }
      />
      <p {...stylex.props(hosted.note)}>
        {org ? (
          <Trans>If you didn't expect this request, let your {org} admin know.</Trans>
        ) : (
          <Trans>If you didn't expect this request, let your admin know.</Trans>
        )}
      </p>
    </div>
  )
}

export function DeviceFailedStep(props: {
  above: ReactNode
  message: string
  onRetry: () => void
}): ReactNode {
  const { t } = useLingui()
  return (
    <div {...stylex.props(hosted.screen)}>
      <AuthHeading above={props.above} title={t`This code no longer works`} lead={props.message} />
      <Button variant="accent" size="lg" fullWidth onClick={props.onRetry}>
        <Trans>Enter a new code</Trans>
      </Button>
    </div>
  )
}
