// Alert:页面级提示(error/success/warning/info)。
// error 用 role=alert(打断播报);其它用 role=status(礼貌播报)。文案/标题由调用方走 lingui。

import type { CSSProperties, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'

export const ALERT_TONES = ['error', 'success', 'warning', 'info'] as const
export type AlertTone = (typeof ALERT_TONES)[number]

export type AlertProps = {
  tone?: AlertTone
  title?: ReactNode
  style?: CSSProperties
  children: ReactNode
}

const styles = stylex.create({
  base: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.25rem',
    paddingBlock: '0.625rem',
    paddingInline: '0.75rem',
    borderRadius: tokens['--xid-radius-sm'],
    borderWidth: '1px',
    borderStyle: 'solid',
    fontFamily: tokens['--xid-font'],
    fontSize: '0.875rem',
    lineHeight: 1.5,
  },
  // 语义 bg token 直接承载状态底色,不再散落 color-mix。
  error: {
    backgroundColor: tokens['--xid-danger-bg'],
    borderColor: tokens['--xid-danger'],
    color: tokens['--xid-fg'],
  },
  warning: {
    backgroundColor: tokens['--xid-warning-bg'],
    borderColor: tokens['--xid-warning'],
    color: tokens['--xid-fg'],
  },
  success: {
    backgroundColor: tokens['--xid-success-bg'],
    borderColor: tokens['--xid-success'],
    color: tokens['--xid-fg'],
  },
  info: {
    backgroundColor: tokens['--xid-info-bg'],
    borderColor: tokens['--xid-info'],
    color: tokens['--xid-fg'],
  },
  title: {
    fontWeight: 600,
  },
  errorTitle: {
    color: tokens['--xid-danger'],
  },
  warningTitle: {
    color: tokens['--xid-warning-foreground'],
  },
  successTitle: {
    color: tokens['--xid-success'],
  },
  infoTitle: {
    color: tokens['--xid-info'],
  },
  defaultTitle: {
    color: tokens['--xid-fg'],
  },
})

export function Alert({ tone = 'info', title, style, children }: AlertProps): ReactNode {
  const role = tone === 'error' ? 'alert' : 'status'
  const props = stylex.props(styles.base, styles[tone])
  const titleStyle =
    tone === 'error'
      ? [styles.title, styles.errorTitle]
      : tone === 'warning'
        ? [styles.title, styles.warningTitle]
        : tone === 'success'
          ? [styles.title, styles.successTitle]
          : tone === 'info'
            ? [styles.title, styles.infoTitle]
            : [styles.title, styles.defaultTitle]

  return (
    <div
      role={role}
      aria-live={tone === 'error' ? 'assertive' : 'polite'}
      className={props.className}
      style={{ ...props.style, ...style }}
    >
      {title ? <strong {...stylex.props(...titleStyle)}>{title}</strong> : null}
      <span>{children}</span>
    </div>
  )
}
