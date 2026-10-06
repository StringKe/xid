// 一次性码:语义上只有一个 input(autocomplete=one-time-code),格子只是视觉。
// 粘贴或自动填充凑满位数时自动提交,逐字输入不自动提交。

import { useState } from 'react'
import type { ChangeEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'
import { text } from '../../styles/scale.stylex'
import { otpCells, otpGroups, sanitizeOtp, type OtpCharset } from '../../otp'

export type OtpFieldProps = {
  value: string
  onValueChange: (value: string) => void
  onComplete?: (value: string) => void
  length?: number
  charset?: OtpCharset
  id?: string
  name?: string
  disabled?: boolean
  autoFocus?: boolean
  'aria-invalid'?: boolean | 'true' | 'false'
  'aria-describedby'?: string
  'aria-label'?: string
}

const AUTO_SUBMIT_INPUT_TYPES = new Set([
  'insertFromPaste',
  'insertReplacementText',
  'insertFromDrop',
])

const styles = stylex.create({
  root: {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    maxWidth: '100%',
  },
  group: {
    display: 'flex',
    gap: '0.5rem',
    flexGrow: 1,
    flexBasis: 0,
    minWidth: 0,
  },
  cell: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexGrow: 1,
    flexBasis: 0,
    minWidth: 0,
    maxWidth: '2.5rem',
    height: '3rem',
    borderRadius: tokens['--xid-radius'],
    boxShadow: `inset 0 0 0 1px ${tokens['--xid-border-strong']}`,
    backgroundColor: tokens['--xid-surface'],
    color: tokens['--xid-fg'],
    fontFamily: tokens['--xid-font'],
    fontSize: text.lg,
    lineHeight: '1.5rem',
    fontVariantNumeric: 'tabular-nums',
  },
  cellActive: {
    boxShadow: `inset 0 0 0 1.5px ${tokens['--xid-accent']}, 0 0 0 3px ${tokens['--xid-accent-wash']}`,
  },
  cellInvalid: {
    boxShadow: `inset 0 0 0 1px ${tokens['--xid-danger']}`,
  },
  caret: {
    width: '1px',
    height: '1.375rem',
    backgroundColor: tokens['--xid-fg'],
  },
  separator: {
    flexShrink: 0,
    width: '0.5rem',
    height: '1px',
    backgroundColor: tokens['--xid-border-strong'],
  },
  input: {
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
    margin: 0,
    padding: 0,
    borderWidth: 0,
    opacity: 0,
    fontSize: '16px',
    cursor: 'text',
  },
})

export function OtpField({
  value,
  onValueChange,
  onComplete,
  length = 6,
  charset = 'numeric',
  id,
  name,
  disabled = false,
  autoFocus = false,
  'aria-invalid': ariaInvalid,
  'aria-describedby': ariaDescribedBy,
  'aria-label': ariaLabel,
}: OtpFieldProps): ReactNode {
  const [isFocused, setIsFocused] = useState(false)
  const invalid = ariaInvalid === true || ariaInvalid === 'true'
  const cells = otpCells(value, length)
  const activeIndex = Math.min(value.length, length - 1)
  const groups = otpGroups(length)

  function handleChange(event: ChangeEvent<HTMLInputElement>): void {
    const next = sanitizeOtp(event.target.value, { length, charset })
    onValueChange(next)
    const inputType = (event.nativeEvent as InputEvent).inputType
    const isBulk = inputType === undefined || AUTO_SUBMIT_INPUT_TYPES.has(inputType)
    if (next.length === length && isBulk) onComplete?.(next)
  }

  let offset = 0
  return (
    <div {...stylex.props(styles.root)}>
      {groups.map((groupLength, groupIndex) => {
        const start = offset
        offset += groupLength
        return [
          groupIndex > 0 ? (
            <span
              key={`separator-${groupIndex}`}
              aria-hidden="true"
              {...stylex.props(styles.separator)}
            />
          ) : null,
          <div key={`group-${groupIndex}`} aria-hidden="true" {...stylex.props(styles.group)}>
            {cells.slice(start, start + groupLength).map((char, index) => {
              const cellIndex = start + index
              const isActive = isFocused && cellIndex === activeIndex && !disabled
              return (
                <span
                  key={cellIndex}
                  {...stylex.props(
                    styles.cell,
                    invalid && styles.cellInvalid,
                    isActive && styles.cellActive,
                  )}
                >
                  {char || (isActive ? <span {...stylex.props(styles.caret)} /> : null)}
                </span>
              )
            })}
          </div>,
        ]
      })}
      <input
        id={id}
        name={name}
        value={value}
        onChange={handleChange}
        onFocus={() => setIsFocused(true)}
        onBlur={() => setIsFocused(false)}
        disabled={disabled}
        autoFocus={autoFocus}
        autoComplete="one-time-code"
        inputMode={charset === 'numeric' ? 'numeric' : 'text'}
        autoCapitalize={charset === 'numeric' ? 'off' : 'characters'}
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="done"
        aria-invalid={invalid || undefined}
        aria-describedby={ariaDescribedBy}
        aria-label={ariaLabel}
        {...stylex.props(styles.input)}
      />
    </div>
  )
}
