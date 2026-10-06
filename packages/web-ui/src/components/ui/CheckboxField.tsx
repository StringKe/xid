// 带说明文字的复选框;包裹式 label,点文字也能切换。

import { Checkbox as BaseCheckbox } from '@base-ui/react/checkbox'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { choiceStyles } from './choice-styles'
import { Icon } from './Icon'

export type CheckboxFieldProps = {
  label: ReactNode
  description?: ReactNode
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
  name?: string
}

export function CheckboxField({
  label,
  description,
  checked,
  onCheckedChange,
  disabled = false,
  name,
}: CheckboxFieldProps): ReactNode {
  return (
    <label {...stylex.props(choiceStyles.row, disabled && choiceStyles.disabled)}>
      <BaseCheckbox.Root
        checked={checked}
        disabled={disabled}
        name={name}
        onCheckedChange={(next) => onCheckedChange(next)}
        className={(state) =>
          stylex.props(choiceStyles.box, state.checked && choiceStyles.boxChecked).className
        }
      >
        <BaseCheckbox.Indicator>
          <Icon name="check" size={12} />
        </BaseCheckbox.Indicator>
      </BaseCheckbox.Root>
      <span {...stylex.props(choiceStyles.text)}>
        <span {...stylex.props(choiceStyles.label)}>{label}</span>
        {description ? (
          <span {...stylex.props(choiceStyles.description)}>{description}</span>
        ) : null}
      </span>
    </label>
  )
}
