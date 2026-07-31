// Checkbox:原生 checkbox 的统一尺度(accent 着色 + 1rem 盒)。
// 组合方式:外部 label 包裹或由 Field/CheckRow 组合;不吃 aria-invalid(checkbox 无 invalid 语义场景)。

import { forwardRef } from 'react'
import type { InputHTMLAttributes, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'

export type CheckboxProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>

const styles = stylex.create({
  base: {
    width: '1rem',
    height: '1rem',
    margin: 0,
    flexShrink: 0,
    accentColor: tokens['--xid-accent'],
  },
})

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(
  function Checkbox(props, ref): ReactNode {
    return <input ref={ref} type="checkbox" {...stylex.props(styles.base)} {...props} />
  },
)
