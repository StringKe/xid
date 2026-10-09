// 待处理事项:每条是「类别 / 事实组成的句子 / 一个去处」。手机上第一条完整展开,其余收成可点的摘要行。

import { Plural, Trans, useLingui } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Button, Icon, Skeleton } from '@xid-kit/web-ui/ui'
import { Link } from '@xid-kit/web-ui/tanstack-router'
import { leading, size, text, weight } from '@xid-kit/web-ui/styles/scale.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import type { AttentionItem, OrgAttention } from './overview-queries'

const DAY_MS = 24 * 60 * 60 * 1000

export const section = stylex.create({
  root: {
    display: 'flex',
    flexDirection: 'column',
    maxWidth: '60rem',
  },
  head: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    gap: { default: '0.25rem 0.625rem', '@media (min-width: 48rem)': '0.625rem' },
    paddingBottom: '0.625rem',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  title: {
    margin: 0,
    color: tokens['--xid-fg'],
    fontSize: text.md,
    fontWeight: weight.medium,
    lineHeight: leading.base,
  },
  meta: {
    margin: 0,
    flex: { default: '1 1 100%', '@media (min-width: 48rem)': '0 1 auto' },
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
    lineHeight: leading.xs,
  },
  metaEnd: {
    flex: { default: '0 0 auto', '@media (min-width: 48rem)': '0 1 auto' },
    marginInlineStart: { default: 'auto', '@media (min-width: 48rem)': 0 },
  },
})

export const actionLink = stylex.create({
  base: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    minHeight: { default: size.touch, '@media (min-width: 48rem) and (pointer: fine)': '2rem' },
    paddingInline: '0.75rem',
    borderRadius: tokens['--xid-radius'],
    boxShadow: `inset 0 0 0 1px ${tokens['--xid-border-strong']}`,
    backgroundColor: { default: tokens['--xid-surface'], ':hover': tokens['--xid-muted'] },
    color: tokens['--xid-fg'],
    fontFamily: tokens['--xid-font'],
    fontSize: text.sm,
    fontWeight: weight.medium,
    lineHeight: leading.xs,
    whiteSpace: 'nowrap',
    textDecoration: 'none',
    outlineColor: tokens['--xid-accent'],
    outlineOffset: '2px',
    transitionProperty: 'background-color',
    transitionDuration: '150ms',
  },
  primary: {
    minHeight: {
      default: size.touch,
      '@media (min-width: 48rem) and (pointer: fine)': size.control,
    },
    paddingInline: '0.875rem',
    boxShadow: 'none',
    backgroundColor: { default: tokens['--xid-primary'], ':hover': tokens['--xid-primary'] },
    color: tokens['--xid-primary-foreground'],
    fontSize: text.base,
  },
  fullNarrow: {
    width: { default: '100%', '@media (min-width: 48rem)': 'auto' },
  },
  text: {
    color: tokens['--xid-accent'],
    fontSize: text.sm,
    lineHeight: leading.xs,
    textDecoration: { default: 'none', ':hover': 'underline' },
  },
})

