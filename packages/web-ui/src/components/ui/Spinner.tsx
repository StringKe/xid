// currentColor 随上下文前景自适应;reduced-motion 下停转。

import { useLingui } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'

export type SpinnerProps = {
  size?: number
  label?: string
}

const spin = stylex.keyframes({
  to: { transform: 'rotate(360deg)' },
})

const styles = stylex.create({
  wrapper: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.5rem',
  },
  ring: {
    borderWidth: '2px',
    borderStyle: 'solid',
    borderColor: 'color-mix(in oklch, currentColor 25%, transparent)',
    borderTopColor: 'currentColor',
    borderRadius: '50%',
    display: 'inline-block',
    animationName: {
      default: spin,
      '@media (prefers-reduced-motion: reduce)': 'none',
    },
    animationDuration: '0.6s',
    animationTimingFunction: 'linear',
    animationIterationCount: 'infinite',
  },
  srOnly: {
    position: 'absolute',
    width: 1,
    height: 1,
    overflow: 'hidden',
    clip: 'rect(0 0 0 0)',
    whiteSpace: 'nowrap',
  },
})

export function Spinner({ size = 20, label }: SpinnerProps): ReactNode {
  const { t } = useLingui()
  const text = label ?? t`Loading`

  return (
    <span role="status" aria-live="polite" {...stylex.props(styles.wrapper)}>
      <span
        aria-hidden="true"
        {...stylex.props(styles.ring)}
        style={{ width: size, height: size }}
      />
      <span {...stylex.props(styles.srOnly)}>{text}</span>
    </span>
  )
}
