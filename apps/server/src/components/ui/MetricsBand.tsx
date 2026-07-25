// MetricsBand:overview 页全宽指标带(ledger 语言)-- 上下 1px hairline 收束,横贯内容列全宽。
// 全宽壳(零 padding)规范下 gutter 由带内自持;指标等宽分布(repeat(4, 1fr)),宽屏指标间 1px 竖分隔;
// 数值字号随视口 clamp 上探(1440-2860 主力区间),tabular-nums。
// side(可选):次要计数行列表,挂带尾定宽列(15-18rem);不传则纯指标带。
// 文案零持有:label/term 由调用方传入(已本地化)。消费方:Org/PlatformOverviewMetrics 数据映射层。

import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'

export type MetricsBandItem = {
  label: ReactNode
  value: string
  size: 'lg' | 'md'
  tone?: 'good' | 'bad'
}

export type MetricsBandSideItem = {
  term: ReactNode
  value: string
}

export type MetricsBandProps = {
  items: readonly MetricsBandItem[]
  side?: readonly MetricsBandSideItem[]
}

// 内容列水平 gutter:与 ConsoleLayout 零 padding 壳的页面节同口径。
const GUTTER = 'clamp(1rem, 2.5vw, 4rem)'

const styles = stylex.create({
  // 指标带:上下 1px hairline 收束,不做独立卡片。
  // 小屏 2 列网格;宽屏 4 等列横贯全宽(带 side 时尾挂定宽行列表列)。
  band: {
    display: 'grid',
    gridTemplateColumns: {
      default: 'repeat(2, minmax(0, 1fr))',
      '@media (min-width: 64rem)': 'repeat(4, minmax(0, 1fr))',
    },
    alignItems: 'end',
    columnGap: {
      default: '1.5rem',
      '@media (min-width: 64rem)': '0',
    },
    rowGap: '1.25rem',
    paddingBlock: 'clamp(1.375rem, 1.5vw, 2.25rem)',
    paddingInline: GUTTER,
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  bandWithSide: {
    gridTemplateColumns: {
      default: 'repeat(2, minmax(0, 1fr))',
      '@media (min-width: 64rem)': 'repeat(4, minmax(0, 1fr)) minmax(15rem, 18rem)',
    },
  },
  metric: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.625rem',
    minWidth: 0,
    paddingInlineEnd: {
      default: '0',
      '@media (min-width: 64rem)': '2.5rem',
    },
  },
  // 宽屏指标间 1px 竖分隔(小屏靠网格间距,免折行残线)。
  metricDivided: {
    borderInlineStartWidth: {
      default: '0',
      '@media (min-width: 64rem)': '1px',
    },
    borderInlineStartStyle: 'solid',
    borderInlineStartColor: tokens['--xid-border'],
    paddingInlineStart: {
      default: '0',
      '@media (min-width: 64rem)': '2.5rem',
    },
  },
  // mono microlabel:与 DataTable 表头 / 图表标题同一签名。
  metricLabel: {
    margin: 0,
    fontFamily: tokens['--xid-font-mono'],
    fontSize: '0.6875rem',
    fontWeight: 500,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: tokens['--xid-muted-foreground'],
  },
  // 字号做功、字重退后;tabular-nums 数字对齐。
  metricValue: {
    margin: 0,
    fontVariantNumeric: 'tabular-nums',
    color: tokens['--xid-fg'],
    lineHeight: 1.05,
    letterSpacing: '-0.02em',
  },
  metricValueLg: {
    fontSize: 'clamp(2rem, 1.1rem + 1.25vw, 2.875rem)',
    fontWeight: 450,
  },
  metricValueMd: {
    fontSize: 'clamp(1.375rem, 0.95rem + 0.65vw, 1.875rem)',
    fontWeight: 500,
  },
  valueGood: {
    color: tokens['--xid-success'],
  },
  valueBad: {
    color: tokens['--xid-danger'],
  },
  // 次要计数行列表:label 左 / 数值右,行间 hairline。小屏整行垫底,宽屏挂带尾竖分隔。
  sideList: {
    margin: 0,
    gridColumn: {
      default: '1 / -1',
      '@media (min-width: 64rem)': 'auto',
    },
    justifySelf: {
      default: 'stretch',
      '@media (min-width: 64rem)': 'end',
    },
    alignSelf: {
      default: 'auto',
      '@media (min-width: 64rem)': 'center',
    },
    width: '100%',
    borderTopWidth: {
      default: '1px',
      '@media (min-width: 64rem)': '0',
    },
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
    borderInlineStartWidth: {
      default: '0',
      '@media (min-width: 64rem)': '1px',
    },
    borderInlineStartStyle: 'solid',
    borderInlineStartColor: tokens['--xid-border'],
    paddingTop: {
      default: '1rem',
      '@media (min-width: 64rem)': '0',
    },
    paddingInlineStart: {
      default: '0',
      '@media (min-width: 64rem)': '1.75rem',
    },
  },
  sideRow: {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: '1rem',
    // hairline 邻接 >= 1.25rem:行文本与上下分隔线各保 1.25rem(与 Section row / DataTable cell 同口径)
    paddingBlock: '1.25rem',
  },
  sideRowDivided: {
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
  },
  sideTerm: {
    fontSize: '0.8125rem',
    color: tokens['--xid-muted-foreground'],
  },
  sideValue: {
    margin: 0,
    fontSize: '0.875rem',
    fontWeight: 550,
    fontVariantNumeric: 'tabular-nums',
    color: tokens['--xid-fg'],
  },
})

type MetricProps = MetricsBandItem & { divided: boolean }

function Metric({ label, value, size, tone, divided }: MetricProps): ReactNode {
  return (
    <div {...stylex.props(styles.metric, divided && styles.metricDivided)}>
      <p {...stylex.props(styles.metricLabel)}>{label}</p>
      <p
        {...stylex.props(
          styles.metricValue,
          size === 'lg' ? styles.metricValueLg : styles.metricValueMd,
          tone === 'good' && styles.valueGood,
          tone === 'bad' && styles.valueBad,
        )}
      >
        {value}
      </p>
    </div>
  )
}

export function MetricsBand({ items, side }: MetricsBandProps): ReactNode {
  const hasSide = Boolean(side && side.length > 0)
  return (
    <div {...stylex.props(styles.band, hasSide && styles.bandWithSide)}>
      {items.map((item, index) => (
        <Metric key={index} {...item} divided={index > 0} />
      ))}
      {hasSide && side ? (
        <dl {...stylex.props(styles.sideList)}>
          {side.map((entry, index) => (
            <div key={index} {...stylex.props(styles.sideRow, index > 0 && styles.sideRowDivided)}>
              <dt {...stylex.props(styles.sideTerm)}>{entry.term}</dt>
              <dd {...stylex.props(styles.sideValue)}>{entry.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  )
}
