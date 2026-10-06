import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Field } from '@xid-kit/web-ui/ui'
import { CopyableValue } from './CopyableValue'

const styles = stylex.create({
  list: {
    display: 'grid',
    gap: '0.75rem',
  },
  values: {
    display: 'grid',
    gap: '0.375rem',
  },
})

export type EndpointEntry = {
  label: ReactNode
  values: readonly string[]
  hint?: ReactNode
}

export function EndpointList({ entries }: { entries: readonly EndpointEntry[] }): ReactNode {
  const visible = entries.filter((entry) => entry.values.length > 0)
  if (visible.length === 0) return null
  return (
    <div {...stylex.props(styles.list)}>
      {visible.map((entry, index) => (
        <Field key={index} label={entry.label} hint={entry.hint}>
          <div {...stylex.props(styles.values)}>
            {entry.values.map((value) => (
              <CopyableValue key={value} value={value} />
            ))}
          </div>
        </Field>
      ))}
    </div>
  )
}
