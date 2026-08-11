// 隐私:异步导出 + 可取消 30 天 erasure;UI 两步确认且 API 独立要求 confirmation=DELETE。

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Alert, Button, EmptyState, Section, SectionRow, Skeleton } from '../../components/ui'
import { tokens } from '../../styles/tokens.stylex'
import { ConfirmDialog } from './ConfirmDialog'
import type { PrivacyRequest } from './hooks'
import {
  useCancelPrivacyRequest,
  useCreatePrivacyRequest,
  usePrivacyRequestsQuery,
} from './queries'

const GUTTER = 'clamp(1rem, 2.5vw, 4rem)'
const SECTION_PAD = 'clamp(1.5rem, 1.6vw, 2.5rem)'
const CROSS_GAP = 'clamp(1.75rem, 2vw, 3.5rem)'

const styles = stylex.create({
  zone: {
    paddingInline: GUTTER,
    paddingBlock: SECTION_PAD,
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: {
      default: '1fr',
      '@media (min-width: 56rem)': 'minmax(0, 5fr) minmax(0, 7fr)',
    },
    gap: {
      default: '1.25rem',
      '@media (min-width: 56rem)': `0 ${CROSS_GAP}`,
    },
    alignItems: 'start',
  },
  intro: {
    minWidth: 0,
  },
  title: {
    margin: 0,
    fontSize: '0.9375rem',
    fontWeight: 600,
    lineHeight: 1.3,
    color: tokens['--xid-fg'],
  },
  description: {
    margin: '0.375rem 0 0',
    fontSize: '0.8125rem',
    lineHeight: 1.55,
    color: tokens['--xid-muted-foreground'],
    textWrap: 'pretty',
  },
  content: {
    minWidth: 0,
    maxWidth: '36rem',
    borderInlineStartWidth: {
      default: '0',
      '@media (min-width: 56rem)': '1px',
    },
    borderInlineStartStyle: 'solid',
    borderInlineStartColor: tokens['--xid-border'],
    paddingInlineStart: {
      default: '0',
      '@media (min-width: 56rem)': CROSS_GAP,
    },
  },
  messages: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
    marginBottom: '1rem',
  },
  requestList: {
    margin: 0,
    padding: 0,
    listStyle: 'none',
  },
  requestTitle: {
    margin: 0,
    fontSize: '0.875rem',
    fontWeight: 560,
    lineHeight: 1.4,
    color: tokens['--xid-fg'],
  },
  requestMeta: {
    margin: '0.1875rem 0 0',
    fontSize: '0.75rem',
    lineHeight: 1.45,
    color: tokens['--xid-muted-foreground'],
    fontVariantNumeric: 'tabular-nums',
  },
  status: {
    margin: 0,
    fontSize: '0.8125rem',
    lineHeight: 1.45,
    color: tokens['--xid-muted-foreground'],
  },
  rowActions: {
    display: 'flex',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    gap: '0.5rem',
  },
})

function requestTypeLabel(type: PrivacyRequest['type']): ReactNode {
  return type === 'export' ? <Trans>Data export</Trans> : <Trans>Account deletion</Trans>
}

function requestStatusLabel(status: PrivacyRequest['status']): ReactNode {
  switch (status) {
    case 'pending':
      return <Trans>Pending</Trans>
    case 'processing':
      return <Trans>Processing</Trans>
    case 'completed':
      return <Trans>Completed</Trans>
    case 'canceled':
      return <Trans>Canceled</Trans>
    case 'expired':
      return <Trans>Expired</Trans>
  }
}

function formattedDate(value: string | null): string | null {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString()
}