const styles = stylex.create({
  item: {
    display: 'grid',
    gridTemplateColumns: {
      default: 'minmax(0, 1fr)',
      '@media (min-width: 48rem)': '7.5rem minmax(0, 1fr) auto',
    },
    alignItems: 'center',
    gap: { default: '0.75rem', '@media (min-width: 48rem)': '1.25rem' },
    paddingBlock: '1rem',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  collapseNarrow: {
    display: { default: 'none', '@media (min-width: 48rem)': 'grid' },
  },
  category: {
    alignSelf: 'start',
    margin: 0,
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
    lineHeight: leading.base,
  },
  body: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.125rem',
    minWidth: 0,
  },
  titleRow: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '0.25rem 0.5rem',
  },
  itemTitle: {
    margin: 0,
    color: tokens['--xid-fg'],
    fontSize: text.base,
    fontWeight: weight.medium,
    lineHeight: leading.base,
    overflowWrap: 'anywhere',
  },
  detail: {
    margin: 0,
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
    lineHeight: leading.sm,
    overflowWrap: 'anywhere',
  },
  badge: {
    display: 'inline-flex',
    alignItems: 'center',
    height: '1.25rem',
    paddingInline: '0.4375rem',
    borderRadius: tokens['--xid-radius-full'],
    fontSize: text.xs,
    fontWeight: weight.medium,
    lineHeight: leading.xs,
    whiteSpace: 'nowrap',
  },
  badgeCritical: {
    backgroundColor: tokens['--xid-danger-bg'],
    color: tokens['--xid-danger-foreground'],
  },
  badgeWarning: {
    backgroundColor: tokens['--xid-warning-bg'],
    color: tokens['--xid-warning-foreground'],
  },
  compact: {
    display: { default: 'flex', '@media (min-width: 48rem)': 'none' },
    alignItems: 'center',
    gap: '0.75rem',
    minHeight: size.touch,
    paddingBlock: '0.75rem',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
    color: 'inherit',
    textDecoration: 'none',
  },
  compactText: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.125rem',
    flex: '1 1 auto',
    minWidth: 0,
  },
  chevron: {
    display: 'inline-flex',
    flexShrink: 0,
    color: tokens['--xid-muted-foreground'],
  },
  allClear: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.375rem',
    paddingBlock: '1.25rem',
    paddingInlineStart: { default: 0, '@media (min-width: 48rem)': '8.75rem' },
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  errorRow: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '0.75rem',
    paddingBlock: '1rem',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
  },
  skeletonRow: {
    paddingBlock: '1.25rem',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
})

