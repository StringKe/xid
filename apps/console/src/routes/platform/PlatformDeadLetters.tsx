import type { I18n } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { Plural, Trans, useLingui } from '@lingui/react/macro'
import * as stylex from '@stylexjs/stylex'
import { useCallback, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Alert, Badge, Button, Checkbox, Select } from '@xid-kit/web-ui/ui'
import { ConsolePage, ConsolePageNotice, ConsolePageSection } from '@xid-kit/web-ui/ui'
import { DataTable } from '@xid-kit/web-ui/ui/DataTable'
import type { DataTableColumnDef as ColumnDef } from '@xid-kit/web-ui/ui/DataTable'
import { Pagination } from '@xid-kit/web-ui/ui/Pagination'
import { ConfirmDialog } from '@xid-kit/web-ui/ConfirmDialog'
import { useApiErrorMessage } from '@xid-kit/web-ui/api-error-message'
import { text, weight } from '@xid-kit/web-ui/styles/scale.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { useDeadLetterPage, useReplayDeadLetters } from './ops-queries'
import type { DeadLetterBatchReplay, DeadLetterQueueCount, PlatformDeadLetter } from './ops-queries'

const MAX_BATCH = 25
const LEASE_MS = 5 * 60 * 1000
const NARROW = '@media (max-width: 40rem)'

const styles = stylex.create({
  chips: {
    display: { default: 'flex', [NARROW]: 'none' },
    flexWrap: 'wrap',
    gap: '0.375rem',
  },
  chip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.375rem',
    minHeight: '2rem',
    paddingInline: '0.75rem',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: tokens['--xid-border-strong'],
    borderRadius: tokens['--xid-radius-full'],
    backgroundColor: tokens['--xid-bg'],
    color: tokens['--xid-fg'],
    fontFamily: tokens['--xid-font-mono'],
    fontSize: text.sm,
    cursor: 'pointer',
  },
  chipAll: {
    fontFamily: tokens['--xid-font'],
  },
  chipEmpty: {
    borderColor: tokens['--xid-border'],
    color: tokens['--xid-muted-foreground'],
  },
  chipActive: {
    borderColor: tokens['--xid-fg'],
    backgroundColor: tokens['--xid-fg'],
    color: tokens['--xid-bg'],
  },
  chipCount: {
    opacity: 0.75,
    fontVariantNumeric: 'tabular-nums',
  },
  queueSelect: {
    display: { default: 'none', [NARROW]: 'block' },
  },
  selectionBar: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '0.75rem',
    padding: '0.625rem 0.75rem',
    borderRadius: tokens['--xid-radius'],
    backgroundColor: tokens['--xid-muted'],
    fontSize: text.base,
  },
  selectionText: {
    fontWeight: weight.medium,
  },
  clear: {
    padding: 0,
    borderWidth: 0,
    backgroundColor: 'transparent',
    color: tokens['--xid-accent'],
    fontSize: text.sm,
    cursor: 'pointer',
  },
  selectionAction: {
    marginInlineStart: 'auto',
  },
  primary: {
    display: 'block',
    color: tokens['--xid-fg'],
    fontSize: text.base,
  },
  secondary: {
    display: 'block',
    color: tokens['--xid-muted-foreground'],
    fontSize: text.xs,
  },
  mono: {
    fontFamily: tokens['--xid-font-mono'],
  },
  dimmed: {
    opacity: 0.6,
  },
  time: {
    whiteSpace: 'nowrap',
    fontVariantNumeric: 'tabular-nums',
  },
  footer: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '0.75rem',
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
  },
  bullets: {
    display: 'grid',
    gap: '0.5rem',
    margin: 0,
    paddingInlineStart: '1.125rem',
    color: tokens['--xid-fg'],
    fontSize: text.base,
    lineHeight: 1.5,
  },
})

type Selection = { queue: string; ids: string[] }

