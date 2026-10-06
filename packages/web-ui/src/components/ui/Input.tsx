// 不自带 label(由 Field / TextField 组合);聚焦环由 controlStyles 绘制,本地不叠全局 outline。

import { forwardRef } from 'react'
import type { InputHTMLAttributes, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { mergeClassNames } from '../../class-name'
import { controlStyles, isAriaInvalid } from './control-styles'

export type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  isInvalid?: boolean
  inputSize?: 'md' | 'lg'
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { isInvalid = false, inputSize = 'md', className, style, ...rest },
  ref,
): ReactNode {
  const invalid = isInvalid || isAriaInvalid(rest['aria-invalid'])
  const base = stylex.props(
    controlStyles.base,
    inputSize === 'lg' && controlStyles.large,
    invalid ? controlStyles.invalid : controlStyles.valid,
    rest.disabled && controlStyles.disabled,
  )

  return (
    <input
      ref={ref}
      {...rest}
      className={mergeClassNames(base.className, className)}
      style={{ ...base.style, ...style }}
      aria-invalid={invalid || undefined}
    />
  )
})
