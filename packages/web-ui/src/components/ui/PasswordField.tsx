import { useLingui } from '@lingui/react/macro'
import { forwardRef, useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'
import { size, text, weight } from '../../styles/scale.stylex'
import { Field } from './Field'
import { Icon } from './Icon'
import { Input, type InputProps } from './Input'

export type PasswordFieldProps = Omit<InputProps, 'isInvalid' | 'type'> & {
  label: ReactNode
  labelAction?: ReactNode
  hint?: ReactNode
  error?: ReactNode
}

const styles = stylex.create({
  wrap: {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
  },
  input: {
    paddingInlineEnd: '5rem',
  },
  reveal: {
    position: 'absolute',
    insetInlineEnd: '0.25rem',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.375rem',
    minHeight: { default: '1.75rem', '@media (pointer: coarse)': size.touch },
    paddingInline: '0.625rem',
    borderWidth: 0,
    borderRadius: tokens['--xid-radius-sm'],
    backgroundColor: { default: 'transparent', ':hover': tokens['--xid-muted'] },
    color: tokens['--xid-fg'],
    fontFamily: tokens['--xid-font'],
    fontSize: text.sm,
    fontWeight: weight.medium,
    cursor: 'pointer',
  },
  revealIcon: {
    display: 'inline-flex',
    color: tokens['--xid-muted-foreground'],
  },
})

export const PasswordField = forwardRef<HTMLInputElement, PasswordFieldProps>(
  function PasswordField(
    { label, labelAction, hint, error, required, autoComplete = 'current-password', ...inputProps },
    ref,
  ): ReactNode {
    const { t } = useLingui()
    const [isRevealed, setIsRevealed] = useState(false)

    return (
      <Field label={label} labelAction={labelAction} hint={hint} error={error} required={required}>
        <PasswordInput
          ref={ref}
          required={required}
          autoComplete={autoComplete}
          isRevealed={isRevealed}
          onRevealToggle={() => setIsRevealed((value) => !value)}
          showLabel={t`Show`}
          hideLabel={t`Hide`}
          toggleLabel={t`Show password`}
          {...inputProps}
        />
      </Field>
    )
  },
)

type PasswordInputProps = Omit<InputProps, 'type'> & {
  isRevealed: boolean
  onRevealToggle: () => void
  showLabel: string
  hideLabel: string
  toggleLabel: string
}

const PasswordInput = forwardRef<HTMLInputElement, PasswordInputProps>(function PasswordInput(
  {
    isRevealed,
    onRevealToggle,
    showLabel,
    hideLabel,
    toggleLabel,
    inputSize = 'lg',
    ...inputProps
  },
  ref,
): ReactNode {
  return (
    <span {...stylex.props(styles.wrap)}>
      <Input
        ref={ref}
        type={isRevealed ? 'text' : 'password'}
        inputSize={inputSize}
        spellCheck={false}
        autoCapitalize="none"
        {...stylex.props(styles.input)}
        {...inputProps}
      />
      <button
        type="button"
        aria-label={toggleLabel}
        aria-pressed={isRevealed}
        aria-controls={inputProps.id}
        onClick={onRevealToggle}
        {...stylex.props(styles.reveal)}
      >
        <span aria-hidden="true" {...stylex.props(styles.revealIcon)}>
          <Icon name={isRevealed ? 'eye-off' : 'eye'} size={16} />
        </span>
        <span aria-hidden="true">{isRevealed ? hideLabel : showLabel}</span>
      </button>
    </span>
  )
})
