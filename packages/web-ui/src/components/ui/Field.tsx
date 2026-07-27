// Field:label + 控件 + 内联错误的无障碍组合器。
// 自动接线:label htmlFor -> 控件 id;有错误时控件 aria-invalid + aria-describedby -> 错误节点。
// 控件作为单一 child 传入(Input 或任意 form 控件),Field 用 cloneElement 注入 id/aria。
// 样式走 StyleX,引用主题 tokens(--xid-*)。

import { cloneElement, isValidElement, useId } from 'react'
import type { ReactElement, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'
import { FormError } from './FormError'

// 被注入的控件至少接受这些 a11y 属性(Input/select/textarea 均满足)。
type FieldControlProps = {
  id?: string
  'aria-invalid'?: boolean | 'true' | 'false'
  'aria-describedby'?: string
}

export type FieldProps = {
  // 字段标签(已本地化)。可省略:控件已有外部可见标签时只做错误/hint 接线,控件需自带 aria-label。
  label?: ReactNode
  // 单一表单控件(如 <Input />)。
  children: ReactElement<FieldControlProps>
  // 已本地化的错误文本;有值即进入 invalid 态。
  error?: ReactNode
  // 辅助说明(已本地化),接到 aria-describedby。
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
