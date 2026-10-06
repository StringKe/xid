// 状态徽标一律带文字,点只是第二信号;outline 是不带状态色的中性标签(This device、Primary)。

import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'
import { text, weight } from '../../styles/scale.stylex'

export const BADGE_TONES = ['neutral', 'success', 'warning', 'danger', 'info'] as const
export type BadgeTone = (typeof BADGE_TONES)[number]

export type BadgeProps = {
  tone?: BadgeTone
  variant?: 'status' | 'outline'
  children: ReactNode
}

const styles = stylex.create({
  base: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.375rem',
    minHeight: '1.375rem',
    paddingInline: '0.5rem',
    borderRadius: tokens['--xid-radius-full'],
    fontFamily: tokens['--xid-font'],
    fontSize: text.xs,
    fontWeight: weight.medium,
    lineHeight: '1rem',
    letterSpacing: tokens['--xid-tracking-small'],
    whiteSpace: 'nowrap',
    fontVariantNumeric: 'tabular-nums',
  },
  outline: {
    color: tokens['--xid-fg'],
    boxShadow: `inset 0 0 0 1px ${tokens['--xid-border-strong']}`,
  },
  neutral: { color: tokens['--xid-muted-foreground'], backgroundColor: tokens['--xid-muted'] },
  success: { color: tokens['--xid-success'], backgroundColor: tokens['--xid-success-bg'] },
  warning: { color: tokens['--xid-warning'], backgroundColor: tokens['--xid-warning-bg'] },
  danger: { color: tokens['--xid-danger'], backgroundColor: tokens['--xid-danger-bg'] },
  info: { color: tokens['--xid-accent'], backgroundColor: tokens['--xid-accent-wash'] },
  dot: {
    width: '0.375rem',
    height: '0.375rem',
    flexShrink: 0,
    borderRadius: tokens['--xid-radius-full'],
    backgroundColor: 'currentColor',
  },
})

export function Badge({ tone = 'neutral', variant = 'status', children }: BadgeProps): ReactNode {
  if (variant === 'outline') {
    return <span {...stylex.props(styles.base, styles.outline)}>{children}</span>
  }
  return (
    <span {...stylex.props(styles.base, styles[tone])}>
      <span aria-hidden="true" {...stylex.props(styles.dot)} />
      {children}
    </span>
  )
}
