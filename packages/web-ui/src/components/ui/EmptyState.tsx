// 三种情况三种画面:首次使用(主动句 + 一个主按钮)、列表暂时为空、加载失败(警告提示,不当空状态)。

import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'
import { text, weight } from '../../styles/scale.stylex'
import { Notice } from './Notice'

export const EMPTY_STATE_VARIANTS = ['empty', 'first-use', 'load-failure'] as const
export type EmptyStateVariant = (typeof EMPTY_STATE_VARIANTS)[number]

export type EmptyStateProps = {
  title: ReactNode
  description?: ReactNode
  action?: ReactNode
  variant?: EmptyStateVariant
}

const styles = stylex.create({
  empty: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: '0.375rem',
    paddingBlock: '2rem',
    paddingInline: '0.5rem',
    fontFamily: tokens['--xid-font'],
  },
  firstUse: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: '0.75rem',
    maxWidth: '35rem',
    paddingBlock: '2rem',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
    fontFamily: tokens['--xid-font'],
  },
  emptyTitle: {
    margin: 0,
    color: tokens['--xid-fg'],
    fontSize: text.base,
    fontWeight: weight.medium,
    lineHeight: '1.125rem',
  },
  firstUseTitle: {
    margin: 0,
    color: tokens['--xid-fg'],
    fontSize: text.lg,
    fontWeight: weight.display,
    lineHeight: '1.625rem',
    letterSpacing: tokens['--xid-tracking-title'],
    textWrap: 'balance',
  },
  description: {
    margin: 0,
    maxWidth: '60ch',
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
    lineHeight: '1.125rem',
  },
  firstUseDescription: {
    fontSize: text.base,
    lineHeight: '1.375rem',
  },
  actions: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '1rem',
    paddingBlockStart: '0.25rem',
  },
})

export function EmptyState({
  title,
  description,
  action,
  variant = 'empty',
}: EmptyStateProps): ReactNode {
  if (variant === 'load-failure') {
    return (
      <Notice tone="warning" title={title} action={action}>
        {description}
      </Notice>
    )
  }
  const isFirstUse = variant === 'first-use'
  return (
    <div role="status" {...stylex.props(isFirstUse ? styles.firstUse : styles.empty)}>
      <p {...stylex.props(isFirstUse ? styles.firstUseTitle : styles.emptyTitle)}>{title}</p>
      {description ? (
        <p {...stylex.props(styles.description, isFirstUse && styles.firstUseDescription)}>
          {description}
        </p>
      ) : null}
      {action ? <div {...stylex.props(styles.actions)}>{action}</div> : null}
    </div>
  )
}
