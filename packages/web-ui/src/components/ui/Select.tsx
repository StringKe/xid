// 原生 select:表单提交、移动端系统选择器、读屏都开箱即用;需要富列表时用 SelectMenu。

import { forwardRef } from 'react'
import type { ReactNode, SelectHTMLAttributes } from 'react'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'
import { mergeClassNames } from '../../class-name'
import { controlStyles, isAriaInvalid } from './control-styles'
import { Icon } from './Icon'

export type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & {
  isInvalid?: boolean
}

const styles = stylex.create({
  wrap: {
    position: 'relative',
    display: 'block',
    width: '100%',
    minWidth: 0,
  },
  select: {
    appearance: 'none',
    paddingInlineEnd: '2rem',
    cursor: 'pointer',
  },
  chevron: {
    position: 'absolute',
    insetInlineEnd: '0.5rem',
    top: '50%',
    transform: 'translateY(-50%)',
    display: 'inline-flex',
    pointerEvents: 'none',
    color: tokens['--xid-muted-foreground'],
  },
})

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { isInvalid = false, className, style, ...rest },
  ref,
): ReactNode {
  const invalid = isInvalid || isAriaInvalid(rest['aria-invalid'])
  const base = stylex.props(
    controlStyles.base,
    styles.select,
    invalid ? controlStyles.invalid : controlStyles.valid,
    rest.disabled && controlStyles.disabled,
  )

  return (
    <span {...stylex.props(styles.wrap)}>
      <select
        ref={ref}
        {...rest}
        className={mergeClassNames(base.className, className)}
        style={{ ...base.style, ...style }}
        aria-invalid={invalid || undefined}
      />
      <span aria-hidden="true" {...stylex.props(styles.chevron)}>
        <Icon name="chevrons-up-down" size={16} />
      </span>
    </span>
  )
})
