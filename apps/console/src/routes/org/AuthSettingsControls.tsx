// 设置分节里的通用控件:带边框的单选卡片、开关行、带单位的数字输入、保存结果提示。

import { Trans } from '@lingui/react/macro'
import { useId } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Switch } from '@xid-kit/web-ui/ui'
import type { XidError } from '@xid-kit/types'
import { useManagementErrorMessage } from '@xid-kit/web-ui/api-error-message'
import { leading, text, weight } from '@xid-kit/web-ui/styles/scale.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { settingsStyles } from './AuthSettingsLayout'

const styles = stylex.create({
  cards: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
    margin: 0,
    padding: 0,
    borderWidth: 0,
    minWidth: 0,
  },
  card: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '0.75rem',
    paddingBlock: '0.75rem',
    paddingInline: '0.875rem',
    borderRadius: tokens['--xid-radius'],
    boxShadow: `inset 0 0 0 1px ${tokens['--xid-border-strong']}`,
    cursor: 'pointer',
    fontFamily: tokens['--xid-font'],
  },
  cardChecked: {
    backgroundColor: tokens['--xid-accent-wash'],
    boxShadow: `inset 0 0 0 1.5px ${tokens['--xid-accent']}`,
  },
  cardDisabled: {
    cursor: 'not-allowed',
    opacity: 0.6,
  },
  radio: {
    flexShrink: 0,
    width: '1.125rem',
    height: '1.125rem',
    margin: 0,
    accentColor: tokens['--xid-accent'],
    cursor: 'pointer',
  },
  cardText: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.125rem',
    minWidth: 0,
  },
  cardLabel: {
    color: tokens['--xid-fg'],
    fontSize: { default: text.md, '@media (min-width: 48rem)': text.base },
    fontWeight: weight.medium,
    lineHeight: leading.sm,
  },
  cardDescription: {
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
    lineHeight: leading.sm,
  },
  unitFields: {
    display: 'grid',
    gridTemplateColumns: {
      default: 'minmax(0, 1fr)',
      '@media (min-width: 36rem)': 'repeat(auto-fit, minmax(10rem, 1fr))',
    },
    gap: '1rem',
  },
  unitField: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.375rem',
    minWidth: 0,
  },
  unitLabel: {
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
    lineHeight: leading.sm,
  },
  unitBox: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    height: { default: '2.75rem', '@media (min-width: 48rem)': '2.25rem' },
    paddingInline: '0.75rem',
    borderRadius: tokens['--xid-radius'],
    boxShadow: {
      default: `inset 0 0 0 1px ${tokens['--xid-border-strong']}`,
      ':focus-within': `inset 0 0 0 2px ${tokens['--xid-accent']}`,
    },
    backgroundColor: tokens['--xid-surface'],
  },
  unitInput: {
    flex: '1 1 auto',
    minWidth: 0,
    padding: 0,
    borderWidth: 0,
    outline: 'none',
    backgroundColor: 'transparent',
    color: tokens['--xid-fg'],
    fontFamily: tokens['--xid-font'],
    fontSize: { default: text.md, '@media (min-width: 48rem)': text.base },
    fontVariantNumeric: 'tabular-nums',
  },
  unitSuffix: {
    flexShrink: 0,
    color: tokens['--xid-muted-foreground'],
    fontSize: text.base,
  },
  status: {
    margin: 0,
    fontSize: text.sm,
    lineHeight: leading.sm,
  },
  statusSuccess: {
    color: tokens['--xid-success'],
  },
  statusError: {
    color: tokens['--xid-danger'],
  },
})

export type ChoiceCardOption<T extends string> = {
  value: T
  label: ReactNode
  description: ReactNode
  disabled?: boolean
}

export function ChoiceCards<T extends string>({
  legend,
  options,
  value,
  onChange,
}: {
  legend: string
  options: readonly ChoiceCardOption<T>[]
  value: T
  onChange: (value: T) => void
}): ReactNode {
  const name = useId()
  return (
    <fieldset aria-label={legend} {...stylex.props(styles.cards)}>
      {options.map((option) => (
        <label
          key={option.value}
          {...stylex.props(
            styles.card,
            option.value === value && styles.cardChecked,
            option.disabled && styles.cardDisabled,
          )}
        >
          <input
            type="radio"
            name={name}
            value={option.value}
            disabled={option.disabled}
            checked={option.value === value}
            onChange={() => onChange(option.value)}
            {...stylex.props(styles.radio)}
          />
          <span {...stylex.props(styles.cardText)}>
            <span {...stylex.props(styles.cardLabel)}>{option.label}</span>
            <span {...stylex.props(styles.cardDescription)}>{option.description}</span>
          </span>
        </label>
      ))}
    </fieldset>
  )
}

export function SwitchRows({
  rows,
}: {
  rows: readonly {
    key: string
    label: ReactNode
    description: ReactNode
    checked: boolean
    onChange: (checked: boolean) => void
  }[]
}): ReactNode {
  return (
    <ul {...stylex.props(settingsStyles.rows)}>
      {rows.map((row) => (
        <li key={row.key} {...stylex.props(settingsStyles.row)}>
          <Switch
            label={row.label}
            description={row.description}
            checked={row.checked}
            onCheckedChange={row.onChange}
          />
        </li>
      ))}
    </ul>
  )
}

export function UnitField({
  label,
  unit,
  value,
  onChange,
  min,
  max,
  step = 1,
  placeholder,
}: {
  label: ReactNode
  unit: ReactNode
  value: string
  onChange: (value: string) => void
  min: number
  max: number
  step?: number
  placeholder?: string
}): ReactNode {
  const id = useId()
  return (
    <div {...stylex.props(styles.unitField)}>
      <label htmlFor={id} {...stylex.props(styles.unitLabel)}>
        {label}
      </label>
      <div {...stylex.props(styles.unitBox)}>
        <input
          id={id}
          type="number"
          inputMode="decimal"
          min={min}
          max={max}
          step={step}
          value={value}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
          {...stylex.props(styles.unitInput)}
        />
        <span {...stylex.props(styles.unitSuffix)}>{unit}</span>
      </div>
    </div>
  )
}

export function UnitFields({ children }: { children: ReactNode }): ReactNode {
  return <div {...stylex.props(styles.unitFields)}>{children}</div>
}

export function SaveStatus({
  error,
  saved,
}: {
  error: XidError | null
  saved: boolean
}): ReactNode {
  const errorMessage = useManagementErrorMessage()
  if (error) {
    return (
      <p role="alert" {...stylex.props(styles.status, styles.statusError)}>
        {errorMessage(error)}
      </p>
    )
  }
  if (!saved) return null
  return (
    <p role="status" {...stylex.props(styles.status, styles.statusSuccess)}>
      <Trans>Saved.</Trans>
    </p>
  )
}
