// 审计日志的一行:时间、谁对谁做了什么、来源渠道;展开后给出 actor / target / 链上位置与事件 JSON。
// 城市不显示:GeoIP 未实现,来源只给渠道和 IP。

import { Trans, useLingui } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { CopyButton, Icon } from '@xid-kit/web-ui/ui'
import { Link } from '@xid-kit/web-ui/tanstack-router'
import { leading, text, weight } from '@xid-kit/web-ui/styles/scale.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { orgPath } from './AttentionList'
import type { AuditEntry, AuditSource } from './overview-queries'
import { scimProviderLabel } from './scim-provider-label'

const SOURCE_LABELS: Record<AuditSource, MessageDescriptor> = {
  console: msg`Console`,
  management_api: msg`Management API`,
  scim: msg`SCIM`,
  account: msg`Account portal`,
  system: msg`XID`,
}

export const auditTable = stylex.create({
  cell: {
    paddingBlock: '0.4375rem',
    paddingInline: '0.5rem',
    verticalAlign: 'middle',
    textAlign: 'start',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  timeCell: {
    position: 'sticky',
    insetInlineStart: 0,
    zIndex: 1,
    width: { default: '5.5rem', '@media (min-width: 48rem)': '8.5rem' },
    paddingInlineStart: { default: 0, '@media (min-width: 48rem)': '0.75rem' },
    backgroundColor: tokens['--xid-bg'],
    borderInlineEndWidth: { default: '1px', '@media (min-width: 64rem)': 0 },
    borderInlineEndStyle: 'solid',
    borderInlineEndColor: tokens['--xid-border'],
  },
  sourceCell: {
    width: { default: '11rem', '@media (min-width: 64rem)': '16.25rem' },
  },
  toggleCell: {
    width: '2.5rem',
    paddingInlineEnd: { default: 0, '@media (min-width: 48rem)': '0.5rem' },
  },
})

const styles = stylex.create({
  row: {
    cursor: 'pointer',
    backgroundColor: { default: 'transparent', ':hover': tokens['--xid-muted'] },
  },
  rowOpen: {
    backgroundColor: tokens['--xid-muted'],
  },
  timeOpen: {
    backgroundColor: tokens['--xid-muted'],
  },
  time: {
    display: 'flex',
    flexWrap: 'wrap',
    columnGap: '0.25rem',
    color: tokens['--xid-fg'],
    fontSize: text.base,
    lineHeight: leading.sm,
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
  },
  timePart: {
    display: { default: 'block', '@media (min-width: 64rem)': 'inline' },
    color: {
      default: tokens['--xid-muted-foreground'],
      '@media (min-width: 64rem)': tokens['--xid-fg'],
    },
  },
  sentence: {
    margin: 0,
    color: tokens['--xid-fg'],
    fontSize: text.base,
    lineHeight: leading.sm,
    minWidth: '14rem',
  },
  strong: {
    fontWeight: weight.medium,
  },
  mono: {
    display: 'block',
    color: tokens['--xid-muted-foreground'],
    fontFamily: tokens['--xid-font-mono'],
    fontSize: text.xs,
    lineHeight: leading.xs,
    overflowWrap: 'anywhere',
  },
  sourceName: {
    display: 'block',
    color: tokens['--xid-fg'],
    fontSize: text.base,
    lineHeight: leading.sm,
  },
  toggle: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: { default: '2.75rem', '@media (pointer: fine)': '2rem' },
    height: { default: '2.75rem', '@media (pointer: fine)': '2rem' },
    padding: 0,
    borderWidth: 0,
    borderRadius: tokens['--xid-radius'],
    backgroundColor: 'transparent',
    color: tokens['--xid-fg'],
    cursor: 'pointer',
    outlineColor: tokens['--xid-accent'],
  },
  detailRow: {
    backgroundColor: tokens['--xid-muted'],
  },
  detailCell: {
    paddingBlock: '0 1.25rem',
    paddingInline: { default: '0.75rem', '@media (min-width: 64rem)': '9.5rem 3rem' },
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  detail: {
    display: 'flex',
    flexDirection: { default: 'column', '@media (min-width: 64rem)': 'row' },
    gap: { default: '1.25rem', '@media (min-width: 64rem)': '2rem' },
    position: 'sticky',
    insetInlineStart: 0,
    maxWidth: { default: 'calc(100vw - 2rem)', '@media (min-width: 64rem)': 'none' },
  },
  facts: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
    flexShrink: 0,
    width: { default: 'auto', '@media (min-width: 64rem)': '18.75rem' },
    margin: 0,
  },
  fact: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.125rem',
  },
  factLabel: {
    color: tokens['--xid-muted-foreground'],
    fontSize: text.xs,
    lineHeight: leading.xs,
  },
  factValue: {
    margin: 0,
    color: tokens['--xid-fg'],
    fontSize: text.base,
    lineHeight: leading.sm,
    fontVariantNumeric: 'tabular-nums',
  },
  link: {
    color: tokens['--xid-accent'],
    textDecoration: { default: 'none', ':hover': 'underline' },
  },
  json: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
    flex: '1 1 auto',
    minWidth: 0,
  },
  jsonHead: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '0.75rem',
  },
  jsonTitle: {
    margin: 0,
    color: tokens['--xid-fg'],
    fontSize: text.sm,
    fontWeight: weight.medium,
    lineHeight: leading.sm,
  },
  pre: {
    margin: 0,
    paddingBlock: '0.875rem',
    paddingInline: '1rem',
    overflowX: 'auto',
    borderRadius: tokens['--xid-radius'],
    boxShadow: `inset 0 0 0 1px ${tokens['--xid-border']}`,
    backgroundColor: tokens['--xid-surface'],
    color: tokens['--xid-fg'],
    fontFamily: tokens['--xid-font-mono'],
    fontSize: text.xs,
    lineHeight: '1.1875rem',
  },
})

