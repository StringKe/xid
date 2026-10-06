// 页内提示:浅底 + 图标 + 标题/说明 + 可选动作,不用彩色侧边竖线。danger 用 role=alert 打断播报。

import type { CSSProperties, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'
import { container, text, weight } from '../../styles/scale.stylex'
import { Icon, type IconName } from './Icon'

export const NOTICE_TONES = ['info', 'success', 'warning', 'danger'] as const
export type NoticeTone = (typeof NOTICE_TONES)[number]

export type NoticeProps = {
  tone?: NoticeTone
  title?: ReactNode
  action?: ReactNode
  style?: CSSProperties
  children?: ReactNode
}

const ICONS: Record<NoticeTone, IconName> = {
  info: 'info-circle',
  success: 'check-circle',
  warning: 'alert-triangle',
  danger: 'alert-circle',
}

const styles = stylex.create({
  frame: {
    containerType: 'inline-size',
  },
  root: {
    display: 'flex',
    flexWrap: { default: 'wrap', [container.tableComfortable]: 'nowrap' },
    alignItems: 'flex-start',
    columnGap: '0.75rem',
    rowGap: '0.625rem',
    paddingBlock: '0.875rem',
    paddingInline: '1rem',
    borderRadius: tokens['--xid-radius'],
    fontFamily: tokens['--xid-font'],
    color: tokens['--xid-fg'],
  },
  info: { backgroundColor: tokens['--xid-accent-wash'] },
  success: { backgroundColor: tokens['--xid-success-bg'] },
  warning: { backgroundColor: tokens['--xid-warning-bg'] },
  danger: { backgroundColor: tokens['--xid-danger-bg'] },
  icon: {
    display: 'inline-flex',
    flexShrink: 0,
    paddingBlockStart: '0.0625rem',
  },
  infoIcon: { color: tokens['--xid-accent'] },
  successIcon: { color: tokens['--xid-success'] },
  warningIcon: { color: tokens['--xid-warning'] },
  dangerIcon: { color: tokens['--xid-danger'] },
  body: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.125rem',
    flexGrow: 1,
    flexBasis: '12rem',
    minWidth: 0,
  },
  title: {
    margin: 0,
    fontSize: text.base,
    fontWeight: weight.medium,
    lineHeight: '1.125rem',
  },
  description: {
    margin: 0,
    fontSize: text.sm,
    lineHeight: '1.25rem',
    color: tokens['--xid-muted-foreground'],
  },
  descriptionOnly: {
    color: tokens['--xid-fg'],
  },
  action: {
    display: 'flex',
    flexShrink: 0,
    marginInlineStart: { default: '1.75rem', [container.tableComfortable]: 0 },
  },
})

const ICON_STYLES = {
  info: styles.infoIcon,
  success: styles.successIcon,
  warning: styles.warningIcon,
  danger: styles.dangerIcon,
} as const

export function Notice({ tone = 'info', title, action, style, children }: NoticeProps): ReactNode {
  const isUrgent = tone === 'danger'
  return (
    <div {...stylex.props(styles.frame)} style={style}>
      <div
        role={isUrgent ? 'alert' : 'status'}
        aria-live={isUrgent ? 'assertive' : 'polite'}
        {...stylex.props(styles.root, styles[tone])}
      >
        <span aria-hidden="true" {...stylex.props(styles.icon, ICON_STYLES[tone])}>
          <Icon name={ICONS[tone]} size={16} />
        </span>
        <div {...stylex.props(styles.body)}>
          {title ? <p {...stylex.props(styles.title)}>{title}</p> : null}
          {children ? (
            <div {...stylex.props(styles.description, !title && styles.descriptionOnly)}>
              {children}
            </div>
          ) : null}
        </div>
        {action ? <div {...stylex.props(styles.action)}>{action}</div> : null}
      </div>
    </div>
  )
}
