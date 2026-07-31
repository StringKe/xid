import { Trans, useLingui } from '@lingui/react/macro'
import * as stylex from '@stylexjs/stylex'
import type { ReactNode } from 'react'
import { queryKeys, useApiQuery } from '@xid-kit/web-ui/queries'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { Alert } from '@xid-kit/web-ui/ui'
import type { AlertTone } from '@xid-kit/web-ui/ui'

type ActiveAnnouncement = {
  id: string
  title: string
  body: string
  severity: 'info' | 'success' | 'warning' | 'critical'
  startsAt: string
  endsAt: string | null
}

type ActiveAnnouncementsBannerProps = {
  enabled: boolean
}

const styles = stylex.create({
  band: {
    display: 'grid',
    gap: '0.5rem',
    paddingBlock: '0.75rem',
    paddingInline: 'clamp(1rem, 2.5vw, 4rem)',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
    backgroundColor: tokens['--xid-bg'],
  },
})

function announcementTone(severity: ActiveAnnouncement['severity']): AlertTone {
  return severity === 'critical' ? 'error' : severity
}

export function ActiveAnnouncementsBanner({ enabled }: ActiveAnnouncementsBannerProps): ReactNode {
  const { t } = useLingui()
  const query = useApiQuery<ActiveAnnouncement[]>(
    queryKeys.activeAnnouncements,
    '/v1/announcements/active',
    {
      enabled,
      refetchInterval: 60_000,
      staleTime: 30_000,
    },
  )

  if (!enabled || query.isLoading) return null
  if (query.isError) {
    return (
      <section aria-label={t`Active announcements`} {...stylex.props(styles.band)}>
        <Alert tone="error">
          <Trans>Active announcements could not be loaded.</Trans>
        </Alert>
      </section>
    )
  }
  if (!query.data || query.data.length === 0) return null

  return (
    <section aria-label={t`Active announcements`} {...stylex.props(styles.band)}>
      {query.data.map((announcement) => (
        <Alert
          key={announcement.id}
          tone={announcementTone(announcement.severity)}
          title={announcement.title}
        >
          {announcement.body}
        </Alert>
      ))}
    </section>
  )
}
