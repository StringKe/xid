import { Trans } from '@lingui/react/macro'
import type { FormEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'
import { Button, Field, Input } from '../../components/ui'
import type { BackupCodesResponse, TotpSetupResponse } from './hooks'

const styles = stylex.create({
  panel: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
    paddingBlock: '1.25rem',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  panelText: {
    margin: 0,
    fontSize: '0.875rem',
    color: tokens['--xid-muted-foreground'],
  },
  secretBox: {
    display: 'block',
    paddingBlock: '0.625rem',
    paddingInline: '0.75rem',
    borderRadius: tokens['--xid-radius'],
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: tokens['--xid-border'],
    backgroundColor: tokens['--xid-muted'],
    color: tokens['--xid-fg'],
    fontFamily: tokens['--xid-font-mono'],
    fontSize: '0.8125rem',
    overflowWrap: 'anywhere',
    maxWidth: '28rem',
  },
  fieldWrapper: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.375rem',
    maxWidth: '28rem',
    minWidth: 0,
  },
  actionGroup: {
    display: 'flex',
    gap: '0.375rem',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'flex-end',
    flexShrink: 0,
  },
  codeGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(8rem, 1fr))',
    gap: '0.5rem',
    margin: 0,
    padding: 0,
    listStyle: 'none',
    maxWidth: '28rem',
  },
  codeItem: {
    paddingBlock: '0.5rem',
    paddingInline: '0.75rem',
    borderRadius: tokens['--xid-radius'],
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: tokens['--xid-border'],
    backgroundColor: tokens['--xid-muted'],
    fontFamily: tokens['--xid-font-mono'],
    fontSize: '0.8125rem',
    fontVariantNumeric: 'tabular-nums',
    color: tokens['--xid-fg'],
  },
})

export type TotpSetupPanelProps = {
  setup: TotpSetupResponse
  code: string
  error: string | null
  isPending: boolean
  onCodeChange: (value: string) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  onCancel: () => void
}

export function TotpSetupPanel({
  setup,
  code,
  error,
  isPending,
  onCodeChange,
  onSubmit,
  onCancel,
}: TotpSetupPanelProps): ReactNode {
  return (
    <form onSubmit={onSubmit} {...stylex.props(styles.panel)}>
      <p {...stylex.props(styles.panelText)}>
        <Trans>Add this key to your authenticator app, then enter the 6-digit code.</Trans>
      </p>
      <code {...stylex.props(styles.secretBox)}>{setup.secret}</code>
      <a href={setup.otpauthUri}>
        <Trans>Open authenticator URI</Trans>
      </a>
      <div {...stylex.props(styles.fieldWrapper)}>
        <Field label={<Trans>Authenticator code</Trans>} required error={error ?? undefined}>
          <Input
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            value={code}
            onChange={(event) => onCodeChange(event.target.value)}
            required
          />
        </Field>
      </div>
      <div {...stylex.props(styles.actionGroup)}>
        <Button type="submit" variant="primary" isLoading={isPending}>
          <Trans>Verify</Trans>
        </Button>
        <Button variant="ghost" disabled={isPending} onClick={onCancel}>
          <Trans>Cancel</Trans>
        </Button>
      </div>
    </form>
  )
}

export type BackupCodesPanelProps = {
  backupCodes: BackupCodesResponse
}

export function BackupCodesPanel({ backupCodes }: BackupCodesPanelProps): ReactNode {
  return (
    <div {...stylex.props(styles.panel)}>
      <p {...stylex.props(styles.panelText)}>
        <Trans>Store these backup codes now. They will not be shown again.</Trans>
      </p>
      <ul {...stylex.props(styles.codeGrid)}>
        {backupCodes.codes.map((code) => (
          <li key={code} {...stylex.props(styles.codeItem)}>
            {code}
          </li>
        ))}
      </ul>
    </div>
  )
}
