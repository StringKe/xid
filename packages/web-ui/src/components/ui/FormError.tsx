// 字段级错误:aria-live=polite;与 XidError.meta.paramName 就近渲染于输入下方。

import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'
import { text } from '../../styles/scale.stylex'
import { Icon } from './Icon'

export type FormErrorProps = {
  children?: ReactNode
  id?: string
}

const styles = stylex.create({
  message: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '0.375rem',
    margin: 0,
    color: tokens['--xid-danger'],
    fontSize: text.sm,
    lineHeight: '1.125rem',
    fontFamily: tokens['--xid-font'],
  },
  icon: {
    display: 'inline-flex',
    flexShrink: 0,
    paddingBlockStart: '0.0625rem',
  },
})

export function FormError({ children, id }: FormErrorProps): ReactNode {
  if (!children) return null

  return (
    <p id={id} role="alert" aria-live="polite" {...stylex.props(styles.message)}>
      <span aria-hidden="true" {...stylex.props(styles.icon)}>
        <Icon name="alert-circle" size={16} />
      </span>
      <span>{children}</span>
    </p>
  )
}
