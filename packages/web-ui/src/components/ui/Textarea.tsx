// mono 适配配置/JSON;不自带 label(由 Field 组合)。

import { forwardRef } from 'react'
import type { ReactNode, TextareaHTMLAttributes } from 'react'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'
import { text } from '../../styles/scale.stylex'
import { mergeClassNames } from '../../class-name'
import { controlStyles, isAriaInvalid } from './control-styles'

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  isInvalid?: boolean
}

const styles = stylex.create({
  area: {
    minHeight: '7rem',
    resize: 'vertical',
    paddingBlock: '0.625rem',
    fontFamily: tokens['--xid-font-mono'],
    fontSize: text.sm,
    lineHeight: '1.25rem',
  },
})

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { isInvalid = false, className, style, ...rest },
  ref,
): ReactNode {
  const invalid = isInvalid || isAriaInvalid(rest['aria-invalid'])
  const base = stylex.props(
    controlStyles.base,
    styles.area,
    invalid ? controlStyles.invalid : controlStyles.valid,
    rest.disabled && controlStyles.disabled,
  )

  return (
    <textarea
      ref={ref}
      {...rest}
      className={mergeClassNames(base.className, className)}
      style={{ ...base.style, ...style }}
      aria-invalid={invalid || undefined}
    />
  )
})
