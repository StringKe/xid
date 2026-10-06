import { forwardRef } from 'react'
import type { ReactNode } from 'react'
import { Field } from './Field'
import { Input, type InputProps } from './Input'

export type TextFieldProps = Omit<InputProps, 'isInvalid'> & {
  label: ReactNode
  labelAction?: ReactNode
  hint?: ReactNode
  error?: ReactNode
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, labelAction, hint, error, required, ...inputProps },
  ref,
): ReactNode {
  return (
    <Field label={label} labelAction={labelAction} hint={hint} error={error} required={required}>
      <Input ref={ref} required={required} {...inputProps} />
    </Field>
  )
})
