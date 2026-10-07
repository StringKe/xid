import { Trans } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { FormattedDate } from '../../components/FormattedDate'
import type { DataTableColumnDef as ColumnDef } from '@xid-kit/web-ui/ui/DataTable'
import type { PlatformAuditEvent } from '@xid-kit/types'
import { Alert } from '@xid-kit/web-ui/ui'
import { ConsolePage, ConsolePageNotice, ConsolePageSection } from '@xid-kit/web-ui/ui'
import { DataTable } from '@xid-kit/web-ui/ui/DataTable'
import { LoadMore } from '@xid-kit/web-ui/ui/LoadMore'
import { organizationDisplayName } from '@xid-kit/web-ui/display-names'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { AuditChainVerifyPanel } from './AuditChainVerifyPanel'
import { useGlobalAuditEventsList } from './queries'

const styles = stylex.create({
  seqText: {
    fontFamily: tokens['--xid-font-mono'],
    fontSize: '0.8125rem',
    fontVariantNumeric: 'tabular-nums',
    color: tokens['--xid-muted-foreground'],
  },
  timeText: {
    whiteSpace: 'nowrap',
    fontFamily: tokens['--xid-font-mono'],
    fontSize: '0.8125rem',
    fontVariantNumeric: 'tabular-nums',
  },
  // 用 span 不用 code:全局 :not(pre)>code 在窄屏会 white-space:normal 拆断 token。
  codeTag: {
    fontFamily: tokens['--xid-font-mono'],
    fontSize: '0.8125rem',
    background: tokens['--xid-muted'],
    paddingBlock: '0.125rem',
    paddingInline: '0.375rem',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: tokens['--xid-border'],
    borderRadius: tokens['--xid-radius-sm'],
    whiteSpace: 'nowrap',
  },
  mutedSmall: {
    fontSize: '0.8125rem',
    color: tokens['--xid-muted-foreground'],
  },
  // 裸 ID 单行截断 + title 全文,避免多行 UUID。
  actorId: {
    display: 'block',
    maxWidth: '100%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  actorIp: {
    display: 'block',
    fontFamily: tokens['--xid-font-mono'],
    fontSize: '0.75rem',
    fontVariantNumeric: 'tabular-nums',
  },
  targetId: {
    display: 'block',
    fontFamily: tokens['--xid-font-mono'],
    fontSize: '0.75rem',
    maxWidth: '100%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
})

const columns: ColumnDef<PlatformAuditEvent>[] = [
  {
    id: 'seq',
    header: () => <Trans>Seq</Trans>,
    cell: ({ row }) => <span {...stylex.props(styles.seqText)}>{row.original.seq}</span>,
    meta: { width: '80px' },
  },
  {
    id: 'occurred',
    header: () => <Trans>Time</Trans>,
    cell: ({ row }) => (
      <span {...stylex.props(styles.timeText)}>
        <FormattedDate value={row.original.occurredAt} time />
      </span>
    ),
    meta: { width: '160px' },
  },
  {
    id: 'organization',
    header: () => <Trans>Organization</Trans>,
    cell: ({ row }) =>
      row.original.organizationName
        ? organizationDisplayName({ name: row.original.organizationName })
        : row.original.organizationId,
    meta: { width: '140px' },
  },
  {
    id: 'event',
    header: () => <Trans>Event type</Trans>,
    cell: ({ row }) => <span {...stylex.props(styles.codeTag)}>{row.original.eventType}</span>,
  },
  {
    id: 'actor',
    header: () => <Trans>Actor</Trans>,
    cell: ({ row }) => (
      <span {...stylex.props(styles.mutedSmall)}>
        {row.original.actorDisplay ? (
          <span
            {...stylex.props(styles.actorId)}
            title={
              row.original.actorDisplay === row.original.actorId
                ? (row.original.actorId ?? undefined)
                : undefined
            }
          >
            {row.original.actorDisplay}
          </span>
        ) : (
          <Trans>system</Trans>
        )}
        {row.original.actorIp ? (
          <span {...stylex.props(styles.actorIp)}>{row.original.actorIp}</span>
        ) : null}
      </span>
    ),
    meta: { width: '160px' },
  },
  {
    id: 'target',
    header: () => <Trans>Target</Trans>,
    cell: ({ row }) =>
      row.original.targetType ? (
        <span {...stylex.props(styles.mutedSmall)}>
          {row.original.targetType}
          {row.original.targetId ? (
            <span {...stylex.props(styles.targetId)} title={row.original.targetId}>
              {row.original.targetId}
            </span>
          ) : null}
        </span>
      ) : null,
    meta: { width: '160px' },
  },
]

export default function PlatformAuditEvents(): ReactNode {
  const events = useGlobalAuditEventsList()

  return (
    <ConsolePage
      wide
      title={<Trans>Global event stream</Trans>}
      lead={
        <Trans>
          Audit events from every organization on this instance, with per-tenant hash-chain
          verification.
        </Trans>
      }
    >
      {events.isError ? (
        <ConsolePageNotice>
          <Alert tone="error">
            <Trans>Failed to load audit events. Please try again.</Trans>
          </Alert>
        </ConsolePageNotice>
      ) : null}

      <AuditChainVerifyPanel />

      <ConsolePageSection title={<Trans>Event stream</Trans>}>
        <DataTable
          columns={columns}
          data={events.data?.data ?? []}
          getRowId={(row) => row.id}
          isLoading={events.isLoading}
          emptyMessage={<Trans>No audit events found.</Trans>}
        />
        <LoadMore query={events} loadMoreLabel={<Trans>Load more events</Trans>} />
      </ConsolePageSection>
    </ConsolePage>
  )
}
