import { Plural, Trans, useLingui } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Alert, Button, Skeleton } from '@xid-kit/web-ui/ui'
import { ConsolePage, ConsolePageNotice, ConsolePageSection } from '@xid-kit/web-ui/ui'
import { Link } from '@xid-kit/web-ui/tanstack-router'
import { page } from '@xid-kit/web-ui/styles/product-surface.stylex'
import { text } from '@xid-kit/web-ui/styles/scale.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { PlatformAttention } from './PlatformAttention'
import { PlatformEventSentence, shortEventTime } from './PlatformAuditEvents'
import { PlatformActivityTable } from './PlatformOverviewMetrics'
import { usePlatformOverviewStats } from './ops-queries'
import type { PlatformOverviewStats } from './ops-queries'

const NARROW = '@media (max-width: 40rem)'

const styles = stylex.create({
  skeletons: {
    display: 'grid',
    gap: '0.75rem',
  },
  sectionNote: {
    color: tokens['--xid-muted-foreground'],
    fontSize: text.xs,
  },
  wideOnly: {
    display: { default: 'inline', [NARROW]: 'none' },
  },
  narrowOnly: {
    display: { default: 'none', [NARROW]: 'inline' },
  },
  activityList: {
    margin: 0,
    padding: 0,
    listStyle: 'none',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
  },
  activityItem: {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: '1.5rem',
    paddingBlock: '0.75rem',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
    color: tokens['--xid-fg'],
    fontSize: text.base,
  },
  activityTime: {
    flexShrink: 0,
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
    fontVariantNumeric: 'tabular-nums',
  },
  empty: {
    margin: 0,
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
  },
})

function OverviewLead({ data }: { data: PlatformOverviewStats | undefined }): ReactNode {
  if (!data) return <Trans>Sign-in activity, organizations and what needs attention.</Trans>
  const host = globalThis.location?.hostname ?? ''
  const organizations = data.organizationCount
  const pending = data.attention.length
  return (
    <>
      <Plural
        value={organizations}
        one={`${host} runs # organization.`}
        other={`${host} runs # organizations.`}
      />{' '}
      <Plural
        value={pending}
        _0="Nothing needs an instance manager today."
        one="# thing needs an instance manager today."
        other="# things need an instance manager today."
      />
    </>
  )
}

function RecentPlatformActivity({ data }: { data: PlatformOverviewStats }): ReactNode {
  const { i18n } = useLingui()
  if (data.recentPlatformActivity.length === 0) {
    return (
      <p {...stylex.props(styles.empty)}>
        <Trans>No instance manager actions have been recorded yet.</Trans>
      </p>
    )
  }
  return (
    <ul {...stylex.props(styles.activityList)}>
      {data.recentPlatformActivity.map((event) => (
        <li key={event.id} {...stylex.props(styles.activityItem)}>
          <span>
            <PlatformEventSentence event={event} />
          </span>
          <time dateTime={event.occurredAt} {...stylex.props(styles.activityTime)}>
            {shortEventTime(i18n, event.occurredAt)}
          </time>
        </li>
      ))}
    </ul>
  )
}

function OverviewSections({ data }: { data: PlatformOverviewStats }): ReactNode {
  const organizations = data.organizationCount
  return (
    <>
      <ConsolePageSection title={<Trans>Needs attention</Trans>}>
        <PlatformAttention items={data.attention} />
      </ConsolePageSection>

      <ConsolePageSection
        title={<Trans>Activity</Trans>}
        actions={
          <span {...stylex.props(styles.sectionNote)}>
            <span {...stylex.props(styles.wideOnly)}>
              <Plural
                value={organizations}
                one="Counts from exact metering, updated hourly. Totals cover # organization."
                other="Counts from exact metering, updated hourly. Totals cover all # organizations."
              />
            </span>
            <span {...stylex.props(styles.narrowOnly)}>
              <Trans>Exact metering, updated hourly</Trans>
            </span>
          </span>
        }
      >
        <PlatformActivityTable metrics={data.activity} />
      </ConsolePageSection>

      <ConsolePageSection
        title={<Trans>Recent platform activity</Trans>}
        actions={
          <Link to="/console/platform/events" {...stylex.props(page.textLink)}>
            <Trans>Open audit log</Trans>
          </Link>
        }
      >
        <RecentPlatformActivity data={data} />
      </ConsolePageSection>
    </>
  )
}

export default function PlatformAdminOverview(): ReactNode {
  const { t } = useLingui()
  const stats = usePlatformOverviewStats()

  return (
    <ConsolePage title={<Trans>Overview</Trans>} lead={<OverviewLead data={stats.data} />}>
      {stats.isError ? (
        <ConsolePageNotice>
          <Alert tone="error">
            <Trans>The overview could not be loaded.</Trans>{' '}
            <Button variant="secondary" onClick={() => void stats.refetch()}>
              <Trans>Try again</Trans>
            </Button>
          </Alert>
        </ConsolePageNotice>
      ) : null}

      {stats.isLoading ? (
        <ConsolePageSection title={<Trans>Needs attention</Trans>}>
          <div aria-label={t`Loading overview`} {...stylex.props(styles.skeletons)}>
            <Skeleton height="3.5rem" />
            <Skeleton height="3.5rem" />
            <Skeleton height="3.5rem" />
          </div>
        </ConsolePageSection>
      ) : null}

      {stats.data ? <OverviewSections data={stats.data} /> : null}
    </ConsolePage>
  )
}
