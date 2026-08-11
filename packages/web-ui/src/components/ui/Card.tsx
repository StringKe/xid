// 默认 1px 边框无阴影;仅 raised 允许 shadow-sm。

import type { HTMLAttributes, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'
import { mergeClassNames } from '../../class-name'

export type CardProps = HTMLAttributes<HTMLElement> & {
  as?: 'section' | 'article' | 'div'
  variant?: 'default' | 'raised'
}

const styles = stylex.create({
  base: {
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: tokens['--xid-border'],
    borderRadius: tokens['--xid-radius'],
    padding: '1rem',
    color: tokens['--xid-fg'],
    fontFamily: tokens['--xid-font'],
  },
  default: {
    backgroundColor: tokens['--xid-surface'],
  },
  raised: {
    backgroundColor: tokens['--xid-surface'],
    boxShadow: tokens['--xid-shadow-sm'],
  },
})

export function Card({
  as = 'section',
  variant = 'default',
  children,
  className,
  style,
  ...rest
}: CardProps): ReactNode {
  const Tag = as
  const base = stylex.props(styles.base, styles[variant])
  return (
    <Tag
      className={mergeClassNames(base.className, className)}
      style={{ ...base.style, ...style }}
      {...rest}
    >
      {children}
    </Tag>
  )
}
