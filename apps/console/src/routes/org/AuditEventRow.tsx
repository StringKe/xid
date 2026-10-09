// 审计日志的一行:时间、谁对谁做了什么、来源渠道;展开后给出 actor / target / 链上位置与事件 JSON。
// 城市不显示:GeoIP 未实现,来源只给渠道和 IP。

import { useLingui } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Icon } from '@xid-kit/web-ui/ui'
import { leading, text } from '@xid-kit/web-ui/styles/scale.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { AuditDetail } from './AuditEventDetail'
import { EventSentence } from './AuditEventSentence'
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
})

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