function Strong({ children }: { children?: ReactNode }): ReactNode {
  return <span {...stylex.props(styles.strong)}>{children}</span>
}

function useNames(entry: AuditEntry): { actor: string; target: string } {
  const { t, i18n } = useLingui()
  const raw = entry.actor.displayName ?? entry.actorId ?? ''
  const name = entry.actor.kind === 'directory' ? scimProviderLabel(i18n, raw) : raw
  const actor =
    entry.actor.kind === 'system'
      ? t`XID`
      : entry.actor.kind === 'deleted_user'
        ? t`A deleted user`
        : entry.actor.kind === 'api_key'
          ? t`API key ${name}`
          : entry.actor.kind === 'directory'
            ? t`${name} directory sync`
            : name || t`Someone`
  const target = entry.targetDisplay ?? entry.targetId ?? ''
  return { actor, target }
}

// 常见事件写成完整句子;其余事件用通用句式,事件名在下一行原样给出。
function EventSentence({ entry }: { entry: AuditEntry }): ReactNode {
  const { actor, target } = useNames(entry)
  switch (entry.eventType) {
    case 'user.created':
      return (
        <Trans>
          <Strong>{actor}</Strong> created the user <Strong>{target}</Strong>
        </Trans>
      )
    case 'user.updated':
      return (
        <Trans>
          <Strong>{actor}</Strong> updated <Strong>{target}</Strong>
        </Trans>
      )
    case 'user.deleted':
      return (
        <Trans>
          <Strong>{actor}</Strong> deleted the user <Strong>{target}</Strong>
        </Trans>
      )
    case 'user.restored':
      return (
        <Trans>
          <Strong>{actor}</Strong> restored the user <Strong>{target}</Strong>
        </Trans>
      )
    case 'user.mfa_reset':
      return (
        <Trans>
          <Strong>{actor}</Strong> reset two-step verification for <Strong>{target}</Strong>
        </Trans>
      )
    case 'user.sessions_revoked':
      return (
        <Trans>
          <Strong>{actor}</Strong> signed <Strong>{target}</Strong> out everywhere
        </Trans>
      )
    case 'user.password_set':
      return (
        <Trans>
          <Strong>{actor}</Strong> set a new password for <Strong>{target}</Strong>
        </Trans>
      )
    case 'user.password_reset_requested':
      return (
        <Trans>
          <Strong>{actor}</Strong> sent a password reset to <Strong>{target}</Strong>
        </Trans>
      )
    case 'user.email_added':
      return (
        <Trans>
          <Strong>{actor}</Strong> added an email address to <Strong>{target}</Strong>
        </Trans>
      )
    case 'user.primary_email_changed':
      return (
        <Trans>
          <Strong>{actor}</Strong> changed the primary email address of <Strong>{target}</Strong>
        </Trans>
      )
    case 'user.exported':
      return (
        <Trans>
          <Strong>{actor}</Strong> exported users
        </Trans>
      )
    case 'auth.login_succeeded':
      return (
        <Trans>
          <Strong>{actor}</Strong> signed in
        </Trans>
      )
    case 'auth.login_failed':
      return <Trans>A sign-in attempt failed</Trans>
    case 'session.revoked':
      return (
        <Trans>
          <Strong>{actor}</Strong> ended a session
        </Trans>
      )
    case 'invitation.created':
      return (
        <Trans>
          <Strong>{actor}</Strong> invited <Strong>{target}</Strong>
        </Trans>
      )
    case 'invitation.accepted':
      return (
        <Trans>
          <Strong>{actor}</Strong> accepted an invitation
        </Trans>
      )
    case 'invitation.revoked':
      return (
        <Trans>
          <Strong>{actor}</Strong> revoked an invitation
        </Trans>
      )
    case 'membership.created':
      return (
        <Trans>
          <Strong>{actor}</Strong> added <Strong>{target}</Strong> as a member
        </Trans>
      )
    case 'membership.updated':
      return (
        <Trans>
          <Strong>{actor}</Strong> changed the role of <Strong>{target}</Strong>
        </Trans>
      )
    case 'membership.removed':
      return (
        <Trans>
          <Strong>{actor}</Strong> removed <Strong>{target}</Strong> from the organization
        </Trans>
      )
    case 'api_key.created':
      return (
        <Trans>
          <Strong>{actor}</Strong> created the API key <Strong>{target}</Strong>
        </Trans>
      )
    case 'api_key.revoked':
      return (
        <Trans>
          <Strong>{actor}</Strong> revoked the API key <Strong>{target}</Strong>
        </Trans>
      )
    case 'scim.user.deactivated':
      return (
        <Trans>
          <Strong>{actor}</Strong> deactivated <Strong>{target}</Strong>
        </Trans>
      )
    case 'scim.user.deleted':
      return (
        <Trans>
          <Strong>{actor}</Strong> deleted <Strong>{target}</Strong>
        </Trans>
      )
    case 'scim.user.reactivated':
      return (
        <Trans>
          <Strong>{actor}</Strong> reactivated <Strong>{target}</Strong>
        </Trans>
      )
    case 'sso_connection.created':
      return (
        <Trans>
          <Strong>{actor}</Strong> connected enterprise SSO
        </Trans>
      )
    case 'sso_connection.updated':
      return (
        <Trans>
          <Strong>{actor}</Strong> changed the enterprise SSO connection
        </Trans>
      )
    case 'organization.auth_policy.updated':
      return (
        <Trans>
          <Strong>{actor}</Strong> changed sign-in and MFA settings
        </Trans>
      )
    case 'webhook.created':
      return (
        <Trans>
          <Strong>{actor}</Strong> added a webhook endpoint
        </Trans>
      )
    case 'webhook.secret_rotated':
      return (
        <Trans>
          <Strong>{actor}</Strong> rotated a webhook signing secret
        </Trans>
      )
    default:
      return entry.targetId ? (
        <Trans>
          <Strong>{actor}</Strong> acted on <Strong>{target}</Strong>
        </Trans>
      ) : (
        <Trans>
          <Strong>{actor}</Strong> made a change
        </Trans>
      )
  }
}

