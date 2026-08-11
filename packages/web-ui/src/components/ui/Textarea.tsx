// mono 小字号适配配置/JSON;不自带 label(由 Field 组合)。

import { forwardRef } from 'react'
import type { ReactNode, TextareaHTMLAttributes } from 'react'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  isInvalid?: boolean
}

const styles = stylex.create({
  base: {
    width: '100%',
    minHeight: '7rem',
    resize: 'vertical',
    boxSizing: 'border-box',
    padding: '0.75rem',
    borderRadius: tokens['--xid-radius'],
    borderWidth: '1px',
    borderStyle: 'solid',
    backgroundColor: tokens['--xid-bg'],
    color: tokens['--xid-fg'],
    fontFamily: tokens['--xid-font-mono'],
    fontSize: '0.8125rem',
    lineHeight: 1.5,
    transitionProperty: {
      default: 'border-color',
      '@media (prefers-reduced-motion: reduce)': 'none',
    },
    transitionDuration: '0.12s',
    transitionTimingFunction: 'ease-out',
    outline: 'none',
  },
  valid: {
    borderColor: {
      default: tokens['--xid-border'],
      ':focus': tokens['--xid-accent'],
    },
  },
  invalid: {
    borderColor: tokens['--xid-danger'],
  },
})

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { isInvalid = false, ...rest },
  ref,
): ReactNode {
  const invalid = isInvalid || rest['aria-invalid'] === true || rest['aria-invalid'] === 'true'

  return (
    <textarea
      ref={ref}
      {...stylex.props(styles.base, invalid ? styles.invalid : styles.valid)}
      {...rest}
      aria-invalid={invalid || undefined}
    />
  )
})
