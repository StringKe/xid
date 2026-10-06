// 立即生效的开关;标签写清打开的是什么,不写 On / Off。

import { Switch as BaseSwitch } from '@base-ui/react/switch'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { choiceStyles } from './choice-styles'

export type SwitchProps = {
  label: ReactNode
  description?: ReactNode
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
}

const styles = stylex.create({
  row: {
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: '0.75rem',
  },
})

export function Switch({
  label,
  description,
  checked,
  onCheckedChange,
  disabled = false,
}: SwitchProps): ReactNode {
  return (
    <label {...stylex.props(choiceStyles.row, styles.row, disabled && choiceStyles.disabled)}>
      <span {...stylex.props(choiceStyles.text)}>
        <span {...stylex.props(choiceStyles.label)}>{label}</span>
        {description ? (
          <span {...stylex.props(choiceStyles.description)}>{description}</span>
        ) : null}
      </span>
      <BaseSwitch.Root
        checked={checked}
        disabled={disabled}
        onCheckedChange={(next) => onCheckedChange(next)}
        className={(state) =>
          stylex.props(choiceStyles.track, state.checked && choiceStyles.trackChecked).className
        }
      >
        <BaseSwitch.Thumb
          className={(state) =>
            stylex.props(choiceStyles.thumb, state.checked && choiceStyles.thumbChecked).className
          }
        />
      </BaseSwitch.Root>
    </label>
  )
}
