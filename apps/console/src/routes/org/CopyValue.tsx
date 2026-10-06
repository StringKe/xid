import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Button } from '@xid-kit/web-ui/ui'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'

const styles = stylex.create({
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    minWidth: 0,
  },
  value: {
    fontFamily: tokens['--xid-font-mono'],
    fontSize: '0.75rem',
    background: tokens['--xid-muted'],
    paddingBlock: '0.125rem',
    paddingInline: '0.375rem',
    borderRadius: tokens['--xid-radius-sm'],
    wordBreak: 'break-all',
  },
})

export function CopyValue({ value, label }: { value: string; label: string }): ReactNode {
  const { t } = useLingui()
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')

  function copy(): void {
    navigator.clipboard.writeText(value).then(
      () => setState('copied'),
      () => setState('failed'),
    )
  }

  return (
    <span {...stylex.props(styles.row)}>
      <code {...stylex.props(styles.value)}>{value}</code>
      <Button variant="ghost" onClick={copy} aria-label={t`Copy ${label}`}>
        {state === 'copied' ? (
          <Trans>Copied</Trans>
        ) : state === 'failed' ? (
          <Trans>Copy failed</Trans>
        ) : (
          <Trans>Copy</Trans>
        )}
      </Button>
    </span>
  )
}
