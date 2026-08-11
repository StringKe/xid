// 组织/用户总数走 MetricsBand side,勿再挂第二组同权重指标。

import { Trans, useLingui } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Alert, EmptyState, Spinner } from '@xid-kit/web-ui/ui'
import { ConsolePage, ConsolePageNotice, ConsolePageSection } from '@xid-kit/web-ui/ui'
import { MetricBarChart } from '@xid-kit/web-ui/ui/MetricBarChart'
import { page } from '@xid-kit/web-ui/styles/product-surface.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { useApiQuery } from '@xid-kit/web-ui/queries'
import { PlatformMetricsBand } from './PlatformOverviewMetrics'
import type { PlatformStats } from './PlatformOverviewMetrics'

const styles = stylex.create({
  chartStack: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1.75rem',
  },
  chartDivided: {
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
    paddingTop: '1.75rem',
  },
})

function ActiveUserRatioChart({ data }: { data: PlatformStats }): ReactNode {
  return (
    <MetricBarChart
      title={<Trans>Active user ratio</Trans>}
      maxValue={Math.max(data.mau, 1)}
      items={[
        {
          label: <Trans>Daily active users</Trans>,
          value: data.dau,
          displayValue: data.dau.toLocaleString(),
          tone: 'primary',
        },
        {
          label: <Trans>Monthly active users</Trans>,
          value: data.mau,
          displayValue: data.mau.toLocaleString(),
          tone: 'success',
        },
      ]}
    />
  )
}

function OperationalRatesChart({ data }: { data: PlatformStats }): ReactNode {
  return (
    <MetricBarChart
      title={<Trans>Operational rates</Trans>}
      maxValue={1}
      items={[
        {
          label: <Trans>Login success rate</Trans>,
          value: data.loginSuccessRate,
          displayValue: `${(data.loginSuccessRate * 100).toFixed(1)}%`,
          tone: data.loginSuccessRate >= 0.95 ? 'success' : 'danger',
        },
        {
          label: <Trans>Active organizations</Trans>,
          value: data.organizationCount > 0 ? data.activeOrgCount / data.organizationCount : 0,
          displayValue: `${data.activeOrgCount.toLocaleString()} / ${data.organizationCount.toLocaleString()}`,
          tone: 'primary',
        },
      ]}
    />
  )
}

function PlatformStatsSections({ data }: { data: PlatformStats }): ReactNode {
  return (
    <>
      <ConsolePageSection title={<Trans>Global metrics</Trans>}>
        <PlatformMetricsBand data={data} />
      </ConsolePageSection>

      <ConsolePageSection title={<Trans>Trends</Trans>}>
        <div {...stylex.props(styles.chartStack)}>
          <ActiveUserRatioChart data={data} />
          <div {...stylex.props(styles.chartDivided)}>
            <OperationalRatesChart data={data} />
          </div>
        </div>
      </ConsolePageSection>
    </>
  )
}

export default function PlatformAdminOverview(): ReactNode {
  const { t } = useLingui()
  const { data, isLoading, isError } = useApiQuery<PlatformStats>(
    ['platform', 'stats'] as const,
    '/v1/platform/stats',
  )

  return (
    <ConsolePage
      title={<Trans>Platform overview</Trans>}
      lead={<Trans>Sign-in activity, organizations, and usage across this instance.</Trans>}
    >
      {isError ? (
        <ConsolePageNotice>
          <Alert tone="error">
            <Trans>Failed to load platform stats. Please try again.</Trans>
          </Alert>
        </ConsolePageNotice>
      ) : null}

      {isLoading ? (
        <div {...stylex.props(page.loadingCenter)}>
          <Spinner label={t`Loading platform stats`} />
        </div>
      ) : data ? (
        <PlatformStatsSections data={data} />
      ) : !isError ? (
        <ConsolePageSection>
          <EmptyState title={<Trans>No platform stats available.</Trans>} />
        </ConsolePageSection>
      ) : null}
    </ConsolePage>
  )
}
