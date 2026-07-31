// platform console 概览页:全局 DAU/MAU、组织总数、全局登录成功率 + 趋势图表。
// 组织总数/用户总数由 MetricsBand side 承载,不再重复出第二组(同概念同权重,不重复占位)。
// 数据从 GET /v1/platform/stats 拉取(TanStack Query)。
// 版式走 ConsolePage 骨架(web-ui):display 页头 + hairline 分节;空态走 EmptyState。

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
