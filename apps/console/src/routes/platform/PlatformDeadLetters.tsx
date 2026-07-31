import { Trans, useLingui } from '@lingui/react/macro'
import * as stylex from '@stylexjs/stylex'
import type { ColumnDef } from '@tanstack/react-table'
import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Alert, Badge, Button } from '@xid-kit/web-ui/ui'
import { DataTable } from '@xid-kit/web-ui/ui/DataTable'
import { Pagination } from '@xid-kit/web-ui/ui/Pagination'
import { page } from '@xid-kit/web-ui/styles/product-surface.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { useDeadLettersQuery, useReplayDeadLetter } from './queries'
import type { QueueDeadLetter } from './types'

const styles = stylex.create({
  section: {
    paddingInline: 'clamp(1rem, 2.5vw, 4rem)',
    paddingBlock: 'clamp(1.5rem, 1.6vw, 2.5rem)',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
  },
  sectionHeader: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: '0.75rem',
    marginBottom: '1rem',
  },
  title: {
    margin: 0,
    fontSize: '1.125rem',
    fontWeight: 620,
    color: tokens['--xid-fg'],
  },
  description: {
    margin: 0,
    fontSize: '0.8125rem',
    color: tokens['--xid-muted-foreground'],
  },
  message: {
    marginBottom: '1rem',
  },
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
  pagination: {
    marginTop: '0.75rem',
  },
  replayButton: {
    minHeight: '2rem',
    paddingBlock: 0,
    paddingInline: '0.75rem',
    fontSize: '0.8125rem',
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
              isLoading={replay.isPending && replay.variables?.id === row.original.id}
              onClick={() => {
                if (
                  window.confirm(t`Replay this encrypted message to ${row.original.sourceQueue}?`)
                ) {
                  replay.mutate({ id: row.original.id })
                }
              }}
              {...stylex.props(styles.replayButton)}
            >
              <Trans>Replay</Trans>
            </Button>
          ) : null,
        meta: { width: '110px' },
      },
    ],
    [replay, t],
  )

  return (
    <section aria-labelledby="dead-letter-heading" {...stylex.props(styles.section)}>
      <div {...stylex.props(styles.sectionHeader)}>
        <div>
          <h2 id="dead-letter-heading" {...stylex.props(styles.title)}>
            <Trans>Dead-letter queue</Trans>
          </h2>
          <p {...stylex.props(styles.description)}>
            <Trans>
              Inspect failed queue metadata and deliberately replay the KEK-encrypted original
              message.
            </Trans>
          </p>
        </div>
      </div>

      {isError ? (
        <div {...stylex.props(styles.message)}>
          <Alert tone="error">
            <Trans>Failed to load dead letters. Please try again.</Trans>
          </Alert>
        </div>
      ) : null}
      {replay.isError ? (
        <div {...stylex.props(styles.message)}>
          <Alert tone="error">
            <Trans>Failed to replay the dead letter. The message was not acknowledged.</Trans>
          </Alert>
        </div>
      ) : null}
      {replay.isSuccess ? (
        <div {...stylex.props(styles.message)}>
          <Alert tone="success">
            <Trans>The dead letter was replayed or had already been replayed.</Trans>
          </Alert>
        </div>
      ) : null}

      <h3 {...stylex.props(page.visuallyHidden)}>
        <Trans>Dead-letter records</Trans>
      </h3>
      <DataTable
        columns={columns}
        data={data?.data ?? []}
        getRowId={(row) => row.id}
        isLoading={isLoading}
        emptyMessage={<Trans>No dead letters found.</Trans>}
      />
      {data ? (
        <div {...stylex.props(styles.pagination)}>
          <Pagination
            nextCursor={data.nextCursor}
            loadMoreLabel={<Trans>Load more dead letters</Trans>}
            onLoadMore={setCursor}
          />
        </div>
      ) : null}
    </section>
  )
}
