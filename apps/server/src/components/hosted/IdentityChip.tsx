// 标识回显:登录前只回显用户自己输入的值(带 Change);登录后显示当前账户(首字母 + 邮箱)。

import { Trans, useLingui } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { size, text, weight } from '@xid-kit/web-ui/styles/scale.stylex'
import { tokens } from '../../styles/tokens.stylex'

const styles = stylex.create({
  identifier: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.75rem',
    maxWidth: '100%',
    minHeight: '2rem',
    paddingInlineStart: '0.75rem',
    paddingInlineEnd: '0.25rem',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: tokens['--xid-border-strong'],
    borderRadius: tokens['--xid-radius'],
    fontSize: text.sm,
    lineHeight: '1rem',
    color: tokens['--xid-fg'],
  },
  value: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  change: {
    flexShrink: 0,
    minHeight: { default: '1.75rem', '@media (pointer: coarse)': size.touch },
    paddingInline: '0.5rem',
    borderWidth: 0,
    borderRadius: tokens['--xid-radius-sm'],
    backgroundColor: { default: 'transparent', ':hover': tokens['--xid-accent-wash'] },
    color: tokens['--xid-accent'],
    fontFamily: tokens['--xid-font'],
    fontSize: text.sm,
    fontWeight: weight.medium,
    cursor: 'pointer',
  },
  account: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.5rem',
    maxWidth: '100%',
    minHeight: '2rem',
    paddingInlineStart: '0.25rem',
    paddingInlineEnd: '0.75rem',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: tokens['--xid-border'],
    borderRadius: tokens['--xid-radius-full'],
    fontSize: text.sm,
    lineHeight: '1rem',
    color: tokens['--xid-fg'],
  },
  initials: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    width: '1.5rem',
    height: '1.5rem',
    borderRadius: tokens['--xid-radius-full'],
    backgroundColor: tokens['--xid-muted'],
    color: tokens['--xid-muted-foreground'],
    fontSize: '0.6875rem',
    fontWeight: 600,
  },
})

export function IdentifierChip({
  value,
  onChange,
}: {
  value: string
  onChange: () => void
}): ReactNode {
  const { t } = useLingui()
  return (
    <span {...stylex.props(styles.identifier)}>
      <span {...stylex.props(styles.value)}>{value}</span>
      <button
        type="button"
        onClick={onChange}
        aria-label={t`Change ${value}`}
        {...stylex.props(styles.change)}
      >
        <Trans>Change</Trans>
      </button>
    </span>
  )
}

export function initialsOf(label: string): string {
  const words = label
    .split(/[\s@._-]+/)
    .map((word) => word.trim())
    .filter(Boolean)
  const letters = words.slice(0, 2).map((word) => Array.from(word)[0] ?? '')
  return letters.join('').toUpperCase()
}

export function AccountChip({ label }: { label: string }): ReactNode {
  return (
    <span {...stylex.props(styles.account)}>
      <span aria-hidden="true" {...stylex.props(styles.initials)}>
        {initialsOf(label)}
      </span>
      <span {...stylex.props(styles.value)}>{label}</span>
    </span>
  )
}