function eventJson(entry: AuditEntry): string {
  return JSON.stringify(
    {
      action: entry.eventType,
      ts: entry.occurredAt,
      actor: { id: entry.actorId, type: entry.actor.kind },
      target: { id: entry.targetId, type: entry.targetType },
      payload: entry.payload,
      ip: entry.actorIp,
      seq: entry.seq,
      prev_hash: entry.prevHash,
    },
    null,
    2,
  )
}

function useSourceLine(entry: AuditEntry): { name: string; sub: string | null } {
  const { t, i18n } = useLingui()
  const provider =
    entry.actor.kind === 'directory' && entry.actor.displayName
      ? scimProviderLabel(i18n, entry.actor.displayName)
      : null
  const name = provider ? t`SCIM from ${provider}` : i18n._(SOURCE_LABELS[entry.source])
  const sub = entry.actorIp ?? (entry.source === 'scim' ? entry.actorId : null)
  return { name, sub }
}

function AuditDetail({ entry, orgId }: { entry: AuditEntry; orgId: string }): ReactNode {
  const { i18n } = useLingui()
  const { actor, target } = useNames(entry)
  const seq = i18n.number(entry.seq)
  const targetIsUser = entry.targetType === 'user' && entry.targetId
  return (
    <div {...stylex.props(styles.detail)}>
      <dl {...stylex.props(styles.facts)}>
        <div {...stylex.props(styles.fact)}>
          <dt {...stylex.props(styles.factLabel)}>
            <Trans>Actor</Trans>
          </dt>
          <dd {...stylex.props(styles.factValue)}>{actor}</dd>
          {entry.actorId && entry.actorId !== 'system' ? (
            <dd {...stylex.props(styles.mono)}>{entry.actorId}</dd>
          ) : null}
        </div>
        {entry.targetId ? (
          <div {...stylex.props(styles.fact)}>
            <dt {...stylex.props(styles.factLabel)}>
              <Trans>Target</Trans>
            </dt>
            <dd {...stylex.props(styles.factValue)}>
              {targetIsUser ? (
                <Link
                  to={orgPath(
                    `/console/org/users/${encodeURIComponent(entry.targetId ?? '')}`,
                    orgId,
                  )}
                  {...stylex.props(styles.link)}
                >
                  {target}
                </Link>
              ) : (
                target
              )}
            </dd>
            <dd {...stylex.props(styles.mono)}>{entry.targetId}</dd>
          </div>
        ) : null}
        <div {...stylex.props(styles.fact)}>
          <dt {...stylex.props(styles.factLabel)}>
            <Trans>Entry</Trans>
          </dt>
          <dd {...stylex.props(styles.factValue)}>
            <Trans>No. {seq} in the chain</Trans>
          </dd>
        </div>
      </dl>
      <div {...stylex.props(styles.json)}>
        <div {...stylex.props(styles.jsonHead)}>
          <p {...stylex.props(styles.jsonTitle)}>
            <Trans>Event JSON</Trans>
          </p>
          <CopyButton value={eventJson(entry)} subject="JSON" />
        </div>
        <pre {...stylex.props(styles.pre)}>{eventJson(entry)}</pre>
      </div>
    </div>
  )
}

