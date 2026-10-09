import { Trans, useLingui } from '@lingui/react/macro'
import * as stylex from '@stylexjs/stylex'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { queryKeys, useApiQuery } from '@xid-kit/web-ui/queries'
import { text, weight } from '@xid-kit/web-ui/styles/scale.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { Alert } from '@xid-kit/web-ui/ui'

export type BannerAnnouncement = {
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

// 关闭只记在本浏览器,按公告 id 区分;公告修改后 id 不变,仍保持关闭。
const DISMISSED_KEY = 'xid.console.dismissedAnnouncements'

const styles = stylex.create({
  band: {
    display: 'grid',
    gap: '1px',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  bar: {
    display: 'flex',
    alignItems: 'center',
    gap: '1rem',
    paddingBlock: '0.625rem',
    paddingInline: 'clamp(1rem, 2.5vw, 4rem)',
    fontSize: text.base,
    lineHeight: 1.45,
  },
  info: {
    backgroundColor: tokens['--xid-info-bg'],
    color: tokens['--xid-info-foreground'],
  },
  success: {
    backgroundColor: tokens['--xid-success-bg'],
    color: tokens['--xid-success-foreground'],
  },
  warning: {
    backgroundColor: tokens['--xid-warning-bg'],
    color: tokens['--xid-warning-foreground'],
  },
  critical: {
    backgroundColor: tokens['--xid-danger-bg'],
    color: tokens['--xid-danger-foreground'],
  },
  message: {
    flex: '1 1 auto',
    minWidth: 0,
    margin: 0,
  },
  title: {
    fontWeight: weight.medium,
  },
  dismiss: {
    flexShrink: 0,
    padding: 0,
    borderWidth: 0,
    backgroundColor: 'transparent',
    color: 'inherit',
    opacity: { default: 0.75, ':hover': 1 },
    fontSize: text.sm,
    cursor: 'pointer',
  },
})

function readDismissed(): string[] {
  try {
    const raw = globalThis.localStorage?.getItem(DISMISSED_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch (error) {
    console.warn('announcement dismissals could not be read', error)
    return []
  }
}

function writeDismissed(ids: readonly string[]): void {
  try {
    globalThis.localStorage?.setItem(DISMISSED_KEY, JSON.stringify(ids))
  } catch (error) {
    console.warn('announcement dismissal could not be saved', error)
  }
}

export function AnnouncementBar({
  announcement,
  onDismiss,
}: {
  announcement: Pick<BannerAnnouncement, 'title' | 'body' | 'severity'>
  onDismiss?: () => void
}): ReactNode {
  return (
    <div
      role={announcement.severity === 'critical' ? 'alert' : 'status'}
      {...stylex.props(styles.bar, styles[announcement.severity])}
    >
      <p {...stylex.props(styles.message)}>
        <span {...stylex.props(styles.title)}>{announcement.title}</span>
        {announcement.body ? ` ${announcement.body}` : null}
      </p>
      {onDismiss ? (
        <button type="button" onClick={onDismiss} {...stylex.props(styles.dismiss)}>
          <Trans>Dismiss</Trans>
        </button>
      ) : null}
    </div>
  )
}

export function ActiveAnnouncementsBanner({ enabled }: ActiveAnnouncementsBannerProps): ReactNode {
  const { t } = useLingui()
  const [dismissed, setDismissed] = useState<string[]>(readDismissed)
  const query = useApiQuery<BannerAnnouncement[]>(
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
  const visible = (query.data ?? []).filter((announcement) => !dismissed.includes(announcement.id))
  if (visible.length === 0) return null

  function dismiss(id: string): void {
    const next = [...dismissed, id]
    setDismissed(next)
    writeDismissed(next)
  }

  return (
    <section aria-label={t`Active announcements`} {...stylex.props(styles.band)}>
      {visible.map((announcement) => (
        <AnnouncementBar
          key={announcement.id}
          announcement={announcement}
          onDismiss={() => dismiss(announcement.id)}
        />
      ))}
    </section>
  )
}