export function orgPath(path: string, orgId: string): string {
  const separator = path.includes('?') ? '&' : '?'
  return `${path}${separator}orgId=${encodeURIComponent(orgId)}`
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

type ItemView = {
  category: ReactNode
  title: ReactNode
  badge?: { label: string; tone: 'critical' | 'warning' }
  detail: ReactNode
  summary: ReactNode
  action: { label: ReactNode; to: string }
}

function useItemView(): (item: AttentionItem, orgId: string, now: number) => ItemView {
  const { i18n } = useLingui()
  const shortDate = (iso: string) =>
    i18n.date(new Date(iso), { month: 'short', day: 'numeric', timeZone: 'UTC' })
  const longDate = (iso: string) =>
    i18n.date(new Date(iso), { dateStyle: 'medium', timeZone: 'UTC' })
  const utcTime = (iso: string) =>
    i18n.date(new Date(iso), {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZone: 'UTC',
    })

  return (item, orgId, now) => {
    switch (item.kind) {
      case 'sso_certificate_expiring': {
        const facts = item.facts
        const name = facts.connectionName ?? 'SSO'
        const days = Math.max(0, Math.ceil((Date.parse(facts.notAfter) - now) / DAY_MS))
        const people = facts.affectedUserCount
        const expiry = shortDate(facts.notAfter)
        return {
          category: <Trans>Enterprise SSO</Trans>,
          title:
            days === 0 ? (
              <Trans>The {name} signing certificate has expired</Trans>
            ) : (
              <Trans>
                The {name} signing certificate expires in{' '}
                <Plural value={days} one="# day" other="# days" />
              </Trans>
            ),
          badge: {
            label: expiry,
            tone: item.severity === 'critical' ? 'critical' : 'warning',
          },
          detail:
            people === 0 ? (
              <Trans>
                Upload the new certificate from {name} before then, or sign-in with {name} SSO stops
                working.
              </Trans>
            ) : (
              <Trans>
                Upload the new certificate from {name} before then, or{' '}
                <Plural value={people} one="# person who signs" other="# people who sign" /> in with{' '}
                {name} SSO will be locked out.
              </Trans>
            ),
          summary: <Trans>Enterprise SSO. Renew it before {expiry}.</Trans>,
          action: {
            label: <Trans>Upload certificate…</Trans>,
            to: orgPath('/console/org/sso', orgId),
          },
        }
      }
      case 'webhook_failing': {
        const facts = item.facts
        const host = hostOf(facts.url)
        const since = facts.since ? utcTime(facts.since) : ''
        const status = facts.lastResponseStatus
        const failed = facts.failedCount
        return {
          category: <Trans>Webhooks</Trans>,
          title: <Trans>Deliveries to {host} are failing</Trans>,
          detail: (
            <>
              {status === null ? (
                <Trans>
                  <Plural value={failed} one="# delivery" other="# deliveries" /> failed since{' '}
                  {since} UTC.
                </Trans>
              ) : (
                <Trans>
                  <Plural value={failed} one="# delivery" other="# deliveries" /> failed since{' '}
                  {since} UTC with HTTP {status}.
                </Trans>
              )}{' '}
              {facts.deadCount === 0 ? (
                <Trans>XID is still retrying them; none have been dropped.</Trans>
              ) : (
                <Trans>{facts.deadCount} ran out of retries and will not be sent again.</Trans>
              )}
            </>
          ),
          summary: (
            <Trans>
              Webhooks. {failed} failed since {since} UTC.
            </Trans>
          ),
          action: {
            label: <Trans>View deliveries</Trans>,
            to: orgPath(
              `/console/org/webhooks?webhookId=${encodeURIComponent(item.targetId)}`,
              orgId,
            ),
          },
        }
      }
      case 'domain_unverified': {
        const facts = item.facts
        const domain = facts.domain
        const added = facts.addedAt ? shortDate(facts.addedAt) : null
        const sso = facts.ssoConnectionName
        return {
          category: <Trans>Domains</Trans>,
          title: <Trans>{domain} is not verified</Trans>,
          detail: (
            <>
              {added ? <Trans>Added {added}.</Trans> : null}{' '}
              {sso ? (
                <Trans>
                  Until the DNS TXT record is found, people with @{domain} addresses are not sent to{' '}
                  {sso}.
                </Trans>
              ) : (
                <Trans>
                  Until the DNS TXT record is found, people with @{domain} addresses are not routed
                  to this organization.
                </Trans>
              )}
            </>
          ),
          summary: <Trans>Domains. DNS TXT record not found yet.</Trans>,
          action: {
            label: <Trans>Check DNS again</Trans>,
            to: orgPath('/console/org/domains', orgId),
          },
        }
      }
      case 'invitation_expired': {
        const facts = item.facts
        const email = facts.email
        const expired = facts.expiredAt ? longDate(facts.expiredAt) : ''
        return {
          category: <Trans>Members</Trans>,
          title: (
            <Plural value={facts.count} one="# invitation expired" other="# invitations expired" />
          ),
          detail:
            facts.count === 1 ? (
              <Trans>
                The invitation to {email} expired on {expired}. Resend it or revoke it.
              </Trans>
            ) : (
              <Trans>
                The most recent, to {email}, expired on {expired}. Resend them or revoke them.
              </Trans>
            ),
          summary: <Trans>Members. {facts.count} expired.</Trans>,
          action: {
            label: <Trans>Review invitations</Trans>,
            to: orgPath('/console/org/members?tab=invitations', orgId),
          },
        }
      }
    }
  }
}

function AttentionRow({
  view,
  collapseOnNarrow,
}: {
  view: ItemView
  collapseOnNarrow: boolean
}): ReactNode {
  return (
    <>
      <li {...stylex.props(styles.item, collapseOnNarrow && styles.collapseNarrow)}>
        <p {...stylex.props(styles.category)}>{view.category}</p>
        <div {...stylex.props(styles.body)}>
          <div {...stylex.props(styles.titleRow)}>
            <p {...stylex.props(styles.itemTitle)}>{view.title}</p>
            {view.badge ? (
              <span
                {...stylex.props(
                  styles.badge,
                  view.badge.tone === 'critical' ? styles.badgeCritical : styles.badgeWarning,
                )}
              >
                {view.badge.label}
              </span>
            ) : null}
          </div>
          <p {...stylex.props(styles.detail)}>{view.detail}</p>
        </div>
        <Link to={view.action.to} {...stylex.props(actionLink.base, actionLink.fullNarrow)}>
          {view.action.label}
        </Link>
      </li>
      {collapseOnNarrow ? (
        <li>
          <Link to={view.action.to} {...stylex.props(styles.compact)}>
            <span {...stylex.props(styles.compactText)}>
              <span {...stylex.props(styles.itemTitle)}>{view.title}</span>
              <span {...stylex.props(styles.detail)}>{view.summary}</span>
            </span>
            <span aria-hidden="true" {...stylex.props(styles.chevron)}>
              <Icon name="chevron-right" size={16} />
            </span>
          </Link>
        </li>
      ) : null}
    </>
  )
}

function AllClear({ attention }: { attention: OrgAttention }): ReactNode {
  const { i18n } = useLingui()
  const checked = i18n.date(new Date(attention.checkedAt), {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  })
  const next = attention.nextCertificateExpiry
  const nextName = next?.connectionName ?? 'SSO'
  const nextDate = next
    ? i18n.date(new Date(next.notAfter), { dateStyle: 'medium', timeZone: 'UTC' })
    : ''
  return (
    <div {...stylex.props(styles.allClear)}>
      <p {...stylex.props(styles.itemTitle)}>
        <Trans>Certificates, domains, invitations and webhook deliveries are all in order</Trans>
      </p>
      <p {...stylex.props(styles.detail)}>
        <Trans>XID lists anything that needs you here. Last checked {checked} UTC.</Trans>{' '}
        {next ? (
          <Trans>
            The {nextName} certificate is next to expire, on {nextDate}.
          </Trans>
        ) : null}
      </p>
    </div>
  )
}

export type AttentionListProps = {
  orgId: string
  attention: OrgAttention | undefined
  isLoading: boolean
  isError: boolean
  onRetry: () => void
}

export function AttentionList({
  orgId,
  attention,
  isLoading,
  isError,
  onRetry,
}: AttentionListProps): ReactNode {
  const viewOf = useItemView()
  const now = attention ? Date.parse(attention.checkedAt) : 0
  const count = attention?.items.length ?? 0
  return (
    <section aria-labelledby="attention-heading" {...stylex.props(section.root)}>
      <header {...stylex.props(section.head)}>
        <h2 id="attention-heading" {...stylex.props(section.title)}>
          <Trans>Needs attention</Trans>
        </h2>
        {attention ? (
          <p {...stylex.props(section.meta, section.metaEnd)}>
            {count === 0 ? (
              <Trans>Nothing to do right now</Trans>
            ) : (
              <>
                <span {...stylex.props(narrowHidden.wide)}>
                  <Plural
                    value={count}
                    one="# item, most urgent first"
                    other="# items, most urgent first"
                  />
                </span>
                <span {...stylex.props(narrowHidden.narrow)}>
                  <Plural value={count} one="# item" other="# items" />
                </span>
              </>
            )}
          </p>
        ) : null}
      </header>
      {isLoading ? (
        <div aria-busy="true" role="status">
          {[0, 1].map((index) => (
            <div key={index} {...stylex.props(styles.skeletonRow)}>
              <Skeleton width="60%" height="1rem" />
            </div>
          ))}
        </div>
      ) : isError ? (
        <div role="alert" {...stylex.props(styles.errorRow)}>
          <span>
            <Trans>
              The list of things that need attention didn't load. Try again in a moment.
            </Trans>
          </span>
          <Button variant="secondary" onClick={onRetry}>
            <Trans>Try again</Trans>
          </Button>
        </div>
      ) : attention && count === 0 ? (
        <AllClear attention={attention} />
      ) : attention ? (
        <ul {...stylex.props(list.reset)}>
          {attention.items.map((item, index) => (
            <AttentionRow
              key={`${item.kind}:${item.targetId}`}
              view={viewOf(item, orgId, now)}
              collapseOnNarrow={index > 0}
            />
          ))}
        </ul>
      ) : null}
    </section>
  )
}

const list = stylex.create({
  reset: {
    margin: 0,
    padding: 0,
    listStyle: 'none',
  },
})

const narrowHidden = stylex.create({
  wide: {
    display: { default: 'none', '@media (min-width: 48rem)': 'inline' },
  },
  narrow: {
    display: { default: 'inline', '@media (min-width: 48rem)': 'none' },
  },
})
