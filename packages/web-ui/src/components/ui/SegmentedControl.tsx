// 在同一视图里切换少量互斥选项(例如时间范围);外圆角 6 = 内圆角 4 + 内边距 2。

import { Radio } from '@base-ui/react/radio'
import { RadioGroup } from '@base-ui/react/radio-group'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'
import { size, text, weight } from '../../styles/scale.stylex'

export type SegmentedOption = {
  value: string
  label: ReactNode
}

export type SegmentedControlProps = {
  options: readonly SegmentedOption[]
  value: string
  onValueChange: (value: string) => void
  ariaLabel: string
}

const styles = stylex.create({
  group: {
    display: 'inline-flex',
    gap: '0.125rem',
    maxWidth: '100%',
    padding: '0.125rem',
    overflowX: 'auto',
    borderRadius: tokens['--xid-radius'],
    backgroundColor: tokens['--xid-muted'],
    fontFamily: tokens['--xid-font'],
  },
  option: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    minHeight: { default: '1.75rem', '@media (pointer: coarse)': size.touch },
    paddingInline: '0.75rem',
    borderRadius: tokens['--xid-radius-sm'],
    color: { default: tokens['--xid-muted-foreground'], ':hover': tokens['--xid-fg'] },
    fontSize: text.sm,
    lineHeight: '1.125rem',
    whiteSpace: 'nowrap',
    cursor: 'pointer',
    userSelect: 'none',
  },
  selected: {
    backgroundColor: tokens['--xid-surface'],
    boxShadow: `inset 0 0 0 1px ${tokens['--xid-border-strong']}`,
    color: tokens['--xid-fg'],
    fontWeight: weight.medium,
  },
})

export function SegmentedControl({
  options,
  value,
  onValueChange,
  ariaLabel,
}: SegmentedControlProps): ReactNode {
  return (
    <RadioGroup
      aria-label={ariaLabel}
      value={value}
      onValueChange={(next) => onValueChange(String(next))}
      {...stylex.props(styles.group)}
    >
      {options.map((option) => (
        <Radio.Root
          key={option.value}
          value={option.value}
          className={(state) =>
            stylex.props(styles.option, state.checked && styles.selected).className
          }
        >
          {option.label}
        </Radio.Root>
      ))}
    </RadioGroup>
  )
}
