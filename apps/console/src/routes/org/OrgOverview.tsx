import { Trans, useLingui } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Alert, Icon, Spinner } from '@xid-kit/web-ui/ui'
import { ConsolePage, ConsolePageNotice } from '@xid-kit/web-ui/ui'
import { MetricBarChart } from '@xid-kit/web-ui/ui/MetricBarChart'
import { Link } from '@xid-kit/web-ui/tanstack-router'
import { page } from '@xid-kit/web-ui/styles/product-surface.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { useApiQuery } from '@xid-kit/web-ui/queries'
import type { AuthOrg } from '@xid-kit/web-ui/session'
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
  // 页头动作只保留真正高频的创建入口,不重复侧栏的资源导航。
  quickActions: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '0.5rem',
  },
  quickAction: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.4375rem',
    paddingBlock: '0.375rem',
    paddingInline: '0.75rem',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: tokens['--xid-border'],
    minHeight: '2.5rem',
    borderRadius: tokens['--xid-radius'],
    backgroundColor: {
      default: tokens['--xid-surface'],
      ':hover': tokens['--xid-muted'],
      ':focus-visible': tokens['--xid-muted'],
    },
    color: tokens['--xid-fg'],
    fontSize: '0.8125rem',
    fontWeight: 550,
    textDecoration: 'none',
    transitionProperty: 'background-color',
    transitionDuration: '150ms',
    transitionTimingFunction: 'cubic-bezier(0.25, 1, 0.5, 1)',
    outlineOffset: '2px',
    outlineColor: tokens['--xid-primary'],
  },
  quickActionIcon: {
    display: 'inline-flex',
    flexShrink: 0,
    color: tokens['--xid-muted-foreground'],
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

// 直达创建流,icon 与侧栏导航同源,保证动作与目的地的视觉对应。
function OrgQuickActions({ org }: { org: AuthOrg }): ReactNode {
  const { t } = useLingui()
  const actions = [
    {
      to: '/console/org/applications',
      label: <Trans>Create application</Trans>,
      icon: 'squares-four',
    },
    { to: '/console/org/members', label: <Trans>Invite member</Trans>, icon: 'users' },
    { to: '/console/org/api-keys', label: <Trans>Create API key</Trans>, icon: 'key' },
  ] as const
  return (
    <nav aria-label={t`Quick actions`} {...stylex.props(styles.quickActions)}>
      {actions.map((action) => (
        <Link
          key={action.to}
          to={`${action.to}?orgId=${encodeURIComponent(org.id)}`}
          {...stylex.props(styles.quickAction)}
        >
          <span aria-hidden="true" {...stylex.props(styles.quickActionIcon)}>
            <Icon name={action.icon} size={16} />
          </span>
          {action.label}
        </Link>
      ))}
    </nav>
  )
}

export default function OrgOverview(): ReactNode {
  const { t } = useLingui()
  const { orgId, activeOrg } = useOrgTarget()
  const canManage = useCanManageOrg(orgId)
  const { data, isLoading, isError } = useApiQuery<OrgStats>(
    ['organizations', orgId, 'stats'] as const,
    `/v1/organizations/${orgId}/stats`,
    { enabled: canManage },
  )

  if (!orgId) {
    return (
      <ConsolePage wide title={<Trans>Overview</Trans>}>
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
    <ConsolePage
      wide
      title={<Trans>Overview</Trans>}
      actions={activeOrg ? <OrgQuickActions org={activeOrg} /> : null}
    >
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
