import { Trans, useLingui } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'
import { size, text, weight } from '../../styles/scale.stylex'
import { Icon } from './Icon'
import { useCopyToClipboard } from './use-copy'

export type CopyButtonProps = {
  value: string
  // 被复制对象的名字,进入 aria-label:「Copy client secret」。
  subject: string
  appearance?: 'default' | 'onCode'
}

const styles = stylex.create({
  button: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '0.375rem',
    flexShrink: 0,
    minHeight: { default: '2rem', '@media (pointer: coarse)': size.touch },
    minWidth: { default: 'auto', '@media (pointer: coarse)': size.touch },
    paddingInline: '0.625rem',
    borderWidth: 0,
    borderRadius: tokens['--xid-radius-sm'],
    backgroundColor: { default: 'transparent', ':hover': tokens['--xid-muted'] },
    color: tokens['--xid-fg'],
    fontFamily: tokens['--xid-font'],
    fontSize: text.sm,
    fontWeight: weight.medium,
    cursor: 'pointer',
  },
  onCode: {
    color: tokens['--xid-code-foreground'],
    backgroundColor: {
      default: 'transparent',
      ':hover': `color-mix(in srgb, ${tokens['--xid-code-foreground']} 12%, transparent)`,
    },
  },
})

export function CopyButton({ value, subject, appearance = 'default' }: CopyButtonProps): ReactNode {
  const { t } = useLingui()
  const { status, copy } = useCopyToClipboard()
  return (
    <button
      type="button"
      aria-label={t`Copy ${subject}`}
      onClick={() => void copy(value)}
      {...stylex.props(styles.button, appearance === 'onCode' && styles.onCode)}
    >
      <Icon name={status === 'copied' ? 'check' : 'copy'} size={16} />
      <span aria-live="polite">
        {status === 'copied' ? (
          <Trans>Copied</Trans>
        ) : status === 'failed' ? (
          <Trans>Select and copy</Trans>
        ) : (
          <Trans>Copy</Trans>
        )}
      </span>
    </button>
  )
}
