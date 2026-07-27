// Card:内容容器。section 语义,可选 aria-labelledby 关联标题(由调用方提供 title id)。
// 层次靠 1px 边框 + surface 底,不靠阴影;variant=raised 才允许 shadow-sm。
// style 透传:调用方按需覆盖布局定位(width/maxWidth 等),与 StyleX 基样式合并。

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
    // 唯一允许阴影的变体;shadow-sm token 随 light/dark 自动翻转。
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
