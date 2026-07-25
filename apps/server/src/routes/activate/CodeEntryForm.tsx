import { Trans } from '@lingui/react/macro'
import type { FormEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Button, Field, Input, PageHeader } from '../../components/ui'
import { tokens } from '../../styles/tokens.stylex'

const styles = stylex.create({
  panel: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
  },
  // device code 输入:mono + tabular-nums,视觉对齐 OTP 输入密度。
  codeInputWrap: {
    fontVariantNumeric: 'tabular-nums',
    fontFamily: tokens['--xid-font-mono'],
    letterSpacing: '0.06em',
  },
})

export type CodeEntryFormProps = {
  value: string
  onChange: (value: string) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  error: string | null
}

export function CodeEntryForm({ value, onChange, onSubmit, error }: CodeEntryFormProps): ReactNode {
  return (
    <form {...stylex.props(styles.panel)} onSubmit={onSubmit}>
      <PageHeader
        title={<Trans>Activate a device</Trans>}
        lead={<Trans>Enter the code shown on your device.</Trans>}
      />
      <div {...stylex.props(styles.codeInputWrap)}>
        <Field label={<Trans>Device code</Trans>} error={error} required>
          <Input
            value={value}
            autoComplete="one-time-code"
            inputMode="text"
            onChange={(event) => onChange(event.currentTarget.value)}
          />
        </Field>
      </div>
      <Button type="submit" variant="secondary" fullWidth disabled={!value.trim()}>
        <Trans>Find request</Trans>
      </Button>
    </form>
  )
}
