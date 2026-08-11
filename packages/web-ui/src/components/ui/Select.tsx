// 与 Input 同尺度;不自带 label(由 Field 组合)。

import { forwardRef } from 'react'
import type { ReactNode, SelectHTMLAttributes } from 'react'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'

export type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & {
  isInvalid?: boolean
}

const styles = stylex.create({
  base: {
    width: '100%',
    minHeight: {
      default: '2.5rem',
      '@media (pointer: coarse)': '2.75rem',
    },
    paddingBlock: 0,
    paddingInline: '0.75rem',
    borderRadius: tokens['--xid-radius'],
    borderWidth: '1px',
    borderStyle: 'solid',
    backgroundColor: tokens['--xid-bg'],
    color: tokens['--xid-fg'],
    fontFamily: tokens['--xid-font'],
    fontSize: '0.875rem',
    boxSizing: 'border-box',
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

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { isInvalid = false, ...rest },
  ref,
): ReactNode {
  const invalid = isInvalid || rest['aria-invalid'] === true || rest['aria-invalid'] === 'true'

  return (
    <select
      ref={ref}
      {...stylex.props(styles.base, invalid ? styles.invalid : styles.valid)}
      {...rest}
      aria-invalid={invalid || undefined}
    />
  )
})
