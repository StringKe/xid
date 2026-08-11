// 字段级错误:aria-live=polite;与 XidError.meta.paramName 就近渲染于输入下方。

import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'

export type FormErrorProps = {
  children?: ReactNode
  id?: string
}

const styles = stylex.create({
  // 间距由 Field 列 gap 承担,自身不带 margin。
  message: {
    margin: 0,
    color: tokens['--xid-danger'],
    fontSize: '0.8125rem',
    lineHeight: 1.5,
    fontFamily: tokens['--xid-font'],
  },
})

export function FormError({ children, id }: FormErrorProps): ReactNode {
  if (!children) return null

  return (
    <p id={id} role="alert" aria-live="polite" {...stylex.props(styles.message)}>
      {children}
    </p>
  )
}
