// Base UI Select:选项需要说明文字或自定义渲染时用;普通表单字段用原生 Select。

import { Select as BaseSelect } from '@base-ui/react/select'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'
import { text } from '../../styles/scale.stylex'
import { mergeClassNames } from '../../class-name'
import { controlStyles } from './control-styles'
import { Icon } from './Icon'
import { popupStyles } from './popup-styles'

export type SelectMenuOption = {
  value: string
  label: string
  description?: ReactNode
  disabled?: boolean
}

export type SelectMenuProps = {
  options: readonly SelectMenuOption[]
  value: string | null
  onValueChange: (value: string) => void
  placeholder?: string
  id?: string
  disabled?: boolean
  'aria-invalid'?: boolean | 'true' | 'false'
  'aria-describedby'?: string
  'aria-label'?: string
}

const styles = stylex.create({
  trigger: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '0.5rem',
    cursor: 'pointer',
    textAlign: 'start',
  },
  value: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  placeholder: {
    color: tokens['--xid-faint-foreground'],
  },
  icon: {
    display: 'inline-flex',
    color: tokens['--xid-muted-foreground'],
  },
  itemText: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.125rem',
    flexGrow: 1,
    minWidth: 0,
    paddingBlock: '0.375rem',
  },
  itemDescription: {
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
  },
})

export function SelectMenu({
  options,
  value,
  onValueChange,
  placeholder,
  id,
  disabled = false,
  'aria-invalid': ariaInvalid,
  'aria-describedby': ariaDescribedBy,
  'aria-label': ariaLabel,
}: SelectMenuProps): ReactNode {
  const invalid = ariaInvalid === true || ariaInvalid === 'true'
  const trigger = stylex.props(
    controlStyles.base,
    styles.trigger,
    invalid ? controlStyles.invalid : controlStyles.valid,
    disabled && controlStyles.disabled,
  )
  const surface = stylex.props(popupStyles.surface, popupStyles.matchAnchor)
  const items = options.map((option) => ({ value: option.value, label: option.label }))

  return (
    <BaseSelect.Root
      items={items}
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        if (typeof next === 'string') onValueChange(next)
      }}
    >
      <BaseSelect.Trigger
        id={id}
        aria-invalid={invalid || undefined}
        aria-describedby={ariaDescribedBy}
        aria-label={ariaLabel}
        className={trigger.className}
        style={trigger.style}
      >
        <BaseSelect.Value
          placeholder={placeholder}
          className={(state) =>
            stylex.props(styles.value, state.placeholder && styles.placeholder).className
          }
        />
        <BaseSelect.Icon {...stylex.props(styles.icon)}>
          <Icon name="chevrons-up-down" size={16} />
        </BaseSelect.Icon>
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner
          sideOffset={4}
          alignItemWithTrigger={false}
          {...stylex.props(popupStyles.positioner)}
        >
          <BaseSelect.Popup className={mergeClassNames(surface.className, 'xid-motion-pop')}>
            <BaseSelect.List>
              {options.map((option) => (
                <BaseSelect.Item
                  key={option.value}
                  value={option.value}
                  label={option.label}
                  disabled={option.disabled}
                  className={(state) =>
                    stylex.props(
                      popupStyles.item,
                      state.highlighted && popupStyles.itemHighlighted,
                      option.disabled && popupStyles.itemDisabled,
                    ).className
                  }
                >
                  <span {...stylex.props(styles.itemText)}>
                    <BaseSelect.ItemText>{option.label}</BaseSelect.ItemText>
                    {option.description ? (
                      <span {...stylex.props(styles.itemDescription)}>{option.description}</span>
                    ) : null}
                  </span>
                  <BaseSelect.ItemIndicator {...stylex.props(popupStyles.itemCheck)}>
                    <Icon name="check" size={14} />
                  </BaseSelect.ItemIndicator>
                </BaseSelect.Item>
              ))}
            </BaseSelect.List>
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  )
}
