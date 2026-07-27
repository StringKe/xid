// org 概览页:DAU/MAU、登录成功率、MFA 采用率当前指标 + 关键数字。
// 数据从 GET /v1/organizations/:orgId/stats 拉取(TanStack Query)。
// 全宽锚定版式(console 29 页跟随此口径):零 padding 壳下各节自持 gutter;
// display 标题 -> 指标带横贯全宽(hairline 收束)-> 7fr/5fr 不对称双列
// (Trends 图表 | 次要计数 ledger 列),中缝 1px 竖 hairline,64rem 以下回落单列(竖转横)。

import { Trans, useLingui } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Alert, Spinner } from '@xid-kit/web-ui/ui'
import { MetricBarChart } from '@xid-kit/web-ui/ui/MetricBarChart'
import { page } from '@xid-kit/web-ui/styles/product-surface.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { useApiQuery } from '@xid-kit/web-ui/queries'
import { MetricsBand, SecondaryCounts } from './OrgOverviewMetrics'
import type { OrgStats } from './OrgOverviewMetrics'
import { useCanManageOrg, useOrgTarget } from './useOrgTarget'

// 全宽规范口径:内容列 gutter / 节纵距 / 双列中缝两侧留白(与 ConsoleLayout、MetricsBand 同源)。
const GUTTER = 'clamp(1rem, 2.5vw, 4rem)'
const SECTION_PAD = 'clamp(1.5rem, 1.6vw, 2.5rem)'
const CROSS_GAP = 'clamp(1.75rem, 2vw, 3.5rem)'

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
  // display 标题:字号 clamp 上探做功,字重退后,紧行高。
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
    // hairline 邻接 >= 1.25rem:microlabel 文本到 MetricsBand 顶线 >= 1.25rem
    marginBottom: '1.25rem',
  },
  // 下区:7fr/5fr 不对称双列,中缝 1px 竖 hairline;底缘 1px 收束(ledger 闭合线)。
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
  // 提示/错误等独立消息:自持 gutter(壳零 padding)。
  messageZone: {
    paddingInline: GUTTER,
    paddingBlock: '1.5rem',
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
      <div {...stylex.props(styles.messageZone)}>
        <Alert tone="info">
          <Trans>
            No organization selected. Please select an organization to view the overview.
          </Trans>
        </Alert>
      </div>
    )
  }

  return (
    <div {...stylex.props(styles.root)}>
      <div {...stylex.props(styles.headerZone)}>
        <h1 {...stylex.props(styles.title)}>
          <Trans>Overview</Trans>
        </h1>
      </div>

      {isLoading ? (
        <div {...stylex.props(page.loadingCenter)}>
          <Spinner label={t`Loading organization stats`} />
        </div>
      ) : isError ? (
        <div {...stylex.props(styles.messageZone)}>
          <Alert tone="error">
            <Trans>Failed to load organization stats. Please try again.</Trans>
          </Alert>
        </div>
      ) : data ? (
        <OrgStatsSections data={data} />
      ) : null}
    </div>
  )
}
