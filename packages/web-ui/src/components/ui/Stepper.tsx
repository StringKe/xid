// 纯展示不导航;步骤切换由页面状态机驱动。进度条给视觉,文字给读屏。

import { Trans } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'
import { text, weight } from '../../styles/scale.stylex'

export type StepperProps = {
  current: number
  total: number
  label?: ReactNode
}

const styles = stylex.create({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
    margin: 0,
    fontFamily: tokens['--xid-font'],
  },
  text: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    columnGap: '0.75rem',
    rowGap: '0.125rem',
    margin: 0,
    fontSize: text.xs,
    lineHeight: '1rem',
    letterSpacing: tokens['--xid-tracking-small'],
  },
  count: {
    color: tokens['--xid-muted-foreground'],
    fontVariantNumeric: 'tabular-nums',
  },
  label: {
    color: tokens['--xid-fg'],
    fontWeight: weight.medium,
  },
  track: {
    display: 'flex',
    gap: '0.25rem',
  },
  segment: {
    flexGrow: 1,
    height: '0.1875rem',
    borderRadius: tokens['--xid-radius-full'],
    backgroundColor: tokens['--xid-border'],
  },
  segmentDone: {
    backgroundColor: tokens['--xid-fg'],
  },
})

export function Stepper({ current, total, label }: StepperProps): ReactNode {
  return (
    <div {...stylex.props(styles.root)}>
      <p {...stylex.props(styles.text)}>
        <span {...stylex.props(styles.count)}>
          <Trans>
            Step {current} of {total}
          </Trans>
        </span>
        {label != null ? <span {...stylex.props(styles.label)}>{label}</span> : null}
      </p>
      <div aria-hidden="true" {...stylex.props(styles.track)}>
        {Array.from({ length: total }, (_unused, index) => (
          <span
            key={index}
            {...stylex.props(styles.segment, index < current && styles.segmentDone)}
          />
        ))}
      </div>
    </div>
  )
}
