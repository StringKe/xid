// 验证码只用一个 input:autocomplete=one-time-code,允许粘贴带空格或连字符的码。
// 只在粘贴或系统自动填充凑满位数时自动提交,逐字输入要按按钮。

import { plural } from '@lingui/core/macro'
import { useLingui } from '@lingui/react/macro'
import type { ChangeEvent, CSSProperties, ReactNode } from 'react'
import { Field } from '@xid-kit/web-ui/ui/Field'
import { Input } from '@xid-kit/web-ui/ui/Input'
import { text } from '@xid-kit/web-ui/styles/scale.stylex'
import { tokens } from '../../styles/tokens.stylex'
import {
  codeFormatIssue,
  normalizeCode,
  type CodeCharset,
  type CodeFormatIssue,
} from './code-input'

const BULK_INPUT_TYPES = new Set(['insertFromPaste', 'insertReplacementText', 'insertFromDrop'])

// Input 的字号与字体由共享控件样式给出,这里用 inline style 覆盖,避免两组原子类比较先后。
const CODE_INPUT_STYLE: CSSProperties = {
  fontSize: text.lg,
  letterSpacing: '0.12em',
  fontVariantNumeric: 'tabular-nums',
  fontFamily: tokens['--xid-font-mono'],
}

export type CodeFieldProps = {
  label: ReactNode
  value: string
  onValueChange: (value: string) => void
  onComplete?: (code: string) => void
  length: number
  charset?: CodeCharset
  hint?: ReactNode
  error?: ReactNode
  disabled?: boolean
  autoFocus?: boolean
  oneTimeCode?: boolean
  name?: string
}

export function CodeField({
  label,
  value,
  onValueChange,
  onComplete,
  length,
  charset = 'numeric',
  hint,
  error,
  disabled = false,
  autoFocus = false,
  oneTimeCode = true,
  name,
}: CodeFieldProps): ReactNode {
  function handleChange(event: ChangeEvent<HTMLInputElement>): void {
    const next = event.target.value
    onValueChange(next)
    const inputType = (event.nativeEvent as InputEvent).inputType
    const isBulk = inputType === undefined || BULK_INPUT_TYPES.has(inputType)
    if (isBulk && codeFormatIssue(next, { length, charset }) === null) {
      onComplete?.(normalizeCode(next, charset))
    }
  }

  return (
    <Field label={label} hint={error ? undefined : hint} error={error}>
      <Input
        name={name}
        value={value}
        onChange={handleChange}
        disabled={disabled}
        autoFocus={autoFocus}
        inputSize="lg"
        autoComplete={oneTimeCode ? 'one-time-code' : 'off'}
        inputMode={charset === 'numeric' ? 'numeric' : 'text'}
        autoCapitalize={charset === 'numeric' ? 'off' : 'characters'}
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="done"
        maxLength={length * 2 + 2}
        style={CODE_INPUT_STYLE}
      />
    </Field>
  )
}

export function useCodeFormatMessage(): (
  issue: CodeFormatIssue,
  input: { length: number; actual: string; charset: CodeCharset },
) => string {
  const { t } = useLingui()
  return (issue, { length, actual, charset }) => {
    const count = normalizeCode(actual, charset).length
    if (issue === 'invalid_character') {
      return charset === 'numeric'
        ? t`Use only numbers. Spaces and dashes are fine.`
        : t`That code has a character it can't contain. Check it and try again.`
    }
    if (issue === 'empty') return t`Enter the code first.`
    return charset === 'numeric'
      ? t`Enter all ${length} digits. ${plural(count, { one: 'This has # digit.', other: 'This has # digits.' })}`
      : t`Enter all ${length} characters. ${plural(count, { one: 'This has # character.', other: 'This has # characters.' })}`
  }
}
