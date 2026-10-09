// 登录活动:月活、成功登录、失败登录三行,每行是本期数值、与上月同期的比较和走势线。
// 手机只保留月活和失败登录,数值叠在标签下方。

import { Trans, useLingui } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import type { I18n, MessageDescriptor } from '@lingui/core'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Button, Skeleton } from '@xid-kit/web-ui/ui'
import { Link } from '@xid-kit/web-ui/tanstack-router'
import { leading, text, weight } from '@xid-kit/web-ui/styles/scale.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import type { ActivityMetric, ActivityMetricKey, SignInActivity } from './overview-queries'
import { Sparkline } from './Sparkline'
import { section } from './AttentionList'

const METRIC_LABELS: Record<ActivityMetricKey, MessageDescriptor> = {
  mau: msg`Monthly active users`,
  sign_in_succeeded: msg`Successful sign-ins`,
  sign_in_failed: msg`Failed sign-ins`,
}

const styles = stylex.create({
  row: {
    display: 'grid',
    alignItems: 'center',
    columnGap: '1.25rem',
    gridTemplateColumns: {
      default: 'minmax(0, 1fr) auto',
      '@media (min-width: 48rem)': 'minmax(0, 1fr) 7.5rem 12.5rem auto',
    },
    gridTemplateAreas: {
      default: '"label spark" "value spark" "delta spark"',
      '@media (min-width: 48rem)': '"label value delta spark"',
    },
    minHeight: '3rem',
    paddingBlock: { default: '0.875rem', '@media (min-width: 48rem)': '0.5rem' },
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  hideNarrow: {
    display: { default: 'none', '@media (min-width: 48rem)': 'grid' },
  },
  label: {
    gridArea: 'label',
    margin: 0,
    color: {
      default: tokens['--xid-muted-foreground'],
      '@media (min-width: 48rem)': tokens['--xid-fg'],
    },
    fontSize: { default: text.sm, '@media (min-width: 48rem)': text.base },
    lineHeight: leading.sm,
  },
  value: {
    gridArea: 'value',
    margin: 0,
    color: tokens['--xid-fg'],
    fontSize: text.lg,
    fontWeight: weight.medium,
    letterSpacing: tokens['--xid-tracking-title'],
    lineHeight: leading.md,
    fontVariantNumeric: 'tabular-nums',
    textAlign: { default: 'start', '@media (min-width: 48rem)': 'end' },
  },
  delta: {
    gridArea: 'delta',
    margin: 0,
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
    lineHeight: leading.xs,
    fontVariantNumeric: 'tabular-nums',
  },
  deltaWarning: {
    color: tokens['--xid-warning-foreground'],
  },
  spark: {
    gridArea: 'spark',
    justifySelf: 'end',
  },
  wideOnly: {
    display: { default: 'none', '@media (min-width: 48rem)': 'inline' },
  },
  narrowOnly: {
    display: { default: 'inline', '@media (min-width: 48rem)': 'none' },
  },
  usageFooter: {
    display: { default: 'flex', '@media (min-width: 48rem)': 'none' },
    justifyContent: 'center',
    paddingTop: '1rem',
  },
  usageHead: {
    display: { default: 'none', '@media (min-width: 48rem)': 'inline' },
    marginInlineStart: 'auto',
    flexShrink: 0,
  },
  link: {
    color: tokens['--xid-accent'],
    fontSize: { default: text.base, '@media (min-width: 48rem)': text.sm },
    lineHeight: leading.xs,
    textDecoration: { default: 'none', ':hover': 'underline' },
  },
  emptyText: {
    margin: 0,
    paddingBlock: '1rem',
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
    lineHeight: leading.base,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  errorRow: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '0.75rem',
    paddingBlock: '1rem',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
  },
})

function dayDate(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`)
}

function rangeLabel(i18n: I18n, from: string, to: string, month: 'long' | 'short'): string {
  const start = dayDate(from)
  const end = dayDate(to)
  const sameMonth = start.getUTCMonth() === end.getUTCMonth()
  const startText = i18n.date(start, { month, day: 'numeric', timeZone: 'UTC' })
  const endText = sameMonth
    ? i18n.date(end, { day: 'numeric', timeZone: 'UTC' })
    : i18n.date(end, { month, day: 'numeric', timeZone: 'UTC' })
  return i18n._(msg`${startText} to ${endText}`)
}

function percentChange(i18n: I18n, value: number, previous: number): string {
  const ratio = Math.abs(value - previous) / previous
  return i18n.number(ratio, {
    style: 'percent',
    maximumFractionDigits: ratio < 0.1 ? 1 : 0,
  })
}

function MetricDelta({ metric }: { metric: ActivityMetric }): ReactNode {
  const { i18n } = useLingui()
  const previous = i18n.number(metric.previousValue)
  const rising = metric.value > metric.previousValue
  const warn = metric.key === 'sign_in_failed' && rising
  let label: ReactNode
  if (metric.value === metric.previousValue) {
    label = <Trans>Same as {previous}</Trans>
  } else if (metric.previousValue === 0) {
    label = <Trans>Up from {previous}</Trans>
  } else {
    const change = percentChange(i18n, metric.value, metric.previousValue)
    label = rising ? (
      <Trans>
        Up {change} from {previous}
      </Trans>
    ) : (
      <Trans>
        Down {change} from {previous}
      </Trans>
    )
  }
  return <p {...stylex.props(styles.delta, warn && styles.deltaWarning)}>{label}</p>
}

function MetricRow({ metric }: { metric: ActivityMetric }): ReactNode {
  const { i18n } = useLingui()
  return (
    <div
      role="listitem"
      {...stylex.props(styles.row, metric.key === 'sign_in_succeeded' && styles.hideNarrow)}
    >
      <p {...stylex.props(styles.label)}>{i18n._(METRIC_LABELS[metric.key])}</p>
      <p {...stylex.props(styles.value)}>{i18n.number(metric.value)}</p>
      <MetricDelta metric={metric} />
      <span {...stylex.props(styles.spark)}>
        <Sparkline series={metric.series} />
      </span>
    </div>
  )
}

function UsageLink({ variant }: { variant: 'head' | 'footer' }): ReactNode {
  return (
    <span {...stylex.props(variant === 'head' ? styles.usageHead : styles.usageFooter)}>
      <Link to="/console/platform/usage" {...stylex.props(styles.link)}>
        <Trans>Open usage</Trans>
      </Link>
    </span>
  )
}

export type SignInActivitySectionProps = {
  orgName: ReactNode
  activity: SignInActivity | undefined
  isLoading: boolean
  isError: boolean
  onRetry: () => void
  showUsageLink: boolean
}

export function SignInActivitySection({
  orgName,
  activity,
  isLoading,
  isError,
  onRetry,
  showUsageLink,
}: SignInActivitySectionProps): ReactNode {
  const { i18n } = useLingui()
  const period = activity
    ? {
        long: rangeLabel(i18n, activity.period.from, activity.period.to, 'long'),
        short: rangeLabel(i18n, activity.period.from, activity.period.to, 'short'),
        previousShort: rangeLabel(i18n, activity.previous.from, activity.previous.to, 'short'),
        previousMonth: i18n.date(dayDate(activity.previous.to), { month: 'long', timeZone: 'UTC' }),
      }
    : null
  return (
    <section aria-labelledby="sign-in-activity-heading" {...stylex.props(section.root)}>
      <header {...stylex.props(section.head)}>
        <h2 id="sign-in-activity-heading" {...stylex.props(section.title)}>
          <Trans>Sign-in activity</Trans>
        </h2>
        {period ? (
          <p {...stylex.props(section.meta)}>
            <span {...stylex.props(styles.wideOnly)}>
              <Trans>
                {period.long}, compared with the same days of {period.previousMonth}. Counts cover
                all of {orgName}.
              </Trans>
            </span>
            <span {...stylex.props(styles.narrowOnly)}>
              <Trans>
                {period.short}, compared with {period.previousShort}. Counts cover all of {orgName}.
              </Trans>
            </span>
          </p>
        ) : null}
        {showUsageLink ? <UsageLink variant="head" /> : null}
      </header>
      {isLoading ? (
        <div aria-busy="true" role="status">
          {[0, 1, 2].map((index) => (
            <div key={index} {...stylex.props(styles.row)}>
              <Skeleton width="10rem" height="1rem" />
            </div>
          ))}
        </div>
      ) : isError ? (
        <div role="alert" {...stylex.props(styles.errorRow)}>
          <span>
            <Trans>Sign-in activity didn't load. Nothing was lost; try again in a moment.</Trans>
          </span>
          <Button variant="secondary" onClick={onRetry}>
            <Trans>Try again</Trans>
          </Button>
        </div>
      ) : activity ? (
        <div role="list">
          {activity.metrics.map((metric) => (
            <MetricRow key={metric.key} metric={metric} />
          ))}
        </div>
      ) : null}
      {showUsageLink && activity ? <UsageLink variant="footer" /> : null}
    </section>
  )
}

export function SignInActivityPending({ orgName }: { orgName: ReactNode }): ReactNode {
  return (
    <section aria-labelledby="sign-in-activity-heading" {...stylex.props(section.root)}>
      <header {...stylex.props(section.head)}>
        <h2 id="sign-in-activity-heading" {...stylex.props(section.title)}>
          <Trans>Sign-in activity</Trans>
        </h2>
        <p {...stylex.props(section.meta)}>
          <Trans>Appears after the first person signs in</Trans>
        </p>
      </header>
      <p {...stylex.props(styles.emptyText)}>
        <Trans>
          Monthly active users and sign-in success for all of {orgName} appear here once people
          start signing in. Each figure is compared with the previous period.
        </Trans>
      </p>
    </section>
  )
}

export function hasSignInActivity(activity: SignInActivity): boolean {
  return activity.metrics.some((metric) => metric.value > 0 || metric.previousValue > 0)
}
