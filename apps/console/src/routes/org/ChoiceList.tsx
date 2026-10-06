import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Checkbox } from '@xid-kit/web-ui/ui'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'

const styles = stylex.create({
  grid: {
    display: 'grid',
    gridTemplateColumns: {
      default: '1fr',
      '@media (min-width: 40rem)': 'repeat(auto-fill, minmax(16rem, 1fr))',
    },
    gap: '0.375rem 1rem',
    maxHeight: '18rem',
    overflowY: 'auto',
  },
  option: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    fontSize: '0.8125rem',
    fontFamily: tokens['--xid-font-mono'],
    overflowWrap: 'anywhere',
  },
})

export type ChoiceListProps = {
  options: readonly string[]
  selected: readonly string[]
  onChange: (next: string[]) => void
  label: string
}

export function ChoiceList({ options, selected, onChange, label }: ChoiceListProps): ReactNode {
  function toggle(option: string, checked: boolean): void {
    onChange(checked ? [...selected, option] : selected.filter((item) => item !== option))
  }
  return (
    <div role="group" aria-label={label} {...stylex.props(styles.grid)}>
      {options.map((option) => (
        <label key={option} {...stylex.props(styles.option)}>
          <Checkbox
            checked={selected.includes(option)}
            onChange={(event) => toggle(option, event.target.checked)}
          />
          {option}
        </label>
      ))}
    </div>
  )
}
