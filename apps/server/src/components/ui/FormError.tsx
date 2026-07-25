// FormError:内联表单字段错误。aria-live=polite 让屏幕阅读器播报错误变化。
// 与 XidError.meta.paramName 配合:字段级错误就近渲染于对应输入下方。文案由调用方走 lingui。
// 样式走 StyleX,引用主题 tokens(--xid-*)。

import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'

export type FormErrorProps = {
  // 错误文本(已本地化);为空/undefined 时不渲染。
  children?: ReactNode
  // 关联输入的 id,使 aria-describedby 指回本节点(Field 自动接线)。
  id?: string
}

const styles = stylex.create({
  // 间距交给 Field 的列 gap,自身不带 margin。
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
