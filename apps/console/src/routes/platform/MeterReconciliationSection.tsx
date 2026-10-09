import { Trans, useLingui } from '@lingui/react/macro'
import * as stylex from '@stylexjs/stylex'
import { useCallback, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, ConsolePageSection } from '@xid-kit/web-ui/ui'
import { DataTable } from '@xid-kit/web-ui/ui/DataTable'
import type { DataTableColumnDef as ColumnDef } from '@xid-kit/web-ui/ui/DataTable'
import { ConfirmDialog } from '@xid-kit/web-ui/ConfirmDialog'
import { useApiErrorMessage } from '@xid-kit/web-ui/api-error-message'
import { organizationDisplayName } from '@xid-kit/web-ui/display-names'
import { text } from '@xid-kit/web-ui/styles/scale.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import {
  useMeterReconciliations,
  useResolveMeterReconciliation,
  type MeterReconciliation,
  type MeterReconciliationAction,
} from './billing-queries'

const styles = stylex.create({
  lead: {
    margin: 0,
    maxWidth: '48rem',
    color: tokens['--xid-muted-foreground'],
    fontSize: text.base,
    lineHeight: 1.55,
  },
  mono: {
    fontFamily: tokens['--xid-font-mono'],
    fontSize: text.sm,
    wordBreak: 'break-all',
  },
  numeric: {
    fontFamily: tokens['--xid-font-mono'],
    fontVariantNumeric: 'tabular-nums',
  },
  actions: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '0.5rem',
  },
})

type Pending = { row: MeterReconciliation; action: MeterReconciliationAction }

function ResolveDialog({
  pending,
  isLoading,
  error,
  onConfirm,
  onCancel,
}: {
  pending: Pending
  isLoading: boolean
  error: ReactNode
  onConfirm: () => void
  onCancel: () => void
}): ReactNode {
  const identifier = pending.row.identifier
  const value = pending.row.value.toLocaleString()
  const isReportAgain = pending.action === 'report_again'
  return (
    <ConfirmDialog
      title={
        isReportAgain ? (
          <Trans>Report again to Stripe</Trans>
        ) : (
          <Trans>Mark as received by Stripe</Trans>
        )
      }
      description={
        isReportAgain ? (
          <Trans>
            Do this only after you confirmed that Stripe has no event {identifier}. XID sends the{' '}
            {value} MAU again under a new event ID.
          </Trans>
        ) : (
          <Trans>
            Do this only after you found event {identifier} in Stripe. XID records the {value} MAU
            as reported and does not send it again.
          </Trans>
        )
      }
      confirmLabel={isReportAgain ? <Trans>Report again</Trans> : <Trans>Mark as reported</Trans>}
      confirmVariant="primary"
      isLoading={isLoading}
      error={error}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  )
}

function useColumns(onAction: (pending: Pending) => void): ColumnDef<MeterReconciliation>[] {
  const { i18n } = useLingui()
  return useMemo<ColumnDef<MeterReconciliation>[]>(
    () => [
      {
        id: 'organization',
        header: () => <Trans>Organization</Trans>,
        cell: ({ row }) =>
          organizationDisplayName({ name: row.original.organizationName ?? row.original.tenantId }),
      },
      {
        id: 'month',
        header: () => <Trans>Month</Trans>,
        cell: ({ row }) =>
          i18n.date(new Date(`${row.original.period}-01T00:00:00.000Z`), {
            year: 'numeric',
            month: 'short',
            timeZone: 'UTC',
          }),
        meta: { width: '7rem' },
      },
      {
        id: 'value',
        header: () => <Trans>MAU added</Trans>,
        cell: ({ row }) => (
          <span {...stylex.props(styles.numeric)}>{row.original.value.toLocaleString()}</span>
        ),
        meta: { width: '7rem' },
      },
      {
        id: 'identifier',
        header: () => <Trans>Stripe event ID</Trans>,
        cell: ({ row }) => <span {...stylex.props(styles.mono)}>{row.original.identifier}</span>,
      },
      {
        id: 'since',
        header: () => <Trans>Waiting since</Trans>,
        cell: ({ row }) =>
          i18n.date(new Date(row.original.reconciliationRequiredAt), {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
          }),
        meta: { width: '8.5rem' },
      },
      {
        id: 'actions',
        header: () => <Trans>Actions</Trans>,
        cell: ({ row }) => (
          <div {...stylex.props(styles.actions)}>
            <Button
              variant="secondary"
              onClick={() => onAction({ row: row.original, action: 'mark_reported' })}
            >
              <Trans>Mark as reported…</Trans>
            </Button>
            <Button
              variant="secondary"
              onClick={() => onAction({ row: row.original, action: 'report_again' })}
            >
              <Trans>Report again…</Trans>
            </Button>
          </div>
        ),
        meta: { width: '19rem' },
      },
    ],
    [i18n, onAction],
  )
}

export function MeterReconciliationSection({ enabled }: { enabled: boolean }): ReactNode {
  const errorMessage = useApiErrorMessage()
  const reports = useMeterReconciliations(enabled)
  const resolve = useResolveMeterReconciliation()
  const [pending, setPending] = useState<Pending | null>(null)
  const resetResolve = resolve.reset
  const openDialog = useCallback(
    (next: Pending) => {
      resetResolve()
      setPending(next)
    },
    [resetResolve],
  )
  const columns = useColumns(openDialog)
  const rows = reports.data?.data ?? []
  if (!enabled || rows.length === 0) return null

  function confirm(): void {
    if (!pending) return
    resolve.mutate(
      {
        tenantId: pending.row.tenantId,
        period: pending.row.period,
        identifier: pending.row.identifier,
        action: pending.action,
      },
      { onSuccess: () => setPending(null) },
    )
  }

  return (
    <ConsolePageSection title={<Trans>MAU reports to check in Stripe</Trans>}>
      <p {...stylex.props(styles.lead)}>
        <Trans>
          Stripe did not confirm these reports, and sending them again could bill twice. Search each
          event ID among the MAU meter events in Stripe, then choose an action.
        </Trans>
      </p>
      <DataTable
        columns={columns}
        data={rows}
        getRowId={(row) => `${row.tenantId}:${row.period}`}
        narrowMode="scroll"
      />
      {pending ? (
        <ResolveDialog
          pending={pending}
          isLoading={resolve.isPending}
          error={resolve.error ? errorMessage(resolve.error, { surface: 'general' }) : undefined}
          onConfirm={confirm}
          onCancel={() => setPending(null)}
        />
      ) : null}
    </ConsolePageSection>
  )
}