export type AuditEventRowProps = {
  entry: AuditEntry
  orgId: string
  open: boolean
  onToggle: () => void
}

export function AuditEventRow({ entry, orgId, open, onToggle }: AuditEventRowProps): ReactNode {
  const { t, i18n } = useLingui()
  const occurred = new Date(entry.occurredAt)
  const day = i18n.date(occurred, { month: 'short', day: 'numeric', timeZone: 'UTC' })
  const time = i18n.date(occurred, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZone: 'UTC',
  })
  const source = useSourceLine(entry)
  const detailId = `audit-detail-${entry.id}`
  return (
    <>
      <tr onClick={onToggle} {...stylex.props(styles.row, open && styles.rowOpen)}>
        <td {...stylex.props(auditTable.cell, auditTable.timeCell, open && styles.timeOpen)}>
          <time dateTime={entry.occurredAt} {...stylex.props(styles.time)}>
            <span>{day}</span>
            <span {...stylex.props(styles.timePart)}>{time}</span>
          </time>
        </td>
        <td {...stylex.props(auditTable.cell)}>
          <p {...stylex.props(styles.sentence)}>
            <EventSentence entry={entry} />
          </p>
          <span {...stylex.props(styles.mono)}>{entry.eventType}</span>
        </td>
        <td {...stylex.props(auditTable.cell, auditTable.sourceCell)}>
          <span {...stylex.props(styles.sourceName)}>{source.name}</span>
          {source.sub ? <span {...stylex.props(styles.mono)}>{source.sub}</span> : null}
        </td>
        <td {...stylex.props(auditTable.cell, auditTable.toggleCell)}>
          <button
            type="button"
            aria-expanded={open}
            aria-controls={open ? detailId : undefined}
            aria-label={open ? t`Hide event details` : t`Show event details`}
            onClick={(event) => {
              event.stopPropagation()
              onToggle()
            }}
            {...stylex.props(styles.toggle)}
          >
            <Icon name={open ? 'caret-up' : 'caret-down'} size={16} />
          </button>
        </td>
      </tr>
      {open ? (
        <tr id={detailId} {...stylex.props(styles.detailRow)}>
          <td colSpan={4} {...stylex.props(styles.detailCell)}>
            <AuditDetail entry={entry} orgId={orgId} />
          </td>
        </tr>
      ) : null}
    </>
  )
}
