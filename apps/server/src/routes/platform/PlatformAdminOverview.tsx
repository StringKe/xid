// platform console 概览页:全局 DAU/MAU、组织总数、全局登录成功率 + 趋势图表。
// 全宽锚定版式(对齐 OrgOverview):display 标题 -> 指标带横贯全宽(hairline 收束) -> 趋势图全宽。
// 组织总数/用户总数由 MetricsBand side 承载,不再重复出第二组(同概念同权重,不重复占位)。
// 数据从 GET /v1/platform/stats 拉取(TanStack Query)。

import { Trans, useLingui } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Alert, Spinner } from '../../components/ui'
import { MetricBarChart } from '../../components/ui/MetricBarChart'
import { page } from '../../styles/product-surface.stylex'
import { tokens } from '../../styles/tokens.stylex'
import { useApiQuery } from '../../lib/queries'
import { PlatformMetricsBand } from './PlatformOverviewMetrics'
import type { PlatformStats } from './PlatformOverviewMetrics'

const GUTTER = 'clamp(1rem, 2.5vw, 4rem)'
const SECTION_PAD = 'clamp(1.5rem, 1.6vw, 2.5rem)'

const styles = stylex.create({
  root: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    paddingBottom: 'clamp(2rem, 3vw, 4rem)',
  },
  headerZone: {
    paddingInline: GUTTER,
    paddingTop: 'clamp(1.75rem, 2vw, 3rem)',
    paddingBottom: 'clamp(1.25rem, 1.5vw, 2rem)',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  title: {
    margin: 0,
    fontSize: 'clamp(1.75rem, 1.05rem + 1.5vw, 2.75rem)',
    fontWeight: 620,
    lineHeight: 1.05,
    letterSpacing: '-0.03em',
    color: tokens['--xid-fg'],
    textWrap: 'balance',
  },
  bandLabel: {
    paddingInline: GUTTER,
    // hairline 邻接 >= 1.25rem:microlabel 文本到 MetricsBand 顶线(内联副本需同步 OrgOverview 口径)
    marginBottom: '1.25rem',
  },
  // 下区:趋势图表全宽,底缘 1px 收束。
  trendsSection: {
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  trendsCol: {
    minWidth: 0,
    paddingBlock: SECTION_PAD,
    paddingInline: GUTTER,
  },
  trendsLabel: {
    marginBottom: '1.5rem',
  },
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
  messageZone: {
    paddingInline: GUTTER,
    paddingBlock: '1.5rem',
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
      <section aria-labelledby="platform-stats-heading">
        <h2 id="platform-stats-heading" {...stylex.props(page.sectionLabel, styles.bandLabel)}>
          <Trans>Global metrics</Trans>
        </h2>
        <PlatformMetricsBand data={data} />
      </section>

      <section
        aria-labelledby="platform-charts-heading"
        {...stylex.props(styles.trendsSection, styles.trendsCol)}
      >
        <h2 id="platform-charts-heading" {...stylex.props(page.sectionLabel, styles.trendsLabel)}>
          <Trans>Trends</Trans>
        </h2>
        <div {...stylex.props(styles.chartStack)}>
          <ActiveUserRatioChart data={data} />
          <div {...stylex.props(styles.chartDivided)}>
            <OperationalRatesChart data={data} />
          </div>
        </div>
      </section>
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
    <div {...stylex.props(styles.root)}>
      <div {...stylex.props(styles.headerZone)}>
        <h1 {...stylex.props(styles.title)}>
          <Trans>Platform overview</Trans>
        </h1>
      </div>

      {isLoading ? (
        <div {...stylex.props(page.loadingCenter)}>
          <Spinner label={t`Loading platform stats`} />
        </div>
      ) : isError ? (
        <div {...stylex.props(styles.messageZone)}>
          <Alert tone="error">
            <Trans>Failed to load platform stats. Please try again.</Trans>
          </Alert>
        </div>
      ) : data ? (
        <PlatformStatsSections data={data} />
      ) : null}
    </div>
  )
}
