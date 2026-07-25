import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'

export const BADGE_TONES = ['neutral', 'success', 'warning', 'danger', 'info'] as const
export type BadgeTone = (typeof BADGE_TONES)[number]

export type BadgeProps = {
  tone?: BadgeTone
  children: ReactNode
}

const styles = stylex.create({
  // mono 小写罩大写 + 小圆角:spec chip 而非 pill,贴 landing microlabel 语言。
  base: {
    display: 'inline-flex',
    alignItems: 'center',
    paddingBlock: '0.125rem',
    paddingInline: '0.375rem',
    borderRadius: tokens['--xid-radius-sm'],
    fontSize: '0.6875rem',
    fontWeight: 500,
    fontFamily: tokens['--xid-font-mono'],
    letterSpacing: '0.05em',
    textTransform: 'uppercase',
    lineHeight: 1.4,
    whiteSpace: 'nowrap',
    borderWidth: '1px',
    borderStyle: 'solid',
  },
  neutral: {
    color: tokens['--xid-muted-foreground'],
    backgroundColor: tokens['--xid-muted'],
    borderColor: tokens['--xid-border'],
  },
  success: {
    color: tokens['--xid-success'],
    backgroundColor: tokens['--xid-success-bg'],
    borderColor: tokens['--xid-success'],
  },
  warning: {
    color: tokens['--xid-warning-foreground'],
    backgroundColor: tokens['--xid-warning-bg'],
    borderColor: tokens['--xid-warning'],
  },
  danger: {
    color: tokens['--xid-danger'],
    backgroundColor: tokens['--xid-danger-bg'],
    borderColor: tokens['--xid-danger'],
  },
  info: {
    color: tokens['--xid-info'],
    backgroundColor: tokens['--xid-info-bg'],
    borderColor: tokens['--xid-info'],
  },
})

export function Badge({ tone = 'neutral', children }: BadgeProps): ReactNode {
  return <span {...stylex.props(styles.base, styles[tone])}>{children}</span>
}
