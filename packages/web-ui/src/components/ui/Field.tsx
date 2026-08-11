// label + 控件 + 错误:cloneElement 注入 id/aria-invalid/aria-describedby。

import { cloneElement, isValidElement, useId } from 'react'
import type { ReactElement, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'
import { FormError } from './FormError'

type FieldControlProps = {
  id?: string
  'aria-invalid'?: boolean | 'true' | 'false'
  'aria-describedby'?: string
}

export type FieldProps = {
  // 可省略;无 label 时控件需自带 aria-label。
  label?: ReactNode
  children: ReactElement<FieldControlProps>
  error?: ReactNode
  hint?: ReactNode
  required?: boolean
}

const styles = stylex.create({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.375rem',
  },
  label: {
    fontSize: '0.8125rem',
    fontWeight: 550,
    lineHeight: 1.4,
    color: tokens['--xid-fg'],
    fontFamily: tokens['--xid-font'],
  },
  requiredMark: {
    color: tokens['--xid-danger'],
    marginLeft: '0.125rem',
  },
  hint: {
    margin: 0,
    fontSize: '0.8125rem',
    lineHeight: 1.5,
    color: tokens['--xid-muted-foreground'],
    fontFamily: tokens['--xid-font'],
  },
})

export function Field({ label, children, error, hint, required = false }: FieldProps): ReactNode {
  const controlId = useId()
  const errorId = `${controlId}-error`
  const hintId = `${controlId}-hint`
  const hasError = Boolean(error)

  const describedBy = [hint ? hintId : null, hasError ? errorId : null]
    .filter((value): value is string => value !== null)
    .join(' ')

  const control = isValidElement(children)
    ? cloneElement(children, {
        id: controlId,
        'aria-invalid': hasError || undefined,
        'aria-describedby': describedBy || undefined,
      })
    : children

  return (
    <div {...stylex.props(styles.root)}>
      {label != null ? (
        <label htmlFor={controlId} {...stylex.props(styles.label)}>
          {label}
          {required ? (
            <span aria-hidden="true" {...stylex.props(styles.requiredMark)}>
              *
            </span>
          ) : null}
        </label>
      ) : null}
      {control}
      {hint ? (
        <p id={hintId} {...stylex.props(styles.hint)}>
          {hint}
        </p>
      ) : null}
      <FormError id={errorId}>{error}</FormError>
    </div>
  )
}
