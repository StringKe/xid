// 只读机器值(ID、端点、密钥前缀):等宽字体 + 复制按钮。

import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'
import { text } from '../../styles/scale.stylex'
import { CopyButton } from './CopyButton'

export type CopyFieldProps = {
  value: string
  subject: string
}

const styles = stylex.create({
  root: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    minWidth: 0,
    minHeight: '2.25rem',
    paddingInlineStart: '0.625rem',
    paddingInlineEnd: '0.125rem',
    borderRadius: tokens['--xid-radius'],
    backgroundColor: tokens['--xid-sidebar'],
    boxShadow: `inset 0 0 0 1px ${tokens['--xid-border']}`,
  },
  value: {
    flexGrow: 1,
    minWidth: 0,
    color: tokens['--xid-fg'],
    fontFamily: tokens['--xid-font-mono'],
    fontSize: text.sm,
    lineHeight: '1.25rem',
    overflowWrap: 'anywhere',
    userSelect: 'all',
  },
})

export function CopyField({ value, subject }: CopyFieldProps): ReactNode {
  return (
    <div {...stylex.props(styles.root)}>
      <code {...stylex.props(styles.value)}>{value}</code>
      <CopyButton value={value} subject={subject} />
    </div>
  )
}
