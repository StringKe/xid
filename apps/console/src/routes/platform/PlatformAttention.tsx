import type { I18n } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { Plural, Trans, useLingui } from '@lingui/react/macro'
import * as stylex from '@stylexjs/stylex'
import type { ReactNode } from 'react'
import { Icon } from '@xid-kit/web-ui/ui'
import { Link } from '@xid-kit/web-ui/tanstack-router'
import { text, weight } from '@xid-kit/web-ui/styles/scale.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import type { PlatformAttentionItem } from './ops-queries'

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
const NARROW = '@media (max-width: 40rem)'

const styles = stylex.create({
  list: {
    margin: 0,
    padding: 0,
    listStyle: 'none',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
  },
  item: {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    gap: '1.5rem',
    paddingBlock: { default: '0.875rem', [NARROW]: '0.75rem' },
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  body: {
    flex: '1 1 auto',
    minWidth: 0,
  },
  title: {
    margin: 0,
    color: tokens['--xid-fg'],
    fontSize: text.base,
    fontWeight: weight.medium,
    lineHeight: 1.45,
  },
  detail: {
    margin: '0.125rem 0 0',
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
    lineHeight: 1.5,
  },
  action: {
    flexShrink: 0,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: '2rem',
    paddingInline: { default: '0.75rem', [NARROW]: 0 },
    borderWidth: { default: '1px', [NARROW]: 0 },
    borderStyle: 'solid',
    borderColor: tokens['--xid-border-strong'],
    borderRadius: tokens['--xid-radius-sm'],
    backgroundColor: { default: tokens['--xid-bg'], ':hover': tokens['--xid-muted'] },
    color: tokens['--xid-fg'],
    fontSize: text.sm,
    fontWeight: weight.medium,
    textDecoration: 'none',
    whiteSpace: 'nowrap',
    // 窄屏整行可点:伪元素铺满列表项,只留箭头图标。
    '::after': {
      content: { default: 'none', [NARROW]: '""' },
      position: 'absolute',
      inset: 0,
    },
  },
  actionLabel: {
    display: { default: 'inline', [NARROW]: 'none' },
  },
  chevron: {
    display: { default: 'none', [NARROW]: 'inline-flex' },
    color: tokens['--xid-muted-foreground'],
  },
  empty: {
    margin: 0,
    paddingBlock: '1rem',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
  },
})

export function formatRelativeTime(i18n: I18n, iso: string, now: number = Date.now()): string {
  const elapsed = new Date(iso).getTime() - now
  const format = new Intl.RelativeTimeFormat(i18n.locale, { numeric: 'auto' })
  if (Math.abs(elapsed) < HOUR_MS) return format.format(Math.round(elapsed / MINUTE_MS), 'minute')
  if (Math.abs(elapsed) < DAY_MS) return format.format(Math.round(elapsed / HOUR_MS), 'hour')
  return format.format(Math.round(elapsed / DAY_MS), 'day')
}

export function formatUtcDateTime(i18n: I18n, iso: string): string {
  return i18n.date(new Date(iso), {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: 'UTC',
    timeZoneName: 'short',
  })
}

function listOf(i18n: I18n, values: readonly string[]): string {
  return new Intl.ListFormat(i18n.locale, { type: 'conjunction' }).format(values)
}

type AttentionCopy = { title: ReactNode; detail: ReactNode; action: ReactNode; to: string }

function deadLetterCopy(
  i18n: I18n,
  facts: Extract<PlatformAttentionItem, { kind: 'dead_letters' }>['facts'],
): AttentionCopy {
  const count = facts.count
  const queues = listOf(
    i18n,
    facts.byQueue.map(({ queue, count: queueCount }) => i18n._(msg`${queueCount} from ${queue}`)),
  )
  const oldest = formatUtcDateTime(i18n, facts.oldestFailedAt)
  return {
    title: (
      <Plural
        value={count}
        one="# message is waiting in dead letter queues"
        other="# messages are waiting in dead letter queues"
      />
    ),
    detail: (
      <Trans>
        {queues}. The oldest arrived {oldest}.
      </Trans>
    ),
    action: <Trans>Review dead letters</Trans>,
    to: '/console/platform/dead-letters',
  }
}

function incidentCopy(
  i18n: I18n,
  facts: Extract<PlatformAttentionItem, { kind: 'incident_open' }>['facts'],
): AttentionCopy {
  const title = facts.title
  const opened = formatUtcDateTime(i18n, facts.startedAt)
  const lastUpdate = facts.lastUpdateAt ? formatRelativeTime(i18n, facts.lastUpdateAt) : null
  return {
    title: <Trans>Incident "{title}" is still open</Trans>,
    detail: lastUpdate ? (
      <Trans>
        Opened {opened}. The last public update was {lastUpdate}.
      </Trans>
    ) : (
      <Trans>Opened {opened}. No public update has been posted yet.</Trans>
    ),
    action: <Trans>Post update…</Trans>,
    to: `/console/platform/status?incidentId=${encodeURIComponent(facts.incidentId)}`,
  }
}

function signingKeyCopy(
  facts: Extract<PlatformAttentionItem, { kind: 'signing_key_next_ready' }>['facts'],
): AttentionCopy {
  const days = Math.max(
    0,
    Math.floor((Date.now() - new Date(facts.publishedAt).getTime()) / DAY_MS),
  )
  return {
    title:
      days === 0 ? (
        <Trans>The next signing key is ready to promote</Trans>
      ) : (
        <Plural
          value={days}
          one="The next signing key has been published for # day"
          other="The next signing key has been published for # days"
        />
      ),
    detail: (
      <Trans>
        Relying parties have refreshed their JWKS cache. Promoting it to active is a manual step.
      </Trans>
    ),
    action: <Trans>Review signing keys</Trans>,
    to: '/console/platform/settings',
  }
}

function quotaCopy(
  i18n: I18n,
  facts: Extract<PlatformAttentionItem, { kind: 'mau_quota_high' }>['facts'],
): AttentionCopy {
  const names = listOf(
    i18n,
    facts.organizations.map((organization) => organization.name),
  )
  const count = facts.organizations.length
  return {
    title: (
      <Plural
        value={count}
        one={`${names} is above 90% of its MAU quota`}
        other={`${names} are above 90% of their MAU quota`}
      />
    ),
    detail: <Trans>Sign-in keeps working past the quota. MAU quotas are observed only.</Trans>,
    action: <Trans>Open usage</Trans>,
    to: '/console/platform/usage',
  }
}

function suspendedCopy(
  facts: Extract<PlatformAttentionItem, { kind: 'organization_suspended' }>['facts'],
): AttentionCopy {
  const name = facts.name
  return {
    title: <Trans>{name} is suspended</Trans>,
    detail: (
      <Trans>Its users cannot sign in until you resume it. Data and audit history are kept.</Trans>
    ),
    action: <Trans>Open {name}</Trans>,
    to: `/console/platform/organizations?organizationId=${encodeURIComponent(facts.organizationId)}`,
  }
}

function attentionCopy(i18n: I18n, item: PlatformAttentionItem): AttentionCopy {
  switch (item.kind) {
    case 'dead_letters':
      return deadLetterCopy(i18n, item.facts)
    case 'incident_open':
      return incidentCopy(i18n, item.facts)
    case 'signing_key_next_ready':
      return signingKeyCopy(item.facts)
    case 'mau_quota_high':
      return quotaCopy(i18n, item.facts)
    case 'organization_suspended':
      return suspendedCopy(item.facts)
  }
}

function attentionKey(item: PlatformAttentionItem): string {
  if (item.kind === 'incident_open') return `${item.kind}:${item.facts.incidentId}`
  if (item.kind === 'organization_suspended') return `${item.kind}:${item.facts.organizationId}`
  if (item.kind === 'signing_key_next_ready') return `${item.kind}:${item.facts.kid}`
  return item.kind
}

export function PlatformAttention({
  items,
}: {
  items: readonly PlatformAttentionItem[]
}): ReactNode {
  const { i18n } = useLingui()
  if (items.length === 0) {
    return (
      <p {...stylex.props(styles.empty)}>
        <Trans>Nothing needs an instance manager right now.</Trans>
      </p>
    )
  }
  return (
    <ul {...stylex.props(styles.list)}>
      {items.map((item) => {
        const copy = attentionCopy(i18n, item)
        return (
          <li key={attentionKey(item)} {...stylex.props(styles.item)}>
            <div {...stylex.props(styles.body)}>
              <p {...stylex.props(styles.title)}>{copy.title}</p>
              <p {...stylex.props(styles.detail)}>{copy.detail}</p>
            </div>
            <Link to={copy.to} {...stylex.props(styles.action)}>
              <span {...stylex.props(styles.actionLabel)}>{copy.action}</span>
              <span aria-hidden="true" {...stylex.props(styles.chevron)}>
                <Icon name="chevron-right" />
              </span>
            </Link>
          </li>
        )
      })}
    </ul>
  )
}
