import { Trans, useLingui } from '@lingui/react/macro'
import * as stylex from '@stylexjs/stylex'
import type { LegacyColumnDef as ColumnDef } from '@tanstack/react-table/legacy'
import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { QueueDeadLetter, QueueDeadLetterReplay } from '@xid-kit/types'
import { Alert, Badge, Button } from '@xid-kit/web-ui/ui'
import { ConsolePage, ConsolePageNotice, ConsolePageSection } from '@xid-kit/web-ui/ui'
import { DataTable } from '@xid-kit/web-ui/ui/DataTable'
import { Pagination } from '@xid-kit/web-ui/ui/Pagination'
import { ConfirmDialog } from '@xid-kit/web-ui/ConfirmDialog'
import { useApiErrorMessage } from '@xid-kit/web-ui/api-error-message'
import { consoleShell } from '@xid-kit/web-ui/styles/product-surface.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { useDeadLettersList, useReplayDeadLetter } from './queries'

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
  muted: {
    display: 'block',
    fontSize: '0.75rem',
    color: tokens['--xid-muted-foreground'],
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

function ReplayOutcome({ result }: { result: QueueDeadLetterReplay }): ReactNode {
  if (result.replayed) {
    return (
      <Alert tone="success">
        <Trans>The message was replayed to its source queue.</Trans>
      </Alert>
    )
  }
  if (result.status === 'replaying') {
    return (
      <Alert tone="info">
        <Trans>Another replay of this message is still in progress. Check again later.</Trans>
      </Alert>
    )
  }
  return (
    <Alert tone="info">
      <Trans>This message had already been replayed. Nothing was sent again.</Trans>
    </Alert>
  )
}

export default function PlatformDeadLetters(): ReactNode {
  const { t } = useLingui()
  const errorMessage = useApiErrorMessage()
  const deadLetters = useDeadLettersList()
  const replay = useReplayDeadLetter()
  const resetReplay = replay.reset
  const [pendingReplay, setPendingReplay] = useState<QueueDeadLetter | null>(null)
  const [lastReplay, setLastReplay] = useState<QueueDeadLetterReplay | null>(null)
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
        id: 'tenant',
        header: () => <Trans>Tenant</Trans>,
        cell: ({ row }) =>
          row.original.tenantId ? (
            <span {...stylex.props(styles.mono)} title={row.original.tenantId}>
              {row.original.tenantId}
            </span>
          ) : (
            <span {...stylex.props(styles.muted)}>
              <Trans>Platform</Trans>
            </span>
          ),
      },
      {
        id: 'error',
        header: () => <Trans>Error</Trans>,
        cell: ({ row }) => (
          <div>
            <span {...stylex.props(styles.mono)} title={row.original.errorCode}>
              {row.original.errorCode}
            </span>
            {row.original.lastReplayErrorCode ? (
              <span {...stylex.props(styles.muted)}>
                <Trans>Last replay: {row.original.lastReplayErrorCode}</Trans>
              </span>
            ) : null}
          </div>
        ),
      },
      {
        id: 'attempts',
        header: () => <Trans>Attempts</Trans>,
        cell: ({ row }) => (
          <div>
            <span {...stylex.props(styles.time)}>{row.original.attempts}</span>
            <span {...stylex.props(styles.muted)}>
              <Trans>Replays: {row.original.replayCount}</Trans>
            </span>
          </div>
        ),
        meta: { width: '100px' },
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
          row.original.replayable ? (
            <Button
              variant="secondary"
              onClick={() => {
                resetReplay()
                setPendingReplay(row.original)
              }}
              aria-label={t`Replay message to ${row.original.sourceQueue}`}
              {...stylex.props(consoleShell.actionButton)}
            >
              <Trans>Replay</Trans>
            </Button>
          ) : null,
        meta: { width: '110px' },
      },
    ],
    [t, resetReplay],
  )

  function confirmReplay(): void {
    if (!pendingReplay) return
    replay.mutate(
      { id: pendingReplay.id },
      {
        onSuccess: (result) => {
          setLastReplay(result)
          setPendingReplay(null)
        },
      },
    )
  }

  return (
    <ConsolePage
      wide
      title={<Trans>Dead letters</Trans>}
      lead={
        <Trans>
          Inspect failed queue metadata and deliberately replay the KEK-encrypted original message.
        </Trans>
      }
    >
      {deadLetters.isError || lastReplay ? (
        <ConsolePageNotice>
          {deadLetters.isError ? (
            <Alert tone="error">
              <Trans>Failed to load dead letters.</Trans>
            </Alert>
          ) : null}
          {lastReplay ? <ReplayOutcome result={lastReplay} /> : null}
        </ConsolePageNotice>
      ) : null}

      <ConsolePageSection title={<Trans>Dead-letter records</Trans>}>
        <DataTable
          columns={columns}
          data={deadLetters.data?.data ?? []}
          getRowId={(row) => row.id}
          isLoading={deadLetters.isLoading}
          emptyMessage={<Trans>No dead letters found.</Trans>}
        />
        <Pagination query={deadLetters} loadMoreLabel={<Trans>Load more dead letters</Trans>} />
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
          error={replay.error ? errorMessage(replay.error, { surface: 'general' }) : undefined}
          onConfirm={confirmReplay}
          onCancel={() => setPendingReplay(null)}
        />
      ) : null}
    </ConsolePage>
  )
}
