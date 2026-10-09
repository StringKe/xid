import type { I18n } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import * as stylex from '@stylexjs/stylex'
import type { ReactNode } from 'react'
import { text, weight } from '@xid-kit/web-ui/styles/scale.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import type { PlatformActivityKey, PlatformActivityMetric } from './ops-queries'

const NARROW = '@media (max-width: 40rem)'

const styles = stylex.create({
  table: {
    margin: 0,
    padding: 0,
    listStyle: 'none',
  },
  row: {
    display: 'grid',
    gridTemplateColumns: {
      default: 'minmax(0, 1fr) 8.5rem 8.5rem 7rem',
      [NARROW]: 'minmax(0, 1fr) auto',
    },
    columnGap: '1rem',
    alignItems: 'center',
    paddingBlock: '0.625rem',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  head: {
    paddingBlock: '0.5rem',
    color: tokens['--xid-muted-foreground'],
    fontSize: text.xs,
    display: { default: 'grid', [NARROW]: 'none' },
  },
  label: {
    margin: 0,
    color: tokens['--xid-fg'],
    fontSize: text.base,
  },
  sublabel: {
    margin: '0.125rem 0 0',
    color: tokens['--xid-muted-foreground'],
    fontSize: text.xs,
  },
  wideOnly: {
    display: { default: 'block', [NARROW]: 'none' },
  },
  narrowOnly: {
    display: { default: 'none', [NARROW]: 'block' },
  },
  number: {
    textAlign: 'end',
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
  },
  now: {
    color: tokens['--xid-fg'],
    fontSize: { default: text.base, [NARROW]: text.md },
    fontWeight: weight.display,
  },
  previous: {
    color: tokens['--xid-muted-foreground'],
    fontSize: text.base,
    display: { default: 'block', [NARROW]: 'none' },
  },
  change: {
    color: tokens['--xid-fg'],
    fontSize: { default: text.base, [NARROW]: text.xs },
  },
  narrowChange: {
    display: { default: 'none', [NARROW]: 'block' },
    color: tokens['--xid-muted-foreground'],
    fontSize: text.xs,
    textAlign: 'end',
  },
  wideChange: {
    display: { default: 'block', [NARROW]: 'none' },
  },
})

export function formatLoginSuccessRate(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`
}

function utcMonthName(i18n: I18n, date: Date): string {
  return i18n.date(date, { month: 'long', timeZone: 'UTC' })
}

function previousMonthEnd(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0))
}

function formatValue(i18n: I18n, key: PlatformActivityKey, value: number | null): string | null {
  if (value === null) return null
  if (key === 'login_success_rate') return formatLoginSuccessRate(value)
  return i18n.number(value)
}

function signed(i18n: I18n, value: number, options: Intl.NumberFormatOptions = {}): string {
  return i18n.number(value, { signDisplay: 'exceptZero', ...options })
}

function changeFor(i18n: I18n, metric: PlatformActivityMetric): string | null {
  const { now, previous } = metric
  if (now === null || previous === null) return null
  if (metric.key === 'login_success_rate') {
    const points = signed(i18n, (now - previous) * 100, { maximumFractionDigits: 1 })
    return i18n._(msg`${points} pts`)
  }
  if (metric.key === 'organizations') return signed(i18n, now - previous)
  if (previous === 0) return null
  if (metric.key === 'mau') {
    const share = i18n.number(now / previous, { style: 'percent' })
    const month = utcMonthName(i18n, previousMonthEnd(new Date()))
    return i18n._(msg`${share} of ${month}`)
  }
  return signed(i18n, (now - previous) / previous, { style: 'percent', maximumFractionDigits: 1 })
}

type MetricCopy = { label: ReactNode; wide: ReactNode; narrow: ReactNode; narrowChange?: ReactNode }

function metricCopy(i18n: I18n, metric: PlatformActivityMetric): MetricCopy {
  const previous = formatValue(i18n, metric.key, metric.previous) ?? ''
  const today = new Date()
  const month = utcMonthName(i18n, today)
  const previousMonth = utcMonthName(i18n, previousMonthEnd(today))
  const cutoff = i18n.date(previousMonthEnd(today), {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
  switch (metric.key) {
    case 'dau':
      return {
        label: <Trans>Daily active users</Trans>,
        wide: <Trans>Today against yesterday</Trans>,
        narrow: <Trans>{previous} yesterday</Trans>,
      }
    case 'mau':
      return {
        label: <Trans>Monthly active users</Trans>,
        wide: (
          <Trans>
            {month} so far against all of {previousMonth}
          </Trans>
        ),
        narrow: (
          <Trans>
            {previous} in all of {previousMonth}
          </Trans>
        ),
        narrowChange: <Trans>{month} so far</Trans>,
      }
    case 'login_success_rate':
      return {
        label: <Trans>Sign-in success rate</Trans>,
        wide: <Trans>Last 30 days against the 30 days before</Trans>,
        narrow: <Trans>{previous} the 30 days before</Trans>,
      }
    case 'organizations':
      return {
        label: <Trans>Organizations</Trans>,
        wide: <Trans>Now against {cutoff}</Trans>,
        narrow: (
          <Trans>
            {previous} on {cutoff}
          </Trans>
        ),
      }
    case 'users':
      return {
        label: <Trans>Users</Trans>,
        wide: <Trans>Now against {cutoff}</Trans>,
        narrow: (
          <Trans>
            {previous} on {cutoff}
          </Trans>
        ),
      }
  }
}

export function PlatformActivityTable({
  metrics,
}: {
  metrics: readonly PlatformActivityMetric[]
}): ReactNode {
  const { i18n, t } = useLingui()
  return (
    <div role="table" aria-label={t`Activity`} {...stylex.props(styles.table)}>
      <div role="row" {...stylex.props(styles.row, styles.head)}>
        <span role="columnheader">
          <Trans>Metric</Trans>
        </span>
        <span role="columnheader" {...stylex.props(styles.number)}>
          <Trans>Now</Trans>
        </span>
        <span role="columnheader" {...stylex.props(styles.number)}>
          <Trans>Previous</Trans>
        </span>
        <span role="columnheader" {...stylex.props(styles.number)}>
          <Trans>Change</Trans>
        </span>
      </div>
      {metrics.map((metric) => {
        const copy = metricCopy(i18n, metric)
        const now = formatValue(i18n, metric.key, metric.now) ?? t`No data`
        const change = changeFor(i18n, metric)
        return (
          <div role="row" key={metric.key} {...stylex.props(styles.row)}>
            <div role="cell">
              <p {...stylex.props(styles.label)}>{copy.label}</p>
              <p {...stylex.props(styles.sublabel, styles.wideOnly)}>{copy.wide}</p>
              <p {...stylex.props(styles.sublabel, styles.narrowOnly)}>{copy.narrow}</p>
            </div>
            <div role="cell" {...stylex.props(styles.number, styles.now)}>
              {now}
              <span {...stylex.props(styles.narrowChange)}>{copy.narrowChange ?? change}</span>
            </div>
            <div role="cell" {...stylex.props(styles.number, styles.previous)}>
              {formatValue(i18n, metric.key, metric.previous)}
            </div>
            <div role="cell" {...stylex.props(styles.number, styles.change, styles.wideChange)}>
              {change}
            </div>
          </div>
        )
      })}
    </div>
  )
}
