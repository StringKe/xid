// 标识列:名字在上,邮箱或等宽 ID 在下;所有用户、成员、组织、应用列表的首列都用它。

import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'
import { text, weight } from '../../styles/scale.stylex'
import { Avatar } from './Avatar'

export type IdentityCellProps = {
  name: ReactNode
  secondary?: ReactNode
  secondaryIsCode?: boolean
  avatarName?: string
  avatarSrc?: string | null
}

const styles = stylex.create({
  root: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
    minWidth: 0,
  },
  text: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
  },
  name: {
    color: tokens['--xid-fg'],
    fontSize: text.base,
    fontWeight: weight.medium,
    lineHeight: '1.125rem',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  secondary: {
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
    lineHeight: '1rem',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  code: {
    fontFamily: tokens['--xid-font-mono'],
    fontSize: text.xs,
  },
})

export function IdentityCell({
  name,
  secondary,
  secondaryIsCode = false,
  avatarName,
  avatarSrc,
}: IdentityCellProps): ReactNode {
  return (
    <span {...stylex.props(styles.root)}>
      {avatarName !== undefined ? <Avatar name={avatarName} src={avatarSrc} /> : null}
      <span {...stylex.props(styles.text)}>
        <span {...stylex.props(styles.name)}>{name}</span>
        {secondary ? (
          <span {...stylex.props(styles.secondary, secondaryIsCode && styles.code)}>
            {secondary}
          </span>
        ) : null}
      </span>
    </span>
  )
}