function arrivedAt(i18n: I18n, iso: string): string {
  return i18n.date(new Date(iso), {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
}

function leaseLeft(row: PlatformDeadLetter): string {
  const requested = row.replayRequestedAt ? new Date(row.replayRequestedAt).getTime() : Date.now()
  const left = Math.max(0, requested + LEASE_MS - Date.now())
  const minutes = Math.floor(left / 60_000)
  const seconds = Math.floor((left % 60_000) / 1000)
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

function LastFailure({ row }: { row: PlatformDeadLetter }): ReactNode {
  const attempts = row.attempts
  if (row.status === 'replaying') {
    const lease = leaseLeft(row)
    return (
      <>
        <span {...stylex.props(styles.primary)}>
          <Trans>Replay in progress</Trans>
        </span>
        <span {...stylex.props(styles.secondary)}>
          <Trans>Lease {lease} left</Trans>
        </span>
      </>
    )
  }
  const replayError = row.lastReplayErrorCode
  return (
    <>
      <span {...stylex.props(styles.primary)}>
        {replayError ? <Trans>Last replay failed</Trans> : <Trans>Retries exhausted</Trans>}
      </span>
      <span {...stylex.props(styles.secondary)}>
        {replayError ? (
          <span {...stylex.props(styles.mono)}>{replayError}</span>
        ) : (
          <Plural value={attempts} one="After # retry" other="After # retries" />
        )}
      </span>
    </>
  )
}

function StatusBadge({ row }: { row: PlatformDeadLetter }): ReactNode {
  if (row.status === 'replaying') {
    return (
      <Badge tone="info">
        <Trans>Replaying</Trans>
      </Badge>
    )
  }
  return (
    <Badge tone="warning">
      <Trans>Quarantined</Trans>
    </Badge>
  )
}

function QueueFilter({
  counts,
  queue,
  onChange,
}: {
  counts: readonly DeadLetterQueueCount[]
  queue: string | null
  onChange: (queue: string | null) => void
}): ReactNode {
  const { t } = useLingui()
  const total = counts.reduce((sum, entry) => sum + entry.count, 0)
  return (
    <>
      <div role="group" aria-label={t`Source queue`} {...stylex.props(styles.chips)}>
        <button
          type="button"
          aria-pressed={queue === null}
          onClick={() => onChange(null)}
          {...stylex.props(styles.chip, styles.chipAll, queue === null && styles.chipActive)}
        >
          <Trans>All queues</Trans>
          <span {...stylex.props(styles.chipCount)}>{total}</span>
        </button>
        {counts.map((entry) => (
          <button
            key={entry.queue}
            type="button"
            aria-pressed={queue === entry.queue}
            onClick={() => onChange(entry.queue)}
            {...stylex.props(
              styles.chip,
              entry.count === 0 && styles.chipEmpty,
              queue === entry.queue && styles.chipActive,
            )}
          >
            {entry.queue}
            <span {...stylex.props(styles.chipCount)}>{entry.count}</span>
          </button>
        ))}
      </div>
      <div {...stylex.props(styles.queueSelect)}>
        <Select
          aria-label={t`Queue`}
          value={queue ?? ''}
          onChange={(event) => onChange(event.target.value || null)}
        >
          <option value="">{t`All queues, ${total} waiting`}</option>
          {counts.map((entry) => (
            <option key={entry.queue} value={entry.queue}>
              {t`${entry.queue}, ${entry.count} waiting`}
            </option>
          ))}
        </Select>
      </div>
    </>
  )
}

function ReplayOutcome({ result }: { result: DeadLetterBatchReplay }): ReactNode {
  const replayed = result.results.filter((item) => item.outcome === 'replayed').length
  const held = result.results.filter((item) => item.outcome === 'lease_held').length
  const already = result.results.filter((item) => item.outcome === 'already_replayed').length
  const failedItems = result.results.filter((item) => item.outcome === 'failed')
  const needsOperator = failedItems.filter((item) => item.reason === 'needs_operator').length
  const failed = failedItems.length - needsOperator
  return (
    <Alert tone={needsOperator > 0 ? 'error' : failed > 0 ? 'warning' : 'success'}>
      <Plural value={replayed} one="# message was sent back." other="# messages were sent back." />
      {held > 0 ? (
        <>
          {' '}
          <Plural
            value={held}
            one="# is still held by another replay."
            other="# are still held by another replay."
          />
        </>
      ) : null}
      {already > 0 ? (
        <>
          {' '}
          <Plural
            value={already}
            one="# had already been replayed."
            other="# had already been replayed."
          />
        </>
      ) : null}
      {failed > 0 ? (
        <>
          {' '}
          <Plural
            value={failed}
            one="# failed and stays quarantined."
            other="# failed and stay quarantined."
          />
        </>
      ) : null}
      {needsOperator > 0 ? (
        <>
          {' '}
          <Plural
            value={needsOperator}
            one="# could not be completed because its record is inconsistent. Check the Core logs before retrying."
            other="# could not be completed because their records are inconsistent. Check the Core logs before retrying."
          />
        </>
      ) : null}
    </Alert>
  )
}

function organizationBreakdown(i18n: I18n, rows: readonly PlatformDeadLetter[]): string {
  const counts = new Map<string, number>()
  for (const row of rows) {
    const name = row.organizationName ?? row.tenantId ?? i18n._(msg`the platform`)
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return new Intl.ListFormat(i18n.locale, { type: 'conjunction' }).format(
    [...counts].map(([name, count]) => i18n._(msg`${count} for ${name}`)),
  )
}

function ReplayDialog({
  selection,
  rows,
  isLoading,
  error,
  onConfirm,
  onCancel,
}: {
  selection: Selection
  rows: readonly PlatformDeadLetter[]
  isLoading: boolean
  error: ReactNode
  onConfirm: () => void
  onCancel: () => void
}): ReactNode {
  const { i18n } = useLingui()
  const count = selection.ids.length
  const queue = selection.queue
  const breakdown = organizationBreakdown(
    i18n,
    rows.filter((row) => selection.ids.includes(row.id)),
  )
  return (
    <ConfirmDialog
      title={
        <Plural
          value={count}
          one={`Replay # message to ${queue}`}
          other={`Replay # messages to ${queue}`}
        />
      }
      description={<Trans>{breakdown}. Each goes back only to the queue it came from.</Trans>}
      confirmLabel={<Plural value={count} one="Replay # message" other="Replay # messages" />}
      confirmVariant="primary"
      isLoading={isLoading}
      error={error}
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      <ul {...stylex.props(styles.bullets)}>
        <li>
          <Trans>
            Core decrypts each message and sends it to {queue}. You never see the contents.
          </Trans>
        </li>
        <li>
          <Trans>
            Delivery is at least once. If an earlier attempt partly succeeded, the receiver may get
            the message twice.
          </Trans>
        </li>
        <li>
          <Trans>
            You hold each message for 5 minutes while it replays. If it fails again, it returns here
            as Quarantined.
          </Trans>
        </li>
      </ul>
    </ConfirmDialog>
  )
}

function useColumns(
  selection: Selection | null,
  toggle: (row: PlatformDeadLetter) => void,
): ColumnDef<PlatformDeadLetter>[] {
  const { i18n, t } = useLingui()
  return useMemo<ColumnDef<PlatformDeadLetter>[]>(
    () => [
      {
        id: 'select',
        header: () => null,
        cell: ({ row }) => {
          const blocked =
            !row.original.replayable ||
            (selection !== null && selection.queue !== row.original.sourceQueue)
          return (
            <Checkbox
              aria-label={t`Select ${row.original.id}`}
              checked={selection?.ids.includes(row.original.id) ?? false}
              disabled={blocked}
              onClick={(event) => event.stopPropagation()}
              onChange={() => toggle(row.original)}
            />
          )
        },
        meta: { width: '2.5rem' },
      },
      {
        id: 'arrived',
        header: () => <Trans>Arrived</Trans>,
        cell: ({ row }) => (
          <span {...stylex.props(styles.time)}>{arrivedAt(i18n, row.original.failedAt)}</span>
        ),
        meta: { width: '8.5rem' },
      },
      {
        id: 'message',
        header: () => <Trans>Message</Trans>,
        cell: ({ row }) => (
          <>
            <span {...stylex.props(styles.primary)}>{row.original.eventType}</span>
            <span {...stylex.props(styles.secondary, styles.mono)}>{row.original.id}</span>
          </>
        ),
      },
      {
        id: 'queue',
        header: () => <Trans>Source queue</Trans>,
        cell: ({ row }) => <span {...stylex.props(styles.mono)}>{row.original.sourceQueue}</span>,
        meta: { width: '9rem' },
      },
      {
        id: 'organization',
        header: () => <Trans>Organization</Trans>,
        cell: ({ row }) =>
          row.original.organizationName ?? row.original.tenantId ?? <Trans>Platform</Trans>,
        meta: { width: '10rem' },
      },
      {
        id: 'failure',
        header: () => <Trans>Last failure</Trans>,
        cell: ({ row }) => <LastFailure row={row.original} />,
        meta: { width: '13rem' },
      },
      {
        id: 'status',
        header: () => <Trans>Status</Trans>,
        cell: ({ row }) => <StatusBadge row={row.original} />,
        meta: { width: '7.5rem' },
      },
    ],
    [i18n, t, selection, toggle],
  )
}

export default function PlatformDeadLetters(): ReactNode {
  const errorMessage = useApiErrorMessage()
  const [queue, setQueue] = useState<string | null>(null)
  const [cursors, setCursors] = useState<Array<string | null>>([null])
  const cursor = cursors[cursors.length - 1] ?? null
  const page = useDeadLetterPage({ queue, cursor })
  const replay = useReplayDeadLetters()
  const [selection, setSelection] = useState<Selection | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [lastReplay, setLastReplay] = useState<DeadLetterBatchReplay | null>(null)
  const rows = page.data?.data ?? []

  function changeQueue(next: string | null): void {
    setQueue(next)
    setCursors([null])
    setSelection(null)
  }

  const toggle = useCallback((row: PlatformDeadLetter): void => {
    if (!row.replayable) return
    setSelection((current) => {
      // 批量重放只接受同一来源队列:已有选择时忽略其他队列的行。
      if (!current) return { queue: row.sourceQueue, ids: [row.id] }
      if (current.queue !== row.sourceQueue) return current
      const ids = current.ids.includes(row.id)
        ? current.ids.filter((id) => id !== row.id)
        : current.ids.length < MAX_BATCH
          ? [...current.ids, row.id]
          : current.ids
      return ids.length === 0 ? null : { queue: current.queue, ids }
    })
  }, [])

  const columns = useColumns(selection, toggle)

  function confirmReplay(): void {
    if (!selection) return
    replay.mutate(
      { ids: selection.ids },
      {
        onSuccess: (result) => {
          setLastReplay(result)
          setSelection(null)
          setConfirming(false)
        },
      },
    )
  }

  const count = selection?.ids.length ?? 0
  const selectedQueue = selection?.queue ?? ''

  return (
    <ConsolePage
      wide
      title={<Trans>Dead letters</Trans>}
      lead={
        <Trans>
          Queue messages that ran out of retries. You see redacted metadata only; the message stays
          encrypted in Core and goes back to the queue it came from.
        </Trans>
      }
    >
      {page.isError || lastReplay ? (
        <ConsolePageNotice>
          {page.isError ? (
            <Alert tone="error">
              <Trans>Dead letters could not be loaded.</Trans>{' '}
              <Button variant="secondary" onClick={() => void page.refetch()}>
                <Trans>Try again</Trans>
              </Button>
            </Alert>
          ) : null}
          {lastReplay ? <ReplayOutcome result={lastReplay} /> : null}
        </ConsolePageNotice>
      ) : null}

      <ConsolePageSection>
        <QueueFilter counts={page.data?.countsByQueue ?? []} queue={queue} onChange={changeQueue} />

        {selection ? (
          <div {...stylex.props(styles.selectionBar)}>
            <span {...stylex.props(styles.selectionText)}>
              <Plural
                value={count}
                one={`# selected from ${selectedQueue}`}
                other={`# selected from ${selectedQueue}`}
              />
            </span>
            <button
              type="button"
              onClick={() => setSelection(null)}
              {...stylex.props(styles.clear)}
            >
              <Trans>Clear</Trans>
            </button>
            <span {...stylex.props(styles.selectionAction)}>
              <Button
                onClick={() => {
                  replay.reset()
                  setConfirming(true)
                }}
              >
                <Plural value={count} one="Replay # message…" other="Replay # messages…" />
              </Button>
            </span>
          </div>
        ) : null}

        <DataTable
          columns={columns}
          data={rows}
          getRowId={(row) => row.id}
          isLoading={page.isLoading}
          narrowMode="scroll"
          onRowClick={toggle}
          isRowSelected={(row) => selection?.ids.includes(row.id) ?? false}
          emptyMessage={<Trans>No messages are waiting. Every queue delivered its work.</Trans>}
        />

        <div {...stylex.props(styles.footer)}>
          <span>
            <Trans>
              Replay uses a 5-minute claim so two managers cannot send the same message at once.
            </Trans>
          </span>
          <Pagination
            hasPrevious={cursors.length > 1}
            hasNext={Boolean(page.data?.nextCursor)}
            isLoading={page.isFetching}
            onPrevious={() => setCursors((stack) => stack.slice(0, -1))}
            onNext={() => {
              const next = page.data?.nextCursor
              if (next) setCursors((stack) => [...stack, next])
            }}
          />
        </div>
      </ConsolePageSection>

      {confirming && selection ? (
        <ReplayDialog
          selection={selection}
          rows={rows}
          isLoading={replay.isPending}
          error={replay.error ? errorMessage(replay.error, { surface: 'general' }) : undefined}
          onConfirm={confirmReplay}
          onCancel={() => setConfirming(false)}
        />
      ) : null}
    </ConsolePage>
  )
}
