import { Radio } from '@base-ui/react/radio'
import { RadioGroup as BaseRadioGroup } from '@base-ui/react/radio-group'
import { useId } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'
import { text, weight } from '../../styles/scale.stylex'
import { choiceStyles } from './choice-styles'

export type RadioOption = {
  value: string
  label: ReactNode
  description?: ReactNode
  disabled?: boolean
}

export type RadioGroupProps = {
  label: ReactNode
  options: readonly RadioOption[]
  value: string
  onValueChange: (value: string) => void
  name?: string
}

const styles = stylex.create({
  group: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
  },
  legend: {
    color: tokens['--xid-fg'],
    fontFamily: tokens['--xid-font'],
    fontSize: text.sm,
    fontWeight: weight.medium,
    lineHeight: '1.125rem',
  },
})

export function RadioGroup({
  label,
  options,
  value,
  onValueChange,
  name,
}: RadioGroupProps): ReactNode {
  const labelId = useId()
  return (
    <BaseRadioGroup
      aria-labelledby={labelId}
      value={value}
      name={name}
      onValueChange={(next) => onValueChange(String(next))}
      {...stylex.props(styles.group)}
    >
      <span id={labelId} {...stylex.props(styles.legend)}>
        {label}
      </span>
      {options.map((option) => (
        <label
          key={option.value}
          {...stylex.props(choiceStyles.row, option.disabled && choiceStyles.disabled)}
        >
          <Radio.Root
            value={option.value}
            disabled={option.disabled}
            className={(state) =>
              stylex.props(
                choiceStyles.box,
                choiceStyles.radio,
                state.checked && choiceStyles.radioChecked,
              ).className
            }
          />
          <span {...stylex.props(choiceStyles.text)}>
            <span {...stylex.props(choiceStyles.label)}>{option.label}</span>
            {option.description ? (
              <span {...stylex.props(choiceStyles.description)}>{option.description}</span>
            ) : null}
          </span>
        </label>
      ))}
    </BaseRadioGroup>
  )
}
