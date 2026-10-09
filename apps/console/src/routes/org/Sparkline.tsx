// 迷你折线只表达走势,数值已在同一行以文字给出,所以对读屏隐藏。

import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'

const WIDTH = 160
const HEIGHT = 32
const INSET = 3

const styles = stylex.create({
  svg: {
    display: 'block',
    flexShrink: 0,
    width: { default: '6.5rem', '@media (min-width: 48rem)': '10rem' },
    height: '2rem',
    overflow: 'visible',
  },
  line: {
    fill: 'none',
    stroke: tokens['--xid-muted-foreground'],
    strokeWidth: 1.6,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    vectorEffect: 'non-scaling-stroke',
  },
})

export function sparklinePoints(series: readonly number[]): string {
  if (series.length === 0) return ''
  const max = Math.max(...series)
  const min = Math.min(...series)
  const span = max - min
  const step = series.length > 1 ? WIDTH / (series.length - 1) : 0
  return series
    .map((value, index) => {
      const ratio = span === 0 ? 0.5 : (value - min) / span
      const y = HEIGHT - INSET - ratio * (HEIGHT - INSET * 2)
      return `${Math.round(index * step * 10) / 10},${Math.round(y * 10) / 10}`
    })
    .join(' ')
}

export function Sparkline({ series }: { series: readonly number[] }): ReactNode {
  const points =
    series.length === 1 ? `0,${HEIGHT / 2} ${WIDTH},${HEIGHT / 2}` : sparklinePoints(series)
  return (
    <svg
      aria-hidden="true"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      preserveAspectRatio="none"
      {...stylex.props(styles.svg)}
    >
      <polyline points={points} {...stylex.props(styles.line)} />
    </svg>
  )
}
