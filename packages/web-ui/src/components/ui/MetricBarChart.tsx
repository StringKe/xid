// MetricBarChart:轻量当前指标条形图,不依赖图表库。
// 用于首版 overview 页面展示已由 API 返回的真实聚合值。

import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'

export type MetricBarChartItem = {
  label: ReactNode
  value: number
  displayValue: ReactNode
  tone?: 'primary' | 'success' | 'danger' | 'neutral'
}

export type MetricBarChartProps = {
  title: ReactNode
  items: readonly MetricBarChartItem[]
  maxValue?: number
}

const styles = stylex.create({
  figure: {
    margin: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: '0.875rem',
    fontFamily: tokens['--xid-font'],
  },
  // 图表标题 = mono microlabel(与表头/指标带 label 同一签名)。
  title: {
    margin: 0,
    fontFamily: tokens['--xid-font-mono'],
    fontSize: '0.6875rem',
    fontWeight: 500,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: tokens['--xid-muted-foreground'],
  },
  list: {
    margin: 0,
    padding: 0,
    listStyle: 'none',
    display: 'flex',
    flexDirection: 'column',
    gap: '0.625rem',
  },
  row: {
    display: 'grid',
    gridTemplateColumns: 'minmax(7rem, 1fr) minmax(8rem, 2fr) auto',
    alignItems: 'center',
    gap: '0.75rem',
    minHeight: '1.5rem',
  },
  label: {
    fontSize: '0.8125rem',
    color: tokens['--xid-muted-foreground'],
  },
  value: {
    fontSize: '0.8125rem',
    fontWeight: 550,
    fontVariantNumeric: 'tabular-nums',
    color: tokens['--xid-fg'],
    textAlign: 'right',
    whiteSpace: 'nowrap',
  },
  // 方头条形(无圆角):技术图表语言,撤 pill 感。
  track: {
    height: '0.5rem',
    backgroundColor: tokens['--xid-muted'],
    overflow: 'hidden',
  },
  bar: {
    height: '100%',
  },
})

const TONE_COLOR: Record<NonNullable<MetricBarChartItem['tone']>, string> = {
  primary: 'var(--xid-primary)',
  success: 'var(--xid-success)',
  danger: 'var(--xid-danger)',
  neutral: 'var(--xid-muted-foreground)',
}

export function MetricBarChart({ title, items, maxValue }: MetricBarChartProps): ReactNode {
  const computedMax = Math.max(maxValue ?? 0, ...items.map((item) => item.value), 1)

  return (
    <figure {...stylex.props(styles.figure)}>
      <figcaption {...stylex.props(styles.title)}>{title}</figcaption>
      <ul {...stylex.props(styles.list)}>
        {items.map((item, index) => {
          const width = `${Math.max(0, Math.min(100, (item.value / computedMax) * 100)).toFixed(1)}%`
          const color = TONE_COLOR[item.tone ?? 'primary']
          return (
            <li key={index} {...stylex.props(styles.row)}>
              <span {...stylex.props(styles.label)}>{item.label}</span>
              <span
                {...stylex.props(styles.track)}
                role="meter"
                aria-valuemin={0}
                aria-valuemax={computedMax}
                aria-valuenow={item.value}
              >
                <span
                  aria-hidden="true"
                  {...stylex.props(styles.bar)}
                  style={{ width, backgroundColor: color }}
                />
              </span>
              <span {...stylex.props(styles.value)}>{item.displayValue}</span>
            </li>
          )
        })}
      </ul>
    </figure>
  )
}
