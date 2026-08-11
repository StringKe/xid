
import { Trans, useLingui } from '@lingui/react/macro'
import * as stylex from '@stylexjs/stylex'
import type { LegacyColumnDef as ColumnDef } from '@tanstack/react-table/legacy'
import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Alert, Badge, Button } from '@xid-kit/web-ui/ui'
import { ConsolePage, ConsolePageNotice, ConsolePageSection } from '@xid-kit/web-ui/ui'
import { DataTable } from '@xid-kit/web-ui/ui/DataTable'
import { Pagination } from '@xid-kit/web-ui/ui/Pagination'
import { ConfirmDialog } from '@xid-kit/web-ui/ConfirmDialog'
import { consoleShell } from '@xid-kit/web-ui/styles/product-surface.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { useDeadLettersQuery, useReplayDeadLetter } from './queries'
import type { QueueDeadLetter } from './types'

const styles = stylex.create({
  mono: {
    display: 'block',
    maxWidth: '15rem',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontFamily: tokens['--xid-font-mono'],
    fontSize: '0.75rem',
  },
  time: {
    whiteSpace: 'nowrap',
    fontFamily: tokens['--xid-font-mono'],
    fontSize: '0.75rem',
    fontVariantNumeric: 'tabular-nums',
  },
})

function statusBadge(status: QueueDeadLetter['status']): ReactNode {
  if (status === 'pending')
    return (
      <Badge tone="warning">
        <Trans>Pending</Trans>
      </Badge>
    )
  if (status === 'replaying')
    return (
      <Badge tone="neutral">
        <Trans>Replaying</Trans>
      </Badge>
    )
  return (
    <Badge tone="success">
      <Trans>Replayed</Trans>
    </Badge>
  )
}

export default function PlatformDeadLetters(): ReactNode {
  const { t } = useLingui()
  const [cursor, setCursor] = useState<string | undefined>()
  const { data, isLoading, isError } = useDeadLettersQuery(cursor)
  const replay = useReplayDeadLetter()
  const [pendingReplay, setPendingReplay] = useState<QueueDeadLetter | null>(null)
  const columns = useMemo<ColumnDef<QueueDeadLetter>[]>(
    () => [
      {
        id: 'failedAt',
        header: () => <Trans>Failed at</Trans>,
        cell: ({ row }) => (
          <span {...stylex.props(styles.time)}>
            {new Date(row.original.failedAt).toLocaleString()}
          </span>
        ),
        meta: { width: '160px' },
      },
      {
        id: 'sourceQueue',
        header: () => <Trans>Source queue</Trans>,
        cell: ({ row }) => (
          <span {...stylex.props(styles.mono)} title={row.original.sourceQueue}>
            {row.original.sourceQueue}
          </span>
        ),
        meta: { width: '140px' },
      },
      {
        id: 'eventType',
        header: () => <Trans>Event type</Trans>,
        cell: ({ row }) => (
          <span {...stylex.props(styles.mono)} title={row.original.eventType}>
            {row.original.eventType}
          </span>
        ),
      },
      {
        id: 'messageId',
        header: () => <Trans>Message ID</Trans>,
        cell: ({ row }) => (
          <span {...stylex.props(styles.mono)} title={row.original.messageId}>
            {row.original.messageId}
          </span>
        ),
      },
      {
        id: 'status',
        header: () => <Trans>Status</Trans>,
        cell: ({ row }) => statusBadge(row.original.status),
        meta: { width: '110px' },
      },
      {
        id: 'actions',
        header: () => <Trans>Actions</Trans>,
        cell: ({ row }) =>
          row.original.status === 'pending' ? (
            <Button
              variant="secondary"
              onClick={() => setPendingReplay(row.original)}
              aria-label={t`Replay message to ${row.original.sourceQueue}`}
              {...stylex.props(consoleShell.actionButton)}
            >
              <Trans>Replay</Trans>
            </Button>
          ) : null,
        meta: { width: '110px' },
      },
    ],
    [t],
  )

  return (
    <ConsolePage
      title={<Trans>Dead letters</Trans>}
      lead={
        <Trans>
          Inspect failed queue metadata and deliberately replay the KEK-encrypted original message.
        </Trans>
      }
    >
      {isError || replay.isError || replay.isSuccess ? (
        <ConsolePageNotice>
          {isError ? (
            <Alert tone="error">
              <Trans>Failed to load dead letters.</Trans>
            </Alert>
          ) : null}
          {replay.isError ? (
            <Alert tone="error">
              <Trans>Failed to replay the dead letter. The message was not acknowledged.</Trans>
            </Alert>
          ) : null}
          {replay.isSuccess ? (
            <Alert tone="success">
              <Trans>The dead letter was replayed or had already been replayed.</Trans>
            </Alert>
          ) : null}
        </ConsolePageNotice>
      ) : null}

      <ConsolePageSection title={<Trans>Dead-letter records</Trans>}>
        <DataTable
          columns={columns}
          data={data?.data ?? []}
          getRowId={(row) => row.id}
          isLoading={isLoading}
          emptyMessage={<Trans>No dead letters found.</Trans>}
        />
        {data ? (
          <Pagination
            nextCursor={data.nextCursor}
            loadMoreLabel={<Trans>Load more dead letters</Trans>}
            onLoadMore={setCursor}
          />
        ) : null}
      </ConsolePageSection>

      {pendingReplay ? (
        <ConfirmDialog
          title={<Trans>Replay dead letter?</Trans>}
          description={
            <Trans>
              The encrypted message {pendingReplay.messageId} will be replayed to{' '}
              {pendingReplay.sourceQueue}.
            </Trans>
          }
          confirmLabel={<Trans>Replay</Trans>}
          confirmVariant="primary"
          isLoading={replay.isPending}
          onConfirm={() => {
            replay.mutate({ id: pendingReplay.id })
            setPendingReplay(null)
          }}
          onCancel={() => setPendingReplay(null)}
        />
      ) : null}
    </ConsolePage>
  )
}
