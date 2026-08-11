import { Trans, useLingui } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Alert, Spinner } from '@xid-kit/web-ui/ui'
import { ConsolePage, ConsolePageNotice } from '@xid-kit/web-ui/ui'
import { MetricBarChart } from '@xid-kit/web-ui/ui/MetricBarChart'
import { page } from '@xid-kit/web-ui/styles/product-surface.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { useApiQuery } from '@xid-kit/web-ui/queries'
import { MetricsBand, SecondaryCounts } from './OrgOverviewMetrics'
import type { OrgStats } from './OrgOverviewMetrics'
import { useCanManageOrg, useOrgTarget } from './useOrgTarget'

// gutter/节距与 ConsoleLayout、MetricsBand 同源。
const GUTTER = 'clamp(1rem, 2.5vw, 4rem)'
const SECTION_PAD = 'clamp(1.5rem, 1.6vw, 2.5rem)'
const CROSS_GAP = 'clamp(1.75rem, 2vw, 3.5rem)'

const styles = stylex.create({
  bandLabel: {
    paddingInline: GUTTER,
    // microlabel 与 MetricsBand 顶线 hairline 邻接下限。
    marginBottom: '1.25rem',
  },
  lowerGrid: {
    display: 'grid',
    gridTemplateColumns: {
      default: '1fr',
      '@media (min-width: 64rem)': 'minmax(0, 7fr) minmax(0, 5fr)',
    },
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  trendsCol: {
    minWidth: 0,
    paddingBlock: SECTION_PAD,
    paddingInlineStart: GUTTER,
    paddingInlineEnd: {
      default: GUTTER,
      '@media (min-width: 64rem)': CROSS_GAP,
    },
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
  countsCol: {
    minWidth: 0,
    paddingBlock: SECTION_PAD,
    paddingInlineEnd: GUTTER,
    paddingInlineStart: {
      default: GUTTER,
      '@media (min-width: 64rem)': CROSS_GAP,
    },
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
  },
})

function ActiveUserRatioChart({ data }: { data: OrgStats }): ReactNode {
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

function SecurityRatesChart({ data }: { data: OrgStats }): ReactNode {
  return (
    <MetricBarChart
      title={<Trans>Security rates</Trans>}
      maxValue={1}
      items={[
        {
          label: <Trans>Login success rate</Trans>,
          value: data.loginSuccessRate,
          displayValue: `${(data.loginSuccessRate * 100).toFixed(1)}%`,
          tone: data.loginSuccessRate >= 0.95 ? 'success' : 'danger',
        },
        {
          label: <Trans>MFA adoption</Trans>,
          value: data.mfaAdoptionRate,
          displayValue: `${(data.mfaAdoptionRate * 100).toFixed(1)}%`,
          tone: data.mfaAdoptionRate >= 0.5 ? 'success' : 'neutral',
        },
      ]}
    />
  )
}

function OrgStatsSections({ data }: { data: OrgStats }): ReactNode {
  return (
    <>
      <section aria-labelledby="stats-heading">
        <h2 id="stats-heading" {...stylex.props(page.sectionLabel, styles.bandLabel)}>
          <Trans>Key metrics</Trans>
        </h2>
        <MetricsBand data={data} />
      </section>

      <div {...stylex.props(styles.lowerGrid)}>
        <section aria-labelledby="charts-heading" {...stylex.props(styles.trendsCol)}>
          <h2 id="charts-heading" {...stylex.props(page.sectionLabel, styles.trendsLabel)}>
            <Trans>Trends</Trans>
          </h2>
          <div {...stylex.props(styles.chartStack)}>
            <ActiveUserRatioChart data={data} />
            <div {...stylex.props(styles.chartDivided)}>
              <SecurityRatesChart data={data} />
            </div>
          </div>
        </section>
        <div {...stylex.props(styles.countsCol)}>
          <SecondaryCounts data={data} />
        </div>
      </div>
    </>
  )
}

export default function OrgOverview(): ReactNode {
  const { t } = useLingui()
  const { orgId } = useOrgTarget()
  const canManage = useCanManageOrg(orgId)
  const { data, isLoading, isError } = useApiQuery<OrgStats>(
    ['organizations', orgId, 'stats'] as const,
    `/v1/organizations/${orgId}/stats`,
    { enabled: canManage },
  )

  if (!orgId) {
    return (
      <ConsolePage title={<Trans>Overview</Trans>}>
        <ConsolePageNotice>
          <Alert tone="info">
            <Trans>
              No organization selected. Please select an organization to view the overview.
            </Trans>
          </Alert>
        </ConsolePageNotice>
      </ConsolePage>
    )
  }

  return (
    <ConsolePage title={<Trans>Overview</Trans>}>
      {isLoading ? (
        <div {...stylex.props(page.loadingCenter)}>
          <Spinner label={t`Loading organization stats`} />
        </div>
      ) : isError ? (
        <ConsolePageNotice>
          <Alert tone="error">
            <Trans>Failed to load organization stats. Please try again.</Trans>
          </Alert>
        </ConsolePageNotice>
      ) : data ? (
        <OrgStatsSections data={data} />
      ) : null}
    </ConsolePage>
  )
}
