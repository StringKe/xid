import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import type { LegacyColumnDef as ColumnDef } from '@tanstack/react-table/legacy'
import { Alert, Badge, Button, Field, Input } from '@xid-kit/web-ui/ui'
import {
  ConsolePage,
  ConsolePageNotice,
  ConsolePageSection,
  ConsolePageSplitSection,
} from '@xid-kit/web-ui/ui'
import { DataTable } from '@xid-kit/web-ui/ui/DataTable'
import { Pagination } from '@xid-kit/web-ui/ui/Pagination'
import { organizationDisplayName } from '@xid-kit/web-ui/display-names'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { useAuditChainVerificationQuery, useGlobalAuditEventsQuery } from './queries'
import type { AuditEvent } from './types'

const styles = stylex.create({
  verifyForm: {
    display: 'grid',
    gridTemplateColumns: 'minmax(12rem, 2fr) minmax(7rem, 1fr) minmax(7rem, 1fr) auto',
    alignItems: 'end',
    gap: '0.75rem',
    '@media (max-width: 48rem)': {
      gridTemplateColumns: '1fr',
    },
  },
  verifyResult: {
    marginTop: '1rem',
  },
  verifySummary: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '0.75rem',
  },
  verifyStat: {
    fontFamily: tokens['--xid-font-mono'],
    fontSize: '0.8125rem',
    fontVariantNumeric: 'tabular-nums',
  },
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

const columns: ColumnDef<AuditEvent>[] = [
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
        {new Date(row.original.occurredAt).toLocaleString()}
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
  const { t } = useLingui()
  const [cursor, setCursor] = useState<string | undefined>()
  const [tenantId, setTenantId] = useState('')
  const [fromSeq, setFromSeq] = useState('')
  const [toSeq, setToSeq] = useState('')
  const [verification, setVerification] = useState<{
    tenantId: string
    fromSeq?: number
    toSeq?: number
  } | null>(null)
  const { data, isLoading, isError } = useGlobalAuditEventsQuery(cursor)
  const verificationQuery = useAuditChainVerificationQuery(verification)

  const onVerify = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const normalizedTenantId = tenantId.trim()
    if (!normalizedTenantId) return
    setVerification({
      tenantId: normalizedTenantId,
      ...(fromSeq ? { fromSeq: Number(fromSeq) } : {}),
      ...(toSeq ? { toSeq: Number(toSeq) } : {}),
    })
  }

  return (
    <ConsolePage
      title={<Trans>Global event stream</Trans>}
      lead={
        <Trans>
          Audit events from every organization on this instance, with per-tenant hash-chain
          verification.
        </Trans>
      }
    >
      {isError || verificationQuery.isError ? (
        <ConsolePageNotice>
          {isError ? (
            <Alert tone="error">
              <Trans>Failed to load audit events. Please try again.</Trans>
            </Alert>
          ) : null}
          {verificationQuery.isError ? (
            <Alert tone="error">
              <Trans>Failed to verify the audit chain. Please try again.</Trans>
            </Alert>
          ) : null}
        </ConsolePageNotice>
      ) : null}

      <ConsolePageSplitSection
        title={<Trans>Verify audit chain</Trans>}
        description={
          <Trans>Recompute the hash chain for one tenant over an optional sequence range.</Trans>
        }
      >
        <form
          aria-label={t`Verify audit chain`}
          {...stylex.props(styles.verifyForm)}
          onSubmit={onVerify}
        >
          <Field label={t`Tenant ID`} required>
            <Input
              value={tenantId}
              onChange={(event) => setTenantId(event.target.value)}
              autoComplete="off"
            />
          </Field>
          <Field label={t`From`}>
            <Input
              type="number"
              min={1}
              step={1}
              value={fromSeq}
              onChange={(event) => setFromSeq(event.target.value)}
            />
          </Field>
          <Field label={t`To`}>
            <Input
              type="number"
              min={1}
              step={1}
              value={toSeq}
              onChange={(event) => setToSeq(event.target.value)}
            />
          </Field>
          <Button type="submit" disabled={!tenantId.trim() || verificationQuery.isLoading}>
            <Trans>Verify</Trans>
          </Button>
        </form>
        {verificationQuery.data ? (
          <div {...stylex.props(styles.verifyResult)}>
            <Alert tone={verificationQuery.data.chain_valid ? 'success' : 'error'}>
              <div {...stylex.props(styles.verifySummary)}>
                <Badge tone={verificationQuery.data.chain_valid ? 'success' : 'danger'}>
                  {verificationQuery.data.chain_valid ? (
                    <Trans>Chain valid</Trans>
                  ) : (
                    <Trans>Chain broken</Trans>
                  )}
                </Badge>
                <span {...stylex.props(styles.verifyStat)}>
                  <Trans>Records checked</Trans>: {verificationQuery.data.record_count}
                </span>
                {verificationQuery.data.broken_at_seq != null ? (
                  <span {...stylex.props(styles.verifyStat)}>
                    <Trans>Broken at seq</Trans>: {verificationQuery.data.broken_at_seq}
                  </span>
                ) : null}
              </div>
            </Alert>
          </div>
        ) : null}
      </ConsolePageSplitSection>

      <ConsolePageSection title={<Trans>Event stream</Trans>}>
        <DataTable
          columns={columns}
          data={data?.data ?? []}
          getRowId={(row) => row.id}
          isLoading={isLoading}
          emptyMessage={<Trans>No audit events found.</Trans>}
        />
        {data ? (
          <Pagination
            nextCursor={data.nextCursor}
            loadMoreLabel={<Trans>Load more events</Trans>}
            onLoadMore={setCursor}
          />
        ) : null}
      </ConsolePageSection>
    </ConsolePage>
  )
}
