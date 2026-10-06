// label 在上 + 控件 + 提示 + 错误:cloneElement 注入 id/aria-invalid/aria-describedby。

import { cloneElement, isValidElement, useId } from 'react'
import type { ReactElement, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'
import { text, weight } from '../../styles/scale.stylex'
import { FormError } from './FormError'

type FieldControlProps = {
  id?: string
  'aria-invalid'?: boolean | 'true' | 'false'
  'aria-describedby'?: string
}

export type FieldProps = {
  // 可省略;无 label 时控件需自带 aria-label。
  label?: ReactNode
  // 与 label 同行的辅助链接,例如「Forgot password?」。
  labelAction?: ReactNode
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
    minWidth: 0,
  },
  labelRow: {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: '0.75rem',
  },
  label: {
    fontSize: text.sm,
    fontWeight: weight.medium,
    lineHeight: '1.125rem',
    color: tokens['--xid-fg'],
    fontFamily: tokens['--xid-font'],
  },
  requiredMark: {
    color: tokens['--xid-danger'],
    marginInlineStart: '0.125rem',
  },
  hint: {
    margin: 0,
    fontSize: text.sm,
    lineHeight: '1.125rem',
    color: tokens['--xid-muted-foreground'],
    fontFamily: tokens['--xid-font'],
  },
})

export function Field({
  label,
  labelAction,
  children,
  error,
  hint,
  required = false,
}: FieldProps): ReactNode {
  const controlId = useId()
  const errorId = `${controlId}-error`
  const hintId = `${controlId}-hint`
  const hasError = Boolean(error)

  const showHint = Boolean(hint) && !hasError
  const describedBy = [showHint ? hintId : null, hasError ? errorId : null]
    .filter((value): value is string => value !== null)
    .join(' ')

  const control = isValidElement(children)
    ? cloneElement(children, {
        id: children.props.id ?? controlId,
        'aria-invalid': hasError || undefined,
        'aria-describedby': describedBy || undefined,
      })
    : children
  const resolvedId = isValidElement(children) ? (children.props.id ?? controlId) : controlId

  return (
    <div {...stylex.props(styles.root)}>
      {label != null ? (
        <div {...stylex.props(styles.labelRow)}>
          <label htmlFor={resolvedId} {...stylex.props(styles.label)}>
            {label}
            {required ? (
              <span aria-hidden="true" {...stylex.props(styles.requiredMark)}>
                *
              </span>
            ) : null}
          </label>
          {labelAction}
        </div>
      ) : null}
      {control}
      {showHint ? (
        <p id={hintId} {...stylex.props(styles.hint)}>
          {hint}
        </p>
      ) : null}
      <FormError id={errorId}>{error}</FormError>
    </div>
  )
}
