// 原生复选框,选中色为墨色;需要说明文字的选项用 CheckboxField。

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
    accentColor: tokens['--xid-primary'],
    cursor: 'pointer',
  },
})

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(
  function Checkbox(props, ref): ReactNode {
    return <input ref={ref} type="checkbox" {...stylex.props(styles.base)} {...props} />
  },
)