export function PrivacySection(): ReactNode {
  const { t } = useLingui()
  const { data, isPending, error } = usePrivacyRequestsQuery()
  const createRequest = useCreatePrivacyRequest()
  const cancelRequest = useCancelPrivacyRequest()
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [cancelingId, setCancelingId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const requests = data ?? []
  const activeExport = requests.some(
    (request) =>
      request.type === 'export' &&
      (request.status === 'pending' || request.status === 'processing'),
  )
  const activeDeletion = requests.some(
    (request) =>
      request.type === 'delete' &&
      (request.status === 'pending' || request.status === 'processing'),
  )

  const createExport = async (): Promise<void> => {
    setActionError(null)
    setSuccess(null)
    try {
      await createRequest.mutateAsync({ type: 'export' })
      setSuccess(t`Your data export is being prepared.`)
    } catch (caught) {
      const xidError = caught as { message?: string; longMessage?: string }
      setActionError(
        xidError.longMessage || xidError.message || t`Failed to request a data export.`,
      )
    }
  }

  const scheduleDeletion = async (): Promise<void> => {
    setActionError(null)
    setSuccess(null)
    try {
      await createRequest.mutateAsync({ type: 'delete', confirmation: 'DELETE' })
      setShowDeleteConfirm(false)
      setSuccess(t`Account deletion is scheduled in 30 days.`)
    } catch (caught) {
      const xidError = caught as { message?: string; longMessage?: string }
      setActionError(
        xidError.longMessage || xidError.message || t`Failed to schedule account deletion.`,
      )
      setShowDeleteConfirm(false)
    }
  }

  const cancel = async (requestId: string): Promise<void> => {
    setActionError(null)
    setSuccess(null)
    setCancelingId(requestId)
    try {
      await cancelRequest.mutateAsync(requestId)
      setSuccess(t`Privacy request canceled.`)
    } catch (caught) {
      const xidError = caught as { message?: string; longMessage?: string }
      setActionError(xidError.longMessage || xidError.message || t`Failed to cancel the request.`)
    } finally {
      setCancelingId(null)
    }
  }

  return (
    <div {...stylex.props(styles.zone)}>
      <div {...stylex.props(styles.grid)}>
        <div {...stylex.props(styles.intro)}>
          <p {...stylex.props(styles.title)}>
            <Trans>Data and privacy</Trans>
          </p>
          <p {...stylex.props(styles.description)}>
            <Trans>
              Download a copy of your account data or schedule permanent deletion. Exports expire
              after 48 hours, and deletion has a 30-day cancellation window.
            </Trans>
          </p>
        </div>

        <div {...stylex.props(styles.content)}>
          {error || actionError || success ? (
            <div {...stylex.props(styles.messages)} aria-live="polite">
              {error ? (
                <Alert tone="error" title={<Trans>Failed to load privacy requests</Trans>}>
                  {error.longMessage || error.message || t`Failed to load privacy requests`}
                </Alert>
              ) : null}
              {actionError ? <Alert tone="error">{actionError}</Alert> : null}
              {success ? <Alert tone="success">{success}</Alert> : null}
            </div>
          ) : null}

          <Section label={<Trans>Privacy controls</Trans>}>
            <SectionRow
              label={<Trans>Export account data</Trans>}
              hint={
                <Trans>Creates a private JSON download that remains available for 48 hours.</Trans>
              }
              action={
                <Button
                  type="button"
                  variant="secondary"
                  isLoading={createRequest.isPending && createRequest.variables?.type === 'export'}
                  disabled={activeExport}
                  onClick={() => void createExport()}
                >
                  {activeExport ? <Trans>Preparing</Trans> : <Trans>Request export</Trans>}
                </Button>
              }
            />
            <SectionRow
              label={<Trans>Delete account</Trans>}
              hint={
                <Trans>
                  Schedules permanent erasure after 30 days. You can cancel while the request is
                  pending.
                </Trans>
              }
              action={
                <Button
                  type="button"
                  variant="danger"
                  disabled={activeDeletion}
                  onClick={() => setShowDeleteConfirm(true)}
                >
                  {activeDeletion ? <Trans>Scheduled</Trans> : <Trans>Schedule deletion</Trans>}
                </Button>
              }
            />
          </Section>

          <Section label={<Trans>Recent requests</Trans>}>
            {isPending ? (
              <div aria-busy="true">
                {[0, 1].map((index) => (
                  <SectionRow
                    key={index}
                    variant="split"
                    label={<Skeleton width="10rem" height="0.875rem" />}
                  >
                    <Skeleton width="7rem" height="0.75rem" />
                  </SectionRow>
                ))}
              </div>
            ) : requests.length === 0 && !error ? (
              <EmptyState
                title={<Trans>No privacy requests</Trans>}
                description={<Trans>Your export and deletion requests will appear here.</Trans>}
              />
            ) : (
              <ul {...stylex.props(styles.requestList)}>
                {requests.map((request) => {
                  const requestedAt = formattedDate(request.createdAt)
                  const scheduledFor = formattedDate(request.scheduledFor)
                  const expiresAt = formattedDate(request.expiresAt)
                  const cancelable = request.status === 'pending'
                  return (
                    <li key={request.id}>
                      <SectionRow
                        variant="split"
                        label={
                          <>
                            <p {...stylex.props(styles.requestTitle)}>
                              {requestTypeLabel(request.type)}
                            </p>
                            {requestedAt ? (
                              <p {...stylex.props(styles.requestMeta)}>
                                <Trans>Requested {requestedAt}</Trans>
                              </p>
                            ) : null}
                          </>
                        }
                        action={
                          request.downloadUrl || cancelable ? (
                            <div {...stylex.props(styles.rowActions)}>
                              {request.downloadUrl ? (
                                <Button
                                  type="button"
                                  variant="secondary"
                                  onClick={() => window.location.assign(request.downloadUrl ?? '')}
                                >
                                  <Trans>Download</Trans>
                                </Button>
                              ) : null}
                              {cancelable ? (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  isLoading={cancelingId === request.id}
                                  onClick={() => void cancel(request.id)}
                                >
                                  <Trans>Cancel</Trans>
                                </Button>
                              ) : null}
                            </div>
                          ) : undefined
                        }
                      >
                        <p {...stylex.props(styles.status)}>{requestStatusLabel(request.status)}</p>
                        {request.type === 'delete' && scheduledFor ? (
                          <p {...stylex.props(styles.requestMeta)}>
                            <Trans>Scheduled for {scheduledFor}</Trans>
                          </p>
                        ) : null}
                        {request.downloadUrl && expiresAt ? (
                          <p {...stylex.props(styles.requestMeta)}>
                            <Trans>Download expires {expiresAt}</Trans>
                          </p>
                        ) : null}
                      </SectionRow>
                    </li>
                  )
                })}
              </ul>
            )}
          </Section>
        </div>
      </div>

      {showDeleteConfirm ? (
        <ConfirmDialog
          title={<Trans>Schedule account deletion?</Trans>}
          description={
            <Trans>
              Your account remains available for 30 days. After that, credentials and personal data
              are permanently erased while required audit history is retained.
            </Trans>
          }
          confirmLabel={<Trans>Schedule deletion</Trans>}
          isLoading={createRequest.isPending && createRequest.variables?.type === 'delete'}
          onConfirm={() => void scheduleDeletion()}
          onCancel={() => setShowDeleteConfirm(false)}
        />
      ) : null}
    </div>
  )
}
